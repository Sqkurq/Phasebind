// Phasebind - Live Object Model side (Max [js], ES5).
//
// The device sits on the Master track and records the whole mix (post master
// devices, pre master fader).
//
// Inlet 0 : commands from node.script / UI ("init", "captureRequest <json>", "importClips <json>",
//           "importVideo <json>", "importMarkers <json>", "cues <json>", ...)
// Inlet 1 : peak level of the master signal (float, linear, every ~50 ms)
// Outlet 0: sfrecord~ control ("open <path>", 1, 0, "samptype float32")
// Outlet 1: messages to node.script ("fromjs <json>")
// Outlet 2: status text for the device UI ("set <text>")
// Outlet 3: Ae connection label ("set <text>", "textcolor r g b a")
//
// JSON payloads are passed URI-encoded so spaces/quotes survive Max messaging.

autowatch = 1;
inlets = 2;
outlets = 4;

var VERSION = "0.9.5";
var MIX_LINK_ID = "master";

var song = null;
var onMaster = false;
var baseDir = "";
var defaultOptions = {};

var level = 0;             // latest peak (linear)
var capture = null;        // running capture state
var captureTask = null;

// ------------------------------------------------------------------ helpers

function encode(obj) { return encodeURIComponent(JSON.stringify(obj)); }
function decode(s) { return JSON.parse(decodeURIComponent(String(s))); }

function toNode(obj) { outlet(1, "fromjs", encode(obj)); }

function status(text) {
  outlet(2, "set", text);
  post("Phasebind: " + text + "\n");
}

function num(api, prop) { return Number(api.get(prop)[0]); }

function str(api, prop) {
  var v = api.get(prop);
  return (v instanceof Array) ? v.join(" ") : String(v);
}

function idList(api, prop) {
  var raw = api.get(prop), ids = [];
  for (var i = 0; i < raw.length; i += 2) {
    if (raw[i] === "id" && Number(raw[i + 1]) !== 0) ids.push(Number(raw[i + 1]));
  }
  return ids;
}

function byId(id) { return new LiveAPI("id " + id); }

function nowMs() { return new Date().getTime(); }

// Calls fn(clip) for every arrangement clip on every regular track.
function forEachArrangementClip(fn) {
  var tracks = idList(song, "tracks");
  for (var t = 0; t < tracks.length; t++) {
    var clips = idList(byId(tracks[t]), "arrangement_clips");
    for (var i = 0; i < clips.length; i++) fn(byId(clips[i]));
  }
}

// ------------------------------------------------------------------ init

function init() {
  song = new LiveAPI("live_set");
  var parent = new LiveAPI("this_device canonical_parent");
  onMaster = parent.unquotedpath === "live_set master_track";

  outlet(0, "samptype", "float32");
  if (onMaster) status("Ready · v" + VERSION);
  else status("Put on Master");
  toNode({ event: "jsReady", version: VERSION });
}

function setdir(path) { baseDir = String(path); }

// Number of connected Ae panels, sent by the bridge. Green when connected,
// like the lamp in the Ae panel.
var AE_ON_COLOR = [0.204, 0.820, 0.478, 1];   // #34d17a
var AE_OFF_COLOR = [0.933, 0.933, 0.933, 0.58];
function aeconn(n) {
  outlet(3, "set", n > 0 ? "● Ae" : "○ Ae");
  outlet(3, ["textcolor"].concat(n > 0 ? AE_ON_COLOR : AE_OFF_COLOR));
}

function setdefaults(json) { defaultOptions = decode(json); }

// ------------------------------------------------------------------ level input

function msg_float(v) {
  if (inlet === 1) {
    level = v;
  }
}

// ------------------------------------------------------------------ capture (Live mix -> Ae)

function capture_device() {
  if (capture) return; // button may fire on both press and release
  startCapture(null, defaultOptions);
}

function captureRequest(json) {
  var req = decode(json);
  startCapture(req.id, req.options || {});
}

