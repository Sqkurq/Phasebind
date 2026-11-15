// Phasebind - After Effects ExtendScript side.
// Every PL_* function returns a JSON string: {"ok":true,...} or
// {"ok":false,"code":"...","error":"..."}. The panel localizes by code, so
// nothing here depends on (or produces) UI-language text.

var PL_TAG = "Phasebind:";
var PL_FOLDER = "Phasebind";
var PL_WAV_TEMPLATE = "Phasebind WAV";
var PL_VIDEO_TEMPLATE = "Phasebind H.264";
var PL_POINT_SEC = 0.5; // clip length the Live device uses for markers without a duration (POINT_SEC)

// ---------------------------------------------------------------- JSON (ExtendScript has none)

function PL_json(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") {
    return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
  }
  if (v instanceof Array) {
    var a = [];
    for (var i = 0; i < v.length; i++) a.push(PL_json(v[i]));
    return "[" + a.join(",") + "]";
  }
  var parts = [];
  for (var k in v) {
    if (v.hasOwnProperty(k)) parts.push(PL_json(k) + ":" + PL_json(v[k]));
  }
  return "{" + parts.join(",") + "}";
}

function PL_ok(obj) { obj = obj || {}; obj.ok = true; return PL_json(obj); }
function PL_err(e) {
  return PL_json({ ok: false, code: (e && e.plCode) || "host", error: String(e && e.message ? e.message : e) });
}

function PL_fail(code) {
  var e = new Error(code);
  e.plCode = code;
  return e;
}

// ---------------------------------------------------------------- helpers

function PL_activeComp() {
  var c = app.project.activeItem;
  if (!(c && c instanceof CompItem)) throw PL_fail("noComp");
  return c;
}

function PL_linkIdOf(layer) {
  // Layers tagged before the rename still carry "PhaseLink:".
  var m = /(?:Phasebind|PhaseLink):([a-z0-9]+)/.exec(layer.comment || "");
  return m ? m[1] : null;
}

function PL_setLinkId(layer, linkId) {
  var c = (layer.comment || "").replace(/\s*(?:Phasebind|PhaseLink):[a-z0-9]+/g, "");
  layer.comment = (c ? c + " " : "") + PL_TAG + linkId;
}

function PL_findLayerByLinkId(comp, linkId) {
  for (var i = 1; i <= comp.numLayers; i++) {
    if (PL_linkIdOf(comp.layer(i)) === linkId) return comp.layer(i);
  }
  return null;
}

function PL_folder() {
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof FolderItem && it.name === PL_FOLDER) return it;
  }
  return app.project.items.addFolder(PL_FOLDER);
}

// ---------------------------------------------------------------- save location

function PL_getProjectDir() {
  try {
    var f = app.project.file;
    return PL_ok({ saved: !!f, dir: f ? f.parent.fsName : null });
  } catch (e) {
    return PL_err(e);
  }
}

// Folder picker; returns { path: null } when cancelled.
function PL_chooseFolder(prompt) {
  try {
    var folder = Folder.selectDialog(prompt);
    return PL_ok({ path: folder ? folder.fsName : null });
  } catch (e) {
    return PL_err(e);
  }
}

// ---------------------------------------------------------------- selection

function PL_getSelection() {
  try {
    var comp = PL_activeComp();
    var out = [];
    var sel = comp.selectedLayers;
    for (var i = 0; i < sel.length; i++) {
      var L = sel[i];
      if (!L.hasAudio) continue;
      var info = {
        index: L.index,
        name: L.name,
        linkId: PL_linkIdOf(L),
        startTime: L.startTime,
        inPoint: L.inPoint,
        outPoint: L.outPoint,
        stretch: L.stretch,
        timeRemap: L.timeRemapEnabled,
        audioEnabled: L.audioEnabled,
        sourcePath: null,
        isPrecomp: false
      };
      var src = L.source;
      if (src instanceof CompItem) {
        info.isPrecomp = true;
      } else if (src && src.mainSource && src.mainSource.file) {
        info.sourcePath = src.mainSource.file.fsName;
      }
      out.push(info);
    }
    return PL_ok({ comp: { name: comp.name, duration: comp.duration, frameRate: comp.frameRate }, layers: out });
  } catch (e) {
    return PL_err(e);
  }
}

