// Phasebind - After Effects panel (CEP, mixed context: DOM + Node.js).
"use strict";

const inCEP = !!window.__adobe_cep__ && typeof require === "function";
const net = inCEP ? require("net") : null;
const fs = inCEP ? require("fs") : null;
const path = inCEP ? require("path") : null;

const PORT = 47820;
const { t } = window.PLi18n;

const extensionDir = inCEP ? (() => {
  let p = window.__adobe_cep__.getSystemPath("extension");
  p = decodeURI(p).replace(/^file:\/{2,3}/, "");
  return path.normalize(p);
})() : null;
const audio = inCEP ? require(path.join(extensionDir, "lib", "audio.js")) : null;

const $ = (id) => document.getElementById(id);
const shortId = () => Math.random().toString(36).slice(2, 10);
const sanitize = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "layer";

// ------------------------------------------------------------------ chrome hardening

// No browser context menu, reload, zoom or file-drop navigation anywhere in the panel.
document.addEventListener("contextmenu", (e) => e.preventDefault(), true);
document.addEventListener("dragover", (e) => e.preventDefault(), true);
document.addEventListener("drop", (e) => e.preventDefault(), true);
document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "f5" || ((e.ctrlKey || e.metaKey) && (k === "r" || k === "p" || k === "+" || k === "-" || k === "=" || k === "0"))) {
    e.preventDefault();
  }
}, true);
document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { capture: true, passive: false });
if (inCEP) {
  try { window.__adobe_cep__.invokeAsync("setContextMenuByJSON", JSON.stringify({ menu: [] }), () => {}); } catch (e) {}
}

// ------------------------------------------------------------------ icons

for (const el of document.querySelectorAll("[data-icon]")) {
  const icon = document.createElement("span");
  icon.className = "material-symbol";
  icon.textContent = el.dataset.icon;
  icon.setAttribute("aria-hidden", "true");
  el.appendChild(icon);
}

// ------------------------------------------------------------------ errors and status

// Errors carry a code (from ExtendScript, Live or this panel) that maps to err.*.
function fail(code, detail) {
  const e = new Error(detail || code);
  e.code = code;
  return e;
}

function errorText(e) {
  const key = "err." + (e.code || "host");
  const text = window.PLi18n.has(key) ? t(key) : t("err.host");
  return { text, detail: e.message && e.message !== e.code ? e.message : "" };
}

function status(msg, isError, detail) {
  const el = $("status");
  el.textContent = msg;
  el.title = detail ? msg + "\n" + detail : msg;
  el.classList.toggle("err", !!isError);
  console[isError ? "error" : "log"]("Phasebind:", msg, detail || "");
}

function showError(e) {
  const { text, detail } = errorText(e);
  status(text, true, detail);
}

function setBusy(on) {
  $("busyBar").hidden = !on;
  $("sendBtn").disabled = on;
  $("getBtn").disabled = on;
}

// ------------------------------------------------------------------ ExtendScript

function evalHost(fn, ...args) {
  const call = fn + "(" + args.map((a) => JSON.stringify(a)).join(",") + ")";
  return new Promise((resolve, reject) => {
    window.__adobe_cep__.evalScript(call, (res) => {
      let parsed;
      try {
        parsed = JSON.parse(res);
      } catch (e) {
        reject(fail("host", String(res)));
        return;
      }
      if (parsed.ok) resolve(parsed);
      else reject(fail(parsed.code || "host", parsed.error));
    });
  });
}

// ------------------------------------------------------------------ settings

const SETTINGS_KEY = "phasebind.settings";
const SETTING_IDS = ["useSaveDir", "saveDir", "exportMode", "muteSent",
  "tailThresholdDb", "tailHoldMs", "maxTailSec", "trimThresholdDb", "latencyOffsetMs", "lang"];
const DEFAULT_SAVE_DIR = "./Phasebind";

const valueKey = (id) => ($(id).type === "checkbox" ? "checked" : "value");

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    for (const id of SETTING_IDS) if (saved[id] != null) $(id)[valueKey(id)] = saved[id];
  } catch (e) {}
  applyLanguage();
}

function saveSettings() {
  const s = {};
  for (const id of SETTING_IDS) s[id] = $(id)[valueKey(id)];
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  applyLanguage();
  pushDefaults();
}