function startCapture(requestId, opts) {
  if (capture) {
    replyError(requestId, "busy");
    return;
  }
  if (!song) init();
  if (!onMaster) {
    replyError(requestId, "notOnMaster");
    return;
  }
  if (num(song, "is_playing") === 1) song.call("stop_playing");

  var o = {
    range: opts.range || "auto",                 // "auto" (loop if Live's loop is on) | "clips" | "loop"
    prerollBeats: opts.prerollBeats != null ? opts.prerollBeats : 2,
    tailThresholdDb: opts.tailThresholdDb != null ? opts.tailThresholdDb : -60,
    tailHoldMs: opts.tailHoldMs != null ? opts.tailHoldMs : 1500,
    maxTailSec: opts.maxTailSec != null ? opts.maxTailSec : 15,
    rawPath: opts.rawPath || (baseDir + "/pl_raw_" + nowMs() + ".wav")
  };

  var state = {
    requestId: requestId,
    options: o,
    tempo: num(song, "tempo"),
    restore: [],
    phase: "body"
  };

  try {
    // Read before prepareSet switches the loop off.
    var useLoop = o.range === "loop" || (o.range === "auto" && num(song, "loop") === 1);
    var range = resolveRange(useLoop ? "loop" : "clips");
    state.rangeStart = range.start;
    state.rangeEnd = range.end;
    // With a loop range, clips may continue past the range end. Stopping the
    // transport there ends the clips while devices (reverb, delay) ring out.
    state.stopAtEnd = useLoop;
    state.playStart = Math.max(0, range.start - o.prerollBeats);
    prepareSet(state);
  } catch (e) {
    restoreSet(state);
    replyError(requestId, e.plCode || "liveError", String(e.message || e));
    return;
  }

  capture = state;
  status("Recording");

  outlet(0, "open", o.rawPath);
  outlet(0, 1);
  state.recStartMs = nowMs();
  song.call("start_playing");
  state.playStartMs = nowMs();

  captureTask = new Task(tick, this);
  captureTask.interval = 10;
  captureTask.repeat();
}

function resolveRange(mode) {
  if (mode === "loop") {
    var ls = num(song, "loop_start");
    return { start: ls, end: ls + num(song, "loop_length") };
  }
  var start = Infinity, end = -Infinity;
  forEachArrangementClip(function (c) {
    if (num(c, "muted") === 1) return;
    start = Math.min(start, num(c, "start_time"));
    end = Math.max(end, num(c, "end_time"));
  });
  if (start === Infinity) throw fail("noClips");
  return { start: start, end: end };
}

function prepareSet(state) {
  var r = state.restore;

  // Never loop during capture, otherwise the tail would wrap around.
  var loop = num(song, "loop");
  r.push(function () { song.set("loop", loop); });
  song.set("loop", 0);

  // start_playing begins at the insert marker (start_time), not at
  // current_song_time, so move the marker and put it back afterwards.
  var startTime = num(song, "start_time");
  var songTime = num(song, "current_song_time");
  r.push(function () { song.set("start_time", startTime); });
  r.push(function () { song.set("current_song_time", songTime); });

  song.set("back_to_arranger", 0);

  // Mute clips that lie completely outside the range so nothing bleeds into
  // the pre-roll or the tail.
  forEachArrangementClip(function (c) {
    if (num(c, "muted") === 1) return;
    var cs = num(c, "start_time"), ce = num(c, "end_time");
    if (ce <= state.rangeStart || cs >= state.rangeEnd) {
      r.push(function () { c.set("muted", 0); });
      c.set("muted", 1);
    }
  });

  song.set("start_time", state.playStart);
  song.set("current_song_time", state.playStart);
}

function restoreSet(state) {
  restoreSteps(state.restore);
  state.restore = [];
}

function tick() {
  var s = capture;
  if (!s) return;
  var now = nowMs();

  if (s.phase === "body") {
    var playing = num(song, "is_playing") === 1;
    // start_playing is applied asynchronously; wait until Live reports it.
    if (!s.startedMs) {
      if (playing) s.startedMs = now;
      else if (now - s.playStartMs > 3000) finishCapture("noStart");
      return;
    }
    if (!playing) {
      finishCapture("stopped");
      return;
    }
    var pos = num(song, "current_song_time");
    var readMs = nowMs();
    // One (position, time) pair lets the bridge work out the beat at which
    // playback really started; the phasor marker then makes it sample-exact.
    if (s.posReadBeat == null && (readMs - s.startedMs > 100 || pos >= s.rangeEnd)) {
      s.posReadBeat = pos;
      s.posReadMs = readMs;
    }
    if (pos >= s.rangeEnd) {
      if (s.stopAtEnd) song.call("stop_playing");
      s.phase = "tail";
      s.tailStartMs = now;
      s.lastLoudMs = now;
      status("Tail");
    }
    return;
  }

  // Tail phase: keep recording until reverb/delay decays or the cap is reached.
  var threshold = Math.pow(10, s.options.tailThresholdDb / 20);
  if (level > threshold) s.lastLoudMs = now;
  if (now - s.lastLoudMs >= s.options.tailHoldMs) {
    finishCapture(null);
  } else if (now - s.tailStartMs >= s.options.maxTailSec * 1000) {
    s.tailCapped = true;
    finishCapture(null);
  }
}