function PL_tagLayer(index, linkId) {
  try {
    PL_setLinkId(PL_activeComp().layer(index), linkId);
    return PL_ok();
  } catch (e) {
    return PL_err(e);
  }
}

// ---------------------------------------------------------------- render one layer's audio (faithful mode)

function PL_renderLayerAudio(index, outPath) {
  var comp, restore = [];
  try {
    comp = PL_activeComp();
    var target = comp.layer(index);
    var start = Math.max(0, target.inPoint);
    var end = Math.min(comp.duration, target.outPoint);
    if (end <= start) throw PL_fail("outsideComp");

    // Only the target layer may be audible; solo would mute it otherwise.
    // Ae refuses to write solo (even false) on a layer with video and audio
    // both off, e.g. an audio-only layer once muted here: touch solo only
    // when it is on, and before audio is switched off.
    for (var i = 1; i <= comp.numLayers; i++) {
      var L = comp.layer(i);
      if (L.hasAudio) {
        restore.push({ layer: L, audio: L.audioEnabled, solo: L.solo });
        if (L.solo) L.solo = false;
        L.audioEnabled = (i === index);
      }
    }

    var rq = app.project.renderQueue;
    var queued = [];
    for (var q = 1; q <= rq.numItems; q++) {
      var it = rq.item(q);
      if (it.status === RQItemStatus.QUEUED) { queued.push(it); it.render = false; }
    }

    var item = rq.items.add(comp);
    item.timeSpanStart = start;
    item.timeSpanDuration = end - start;
    var om = item.outputModule(1);
    var format = PL_configureAudio(om);
    // AIFF renders are converted to WAV by the panel.
    om.file = new File(format === "aiff" ? outPath.replace(/\.wav$/i, "") + ".aif" : outPath);
    var actualPath = om.file.fsName;

    rq.render();
    item.remove();
    for (var k = 0; k < queued.length; k++) queued[k].render = true;

    PL_restoreLayers(restore);
    var out = new File(actualPath);
    if (!out.exists || out.length <= 44) throw PL_fail("renderFailed");
    return PL_ok({ path: actualPath, format: format, startSec: start, durationSec: end - start });
  } catch (e) {
    PL_restoreLayers(restore);
    return PL_err(e);
  }
}

// ---------------------------------------------------------------- render the comp as video (work area)

function PL_renderCompVideo(outPath) {
  var queued = [];
  try {
    var comp = PL_activeComp();
    var start = Math.max(0, comp.workAreaStart);
    var end = Math.min(comp.duration, comp.workAreaStart + comp.workAreaDuration);
    if (end <= start) throw PL_fail("outsideComp");

    var rq = app.project.renderQueue;
    for (var q = 1; q <= rq.numItems; q++) {
      var it = rq.item(q);
      if (it.status === RQItemStatus.QUEUED) { queued.push(it); it.render = false; }
    }

    var item = rq.items.add(comp);
    item.timeSpanStart = start;
    item.timeSpanDuration = end - start;
    var om = item.outputModule(1);
    PL_configureVideo(om);
    om.file = new File(outPath);
    var actualPath = om.file.fsName;

    rq.render();
    item.remove();
    PL_requeue(queued);

    var out = new File(actualPath);
    if (!out.exists || out.length === 0) throw PL_fail("renderFailed");
    return PL_ok({ path: actualPath, startSec: start, durationSec: end - start, name: comp.name });
  } catch (e) {
    PL_requeue(queued);
    return PL_err(e);
  }
}

function PL_requeue(list) {
  for (var i = 0; i < list.length; i++) {
    try { list[i].render = true; } catch (e) {}
  }
}