function applyLanguage() {
  window.PLi18n.setLang($("lang").value);
  window.PLi18n.apply(document);
  const fixed = $("useSaveDir").checked;
  $("saveDir").disabled = !fixed;
  $("pickSaveDir").disabled = !fixed;
  $("saveDirHint").textContent = t(fixed ? "hintFixed" : "hintAsk");
  renderConn();
}

function captureOptions() {
  const n = (id) => Number($(id).value);
  return {
    tailThresholdDb: n("tailThresholdDb"),
    tailHoldMs: n("tailHoldMs"),
    maxTailSec: n("maxTailSec"),
    trimThresholdDb: n("trimThresholdDb"),
    latencyOffsetMs: n("latencyOffsetMs"),
  };
}

function readVersion() {
  if (!inCEP) return "";
  try {
    const xml = fs.readFileSync(path.join(extensionDir, "CSXS", "manifest.xml"), "utf8");
    return (/ExtensionBundleVersion="([^"]+)"/.exec(xml) || [])[1] || "";
  } catch (e) {
    return "";
  }
}

// ------------------------------------------------------------------ save location

// Fixed: "./Phasebind" style paths resolve against the .aep folder; for an
// unsaved project the base folder is asked once and reused until it is saved.
// Not fixed: a folder is picked for every capture / export.
let unsavedProjectDir = null;

async function pickFolder(promptKey) {
  const pick = await evalHost("PL_chooseFolder", "Phasebind: " + t(promptKey));
  if (!pick.path) throw fail("cancelled");
  return pick.path;
}

async function resolveOutDir() {
  let dir;
  if (!$("useSaveDir").checked) {
    dir = await pickFolder("pickAsk");
  } else {
    const setting = $("saveDir").value.trim() || DEFAULT_SAVE_DIR;
    if (path.isAbsolute(setting)) {
      dir = setting;
    } else {
      const proj = await evalHost("PL_getProjectDir");
      let base = proj.saved ? proj.dir : unsavedProjectDir;
      if (!base) {
        base = await pickFolder("pickBase");
        unsavedProjectDir = base;
      }
      dir = path.resolve(base, setting);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function moveFile(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

// ------------------------------------------------------------------ Live connection

let socket = null;
let connected = false;
let liveInfo = null;
const waiting = new Map();

function connect() {
  socket = net.createConnection({ host: "127.0.0.1", port: PORT });
  let buffer = "";
  socket.setEncoding("utf8");

  socket.on("connect", () => {
    connected = true;
    request({ type: "ping" })
      .then((r) => { liveInfo = r.result; renderConn(); })
      .catch(showError);
    pushDefaults();
  });

  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) handleMessage(JSON.parse(line));
    }
  });

  const onDown = () => {
    if (connected) showError(fail("connectionLost"));
    connected = false;
    liveInfo = null;
    renderConn();
    for (const w of waiting.values()) w.reject(fail("connectionLost"));
    waiting.clear();
    setTimeout(connect, 2000);
  };
  socket.on("close", onDown);
  socket.on("error", () => {}); // close follows
}

function renderConn() {
  const on = connected && liveInfo;
  const onMaster = on && liveInfo.onMaster;
  const title = !on ? t("connOff") : onMaster ? t("connOn", liveInfo.tempo, liveInfo.version) : t("err.notOnMaster");
  $("lamp").classList.toggle("on", !!onMaster);
  $("lamp").classList.toggle("warn", !!on && !onMaster);
  $("lamp").title = title;
  $("conn").textContent = !on ? "" : onMaster ? `${liveInfo.tempo} BPM` : t("putOnMaster");
  $("conn").title = title;
}

function request(obj) {
  if (!connected) return Promise.reject(fail("noLive"));
  const id = shortId();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    socket.write(JSON.stringify(Object.assign({ id }, obj)) + "\n");
  }).then((msg) => {
    if (!msg.ok) throw fail(msg.code || "liveError", msg.error);
    return msg;
  });
}

function handleMessage(msg) {
  if (msg.id && waiting.has(msg.id)) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    w.resolve(msg);
    return;
  }
  // Unsolicited events (capture started from the device button).
  if (msg.event === "captured" && msg.ok) {
    run(() => importCapture(msg.result, null));
  } else if (msg.event === "captured" || msg.event === "error") {
    showError(fail(msg.code || "liveError", msg.error));
  }
}