function finishCapture(error) {
  var s = capture;
  if (captureTask) { captureTask.cancel(); captureTask = null; }
  outlet(0, 0);
  if (num(song, "is_playing") === 1) song.call("stop_playing");
  restoreSet(s);
  capture = null;

  if (error) {
    status("Failed");
    replyError(s.requestId, error);
    return;
  }
  status("Done");
  toNode({
    id: s.requestId,
    type: "captured",
    ok: true,
    result: {
      rawPath: s.options.rawPath,
      trackName: "Live Mix",
      linkId: MIX_LINK_ID,
      tempo: s.tempo,
      playStartBeat: s.playStart,
      rangeStartBeat: s.rangeStart,
      rangeEndBeat: s.rangeEnd,
      posReadBeat: s.posReadBeat,
      posReadOffsetMs: s.posReadMs - s.recStartMs,
      fallbackOffsetMs: (s.startedMs || s.playStartMs) - s.recStartMs,
      tailCapped: !!s.tailCapped
    }
  });
}

// ------------------------------------------------------------------ import (Ae -> Live)

function importClips(json) {
  var req = decode(json);
  try {
    if (!song) init();
    var tempo = num(song, "tempo");
    var created = [];
    for (var i = 0; i < req.files.length; i++) {
      var f = req.files[i];
      var beats = f.positionSec * tempo / 60;
      song.call("create_audio_track", -1);
      var tracks = idList(song, "tracks");
      var track = byId(tracks[tracks.length - 1]);
      track.set("name", "PB " + f.name);
      track.call("create_audio_clip", f.path, beats);

      var clips = idList(track, "arrangement_clips");
      if (clips.length) {
        var clip = byId(clips[clips.length - 1]);
        // Keep the audio at its original speed regardless of Auto-Warp settings.
        clip.set("warping", 0);
        clip.set("name", f.name);
      }
      created.push({ name: f.name, positionBeats: beats });
    }
    status("Imported " + created.length);
    toNode({ id: req.id, ok: true, result: { created: created, tempo: tempo } });
  } catch (e) {
    replyError(req.id, "importFailed", String(e.message || e));
  }
}

// Rendered comp video -> a new track. Live only shows video for arrangement
// clips. The track starts muted because the layers' audio usually reaches Live
// separately; unmute it to hear the comp mix instead.
function importVideo(json) {
  var req = decode(json);
  try {
    if (!song) init();
    var tempo = num(song, "tempo");
    var beats = req.positionSec * tempo / 60;
    song.call("create_audio_track", -1);
    var tracks = idList(song, "tracks");
    var track = byId(tracks[tracks.length - 1]);
    track.set("name", "PB Video " + req.name);
    track.call("create_audio_clip", req.path, beats);

    var clips = idList(track, "arrangement_clips");
    if (!clips.length) throw fail("videoImportFailed");
    var clip = byId(clips[clips.length - 1]);
    clip.set("warping", 0);
    clip.set("name", req.name);
    track.set("mute", 1);

    status("Video");
    toNode({ id: req.id, ok: true, result: { positionBeats: beats, tempo: tempo } });
  } catch (e) {
    replyError(req.id, e.plCode || "videoImportFailed", String(e.message || e));
  }
}

// ------------------------------------------------------------------ markers (Ae <-> Live)

// Ae comp markers become named empty MIDI clips on a "PB Markers" MIDI track.
// Locators can't be used: set_or_delete_cue rounds the position to the bar and
// the LOM cannot move a locator. Live -> Ae reads both locators and the clips
// of every "PB Markers" track (0.9.3 made it an audio track with silent clips).
var MARKER_TRACK = "PB Markers";
var POS_EPS = 1e-3;   // beats; two clips/locators closer than this share a position
var POINT_SEC = 0.5;  // clip length for markers without a duration (read back as a point)
var MIN_CLIP_SEC = 0.05;