// H.264 (.mp4) is what Live decodes on every platform. Order as for audio:
// our saved template, Ae's bundled H.264 templates, then setSettings.
function PL_configureVideo(om) {
  var h264 = /h\.?264/i;
  try { om.applyTemplate(PL_VIDEO_TEMPLATE); } catch (e) {}
  if (PL_isFormat(om, h264)) return;

  var templates = [];
  try { templates = om.templates; } catch (e) {}
  for (var i = 0; i < templates.length; i++) {
    if (!h264.test(templates[i])) continue;
    try { om.applyTemplate(templates[i]); } catch (e) { continue; }
    if (PL_isFormat(om, h264)) return;
  }

  try { om.setSettings({ "Format": "H.264" }); } catch (e) {}
  if (PL_isFormat(om, h264)) {
    try { om.saveAsTemplate(PL_VIDEO_TEMPLATE); } catch (e) {}
    return;
  }
  throw PL_fail("videoOutput");
}

function PL_restoreLayers(list) {
  for (var i = 0; i < list.length; i++) {
    try {
      list[i].layer.audioEnabled = list[i].audio;
      if (list[i].layer.solo !== list[i].solo) list[i].layer.solo = list[i].solo;
    } catch (e) {}
  }
}

// Sets the output module to an audio-only format and returns "wav" or "aiff".
// No preset is required from the user:
//   1. our own "Phasebind WAV" template, if an earlier run saved it;
//   2. WAV via setSettings (keys may be localized; the value "WAV" is not);
//   3. Ae's bundled AIFF template (its name contains "AIFF" in every language),
//      then WAV again from there. Whenever WAV works it is saved as
//      "Phasebind WAV" so later renders take step 1.
function PL_configureAudio(om) {
  try { om.applyTemplate(PL_WAV_TEMPLATE); } catch (e) {}
  if (PL_isFormat(om, /^wav$/i)) return "wav";

  if (PL_trySetWav(om)) return PL_saveWavTemplate(om);

  var templates = [];
  try { templates = om.templates; } catch (e) {}
  var aiff = null;
  for (var i = 0; i < templates.length; i++) {
    if (!/aiff/i.test(templates[i])) continue;
    if (!aiff || /48/.test(templates[i])) aiff = templates[i];
  }
  if (aiff) {
    try { om.applyTemplate(aiff); } catch (e) { aiff = null; }
  }
  if (aiff) {
    if (PL_trySetWav(om)) return PL_saveWavTemplate(om);
    om.applyTemplate(aiff); // a failed WAV attempt may have left other settings changed
    return "aiff";
  }
  throw PL_fail("wavOutput");
}

function PL_trySetWav(om) {
  try { om.setSettings({ "Format": "WAV" }); } catch (e) {}
  if (PL_isFormat(om, /^wav$/i)) return true;

  var settings = {};
  try { settings = om.getSettings(GetSettingsFormat.STRING); } catch (e) {}
  for (var key in settings) {
    if (!settings.hasOwnProperty(key) || typeof settings[key] !== "string") continue;
    var change = {};
    change[key] = "WAV";
    try { om.setSettings(change); } catch (e) { continue; }
    if (PL_isFormat(om, /^wav$/i)) return true;
  }
  return false;
}

function PL_saveWavTemplate(om) {
  try { om.saveAsTemplate(PL_WAV_TEMPLATE); } catch (e) {}
  return "wav";
}

function PL_isFormat(om, pattern) {
  try {
    var s = om.getSettings(GetSettingsFormat.STRING);
    for (var key in s) {
      if (s.hasOwnProperty(key) && pattern.test(String(s[key]))) return true;
    }
  } catch (e) {}
  return false;
}

// ---------------------------------------------------------------- comp markers <-> Live locators

// Comp time 0 is Live's arrangement time 0, as for audio.
function PL_getCompMarkers() {
  try {
    var comp = PL_activeComp();
    var mp = comp.markerProperty, out = [];
    for (var i = 1; i <= mp.numKeys; i++) {
      var t = mp.keyTime(i);
      if (t < 0) continue;
      var mv = mp.keyValue(i);
      out.push({ timeSec: t, durationSec: mv.duration, name: mv.comment || "" });
    }
    return PL_ok({ markers: out });
  } catch (e) {
    return PL_err(e);
  }
}