function pushDefaults() {
  if (connected) request({ type: "setDefaults", options: captureOptions() }).catch(() => {});
}

// ------------------------------------------------------------------ Ae -> Live

async function sendToLive() {
  const sel = await evalHost("PL_getSelection");
  if (!sel.layers.length) throw fail("noAudioLayer");

  const outDir = await resolveOutDir();
  const files = [];
  for (const L of sel.layers) {
    const linkId = L.linkId || shortId();
    const dst = path.join(outDir, `pl_${linkId}_${sanitize(L.name)}.wav`);
    const startSec = Math.max(0, L.inPoint);

    const canCut = $("exportMode").value === "auto" && !L.timeRemap && L.stretch === 100 &&
      !L.isPrecomp && L.sourcePath && /\.wav$/i.test(L.sourcePath);

    if (canCut) {
      audio.cutWav(L.sourcePath, dst, startSec - L.startTime, L.outPoint - L.startTime, 24);
    } else {
      status(t("rendering", L.name));
      const r = await evalHost("PL_renderLayerAudio", L.index, dst);
      if (r.format === "aiff") {
        // Rendered with Ae's bundled AIFF template; Live gets WAV either way.
        audio.convertToWav(r.path, dst, 24);
        fs.unlinkSync(r.path);
      } else if (path.normalize(r.path) !== path.normalize(dst)) {
        fs.renameSync(r.path, dst);
      }
    }

    await evalHost("PL_tagLayer", L.index, linkId);
    files.push({ path: dst, positionSec: startSec, name: L.name, linkId });
  }

  const res = await request({ type: "import", files });
  status(t("sent", res.result.created.length));
}

// ------------------------------------------------------------------ Live -> Ae

async function getFromLive() {
  // Decide (and if needed ask for) the save location before Live starts playing.
  const outDir = await resolveOutDir();
  status(t("capturing"));
  const res = await request({ type: "capture", options: Object.assign(captureOptions(), { outDir }) });
  await importCapture(res.result, outDir);
}

async function importCapture(r, outDir) {
  // Captures started from the device button land in Live's fallback folder.
  if (!outDir) outDir = await resolveOutDir();
  if (path.normalize(path.dirname(r.path)).toLowerCase() !== path.normalize(outDir).toLowerCase()) {
    const dst = path.join(outDir, path.basename(r.path));
    moveFile(r.path, dst);
    r.path = dst;
  }
  // The mix always starts at the head of the composition.
  const imp = await evalHost("PL_importAudio", r.path, 0, r.name, r.linkId, $("muteSent").checked);
  const parts = [t(imp.replaced ? "replaced" : "added") + " " +
    t("imported", r.name, r.rangeDurationSec.toFixed(1), r.tailSec.toFixed(1), r.peakDb.toFixed(1))];
  if (imp.muted) parts.push(t("muted", imp.muted));
  const warnings = [...new Set((r.warnings || []).map((w) => t("warn." + w)))];
  status(parts.concat(warnings).join(" · "), warnings.length > 0, r.path);
}

// ------------------------------------------------------------------ UI wiring

let busy = false;

async function run(fn) {
  if (busy) return;
  busy = true;
  setBusy(true);
  try {
    await fn();
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
    setBusy(false);
  }
}

function showSettings(open) {
  $("mainView").hidden = open;
  $("settingsView").hidden = !open;
}

const version = readVersion();
$("version").textContent = version ? "v" + version : "";
loadSettings();
for (const id of SETTING_IDS) $(id).addEventListener("change", saveSettings);
$("openSettings").addEventListener("click", () => showSettings(true));
$("closeSettings").addEventListener("click", () => showSettings(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("settingsView").hidden) showSettings(false); });
$("pickSaveDir").addEventListener("click", async () => {
  try {
    $("saveDir").value = await pickFolder("pickAsk");
    saveSettings();
  } catch (e) {}
});
$("saveDir").addEventListener("blur", () => {
  if (!$("saveDir").value.trim()) { $("saveDir").value = DEFAULT_SAVE_DIR; saveSettings(); }
});
$("sendBtn").addEventListener("click", () => run(sendToLive));
$("getBtn").addEventListener("click", () => run(getFromLive));

if (inCEP) connect();
else status(t("preview"));