// midi: true / false to require that kind of track, undefined for any.
function findTracks(name, midi) {
  var tracks = idList(song, "tracks"), out = [];
  for (var i = 0; i < tracks.length; i++) {
    var t = byId(tracks[i]);
    if (str(t, "name") !== name) continue;
    if (midi !== undefined && (num(t, "has_midi_input") === 1) !== midi) continue;
    out.push(t);
  }
  return out;
}

function clipAt(track, beats) {
  var clips = idList(track, "arrangement_clips");
  for (var i = 0; i < clips.length; i++) {
    var c = byId(clips[i]);
    if (Math.abs(num(c, "start_time") - beats) < POS_EPS) return c;
  }
  return null;
}

// The clip length is the marker duration (POINT_SEC without one), cut short
// so no clip runs into the next marker. A clip already at the same position
// is renamed; nothing is deleted.
function importMarkers(json) {
  var req = decode(json);
  try {
    if (!song) init();
    var tempo = num(song, "tempo");
    var track = findTracks(MARKER_TRACK, true)[0];
    if (!track) {
      song.call("create_midi_track", -1);
      var tracks = idList(song, "tracks");
      track = byId(tracks[tracks.length - 1]);
      track.set("name", MARKER_TRACK);
    }
    var markers = req.markers.slice().sort(function (a, b) { return a.timeSec - b.timeSec; });
    var created = 0, renamed = 0, unchanged = 0;
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var name = m.name || "Marker";
      var beats = m.timeSec * tempo / 60;
      var clip = clipAt(track, beats);
      if (clip) {
        if (str(clip, "name") !== name) { clip.set("name", name); renamed++; }
        else unchanged++;
        continue;
      }
      var sec = m.durationSec > 0 ? m.durationSec : POINT_SEC;
      if (i + 1 < markers.length) sec = Math.min(sec, markers[i + 1].timeSec - m.timeSec);
      sec = Math.max(sec, MIN_CLIP_SEC);
      track.call("create_midi_clip", beats, sec * tempo / 60);
      clip = clipAt(track, beats);
      if (!clip) throw fail("markerFailed", "no clip at beat " + beats);
      clip.set("name", name);
      created++;
    }
    status("Markers " + (created + renamed));
    toNode({ id: req.id, ok: true, result: { created: created, renamed: renamed, unchanged: unchanged, tempo: tempo } });
  } catch (e) {
    replyError(req.id, e.plCode || "markerFailed", String(e.detail || e.message || e));
  }
}

// Live locators and "PB Markers" clips -> Ae (seconds, constant tempo).
function cues(json) {
  var req = decode(json);
  try {
    if (!song) init();
    var tempo = num(song, "tempo");
    var toSec = 60 / tempo, out = [];
    var ids = idList(song, "cue_points");
    for (var i = 0; i < ids.length; i++) {
      var c = byId(ids[i]);
      out.push({ name: str(c, "name"), timeSec: num(c, "time") * toSec, durationSec: 0 });
    }
    var tracks = findTracks(MARKER_TRACK);
    for (var t = 0; t < tracks.length; t++) {
      var clips = idList(tracks[t], "arrangement_clips");
      for (var j = 0; j < clips.length; j++) {
        var k = byId(clips[j]);
        var st = num(k, "start_time");
        out.push({ name: str(k, "name"), timeSec: st * toSec, durationSec: (num(k, "end_time") - st) * toSec, clip: true });
      }
    }
    out.sort(function (a, b) { return a.timeSec - b.timeSec; });
    toNode({ id: req.id, ok: true, result: { cues: out, tempo: tempo } });
  } catch (e) {
    replyError(req.id, "liveError", String(e.message || e));
  }
}

// Undo in reverse order; keep going even if one step fails.
function restoreSteps(list) {
  for (var i = list.length - 1; i >= 0; i--) {
    try { list[i](); } catch (e) { post("Phasebind restore error: " + e + "\n"); }
  }
}

function info(json) {
  var req = decode(json);
  if (!song) init();
  toNode({ id: req.id, ok: true, result: { version: VERSION, tempo: num(song, "tempo"), onMaster: onMaster, capturing: !!capture } });
}

// code is a stable identifier the Ae panel localizes; detail is diagnostic text.
function replyError(id, code, detail) {
  post("Phasebind error: " + code + (detail ? " (" + detail + ")" : "") + "\n");
  status("Error: " + code);
  toNode({ id: id, ok: false, code: code, error: detail || code });
}

function fail(code, detail) {
  var e = new Error(code);
  e.plCode = code;
  if (detail) e.detail = detail;
  return e;
}