// Adds a comp marker per Live locator / marker clip. A marker already on the
// same frame keeps its other settings and only takes the name. Nothing is
// deleted. Clips up to PL_POINT_SEC (shorter when the next marker is close)
// stand for markers without a duration.
function PL_setCompMarkers(markers) {
  app.beginUndoGroup("Phasebind");
  try {
    var comp = PL_activeComp();
    var mp = comp.markerProperty, fd = comp.frameDuration;
    var created = 0, renamed = 0, unchanged = 0, skipped = 0;
    for (var i = 0; i < markers.length; i++) {
      var t = Math.round(markers[i].timeSec / fd) * fd;
      if (t < 0 || t > comp.duration) { skipped++; continue; }
      var key = mp.numKeys ? mp.nearestKeyIndex(t) : 0;
      if (key && Math.abs(mp.keyTime(key) - t) < fd / 2) {
        var old = mp.keyValue(key);
        if (old.comment === markers[i].name) { unchanged++; continue; }
        var mv = PL_copyMarker(old);
        mv.comment = markers[i].name;
        mp.setValueAtKey(key, mv);
        renamed++;
      } else {
        var nv = new MarkerValue(markers[i].name);
        var d = markers[i].durationSec || 0;
        if (markers[i].clip && d > PL_POINT_SEC + 0.001) nv.duration = Math.round(d / fd) * fd;
        mp.setValueAtTime(t, nv);
        created++;
      }
    }
    app.endUndoGroup();
    return PL_ok({ created: created, renamed: renamed, unchanged: unchanged, skipped: skipped });
  } catch (e) {
    app.endUndoGroup();
    return PL_err(e);
  }
}

function PL_copyMarker(src) {
  var mv = new MarkerValue(src.comment, src.chapter, src.url, src.frameTarget, src.cuePointName);
  mv.duration = src.duration;
  mv.eventCuePoint = src.eventCuePoint;
  try { mv.label = src.label; } catch (e) {}
  try { mv.protectedRegion = src.protectedRegion; } catch (e) {}
  try { mv.setParameters(src.getParameters()); } catch (e) {}
  return mv;
}

// ---------------------------------------------------------------- import from Live

// Replaces the source of the layer tagged with linkId, or adds a new layer.
// With muteSent, other Phasebind-tagged layers (sent to Live and therefore
// already part of the mix) have their audio switched off.
function PL_importAudio(path, startSec, name, linkId, muteSent) {
  app.beginUndoGroup("Phasebind");
  try {
    var comp = PL_activeComp();
    var footage = app.project.importFile(new ImportOptions(new File(path)));
    footage.parentFolder = PL_folder();
    footage.name = name + ".wav";

    var layer = linkId ? PL_findLayerByLinkId(comp, linkId) : null;
    var replaced = false;
    if (layer) {
      layer.replaceSource(footage, false);
      if (layer.timeRemapEnabled) layer.timeRemapEnabled = false;
      layer.stretch = 100;
      replaced = true;
    } else {
      layer = comp.layers.add(footage);
      layer.name = name;
    }
    layer.startTime = startSec;
    layer.inPoint = startSec;
    layer.outPoint = startSec + footage.duration;
    if (linkId) PL_setLinkId(layer, linkId);

    var muted = 0;
    if (muteSent) {
      for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        var id = PL_linkIdOf(L);
        if (id && id !== linkId && L.hasAudio && L.audioEnabled) {
          L.audioEnabled = false;
          muted++;
        }
      }
    }

    app.endUndoGroup();
    return PL_ok({ replaced: replaced, layerIndex: layer.index, duration: footage.duration, muted: muted });
  } catch (e) {
    app.endUndoGroup();
    return PL_err(e);
  }
}
