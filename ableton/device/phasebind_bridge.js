// Phasebind - Max for Live bridge (node.script).
//
// Runs a TCP server on 127.0.0.1:47820 speaking newline-delimited JSON.
// The After Effects panel connects as a client. LOM work is delegated to
// phasebind_lom.js ([js]) through Max messages; audio post-processing
// (marker alignment, tail trimming) happens here.
"use strict";

const maxAPI = require("max-api");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const audio = require("./audio.js");

const PORT = 47820;
const BASE_DIR = path.join(os.homedir(), "Phasebind");
const RAW_DIR = path.join(BASE_DIR, "raw");
const FROM_LIVE_DIR = path.join(BASE_DIR, "from_live");

for (const d of [BASE_DIR, RAW_DIR, FROM_LIVE_DIR]) fs.mkdirSync(d, { recursive: true });

const clients = new Set();
const pending = new Map(); // request id -> { socket, type, options }

const toMaxPath = (p) => p.replace(/\\/g, "/");
const encode = (obj) => encodeURIComponent(JSON.stringify(obj));
const sanitize = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "track";
const shortId = () => Math.random().toString(36).slice(2, 10);

// [js] may already be initialised before this script starts; tell it where to record.
maxAPI.outlet("setdir", toMaxPath(RAW_DIR));

function send(socket, obj) {
  if (socket && !socket.destroyed) socket.write(JSON.stringify(obj) + "\n");
}

function broadcast(obj) {
  for (const s of clients) send(s, obj);
}

// ------------------------------------------------------------------ TCP server

const server = net.createServer((socket) => {
  clients.add(socket);
  maxAPI.outlet("aeconn", clients.size);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        handleRequest(socket, JSON.parse(line));
      } catch (e) {
        send(socket, { ok: false, code: "badRequest", error: e.message });
      }
    }
  });
  const drop = () => {
    if (clients.delete(socket)) maxAPI.outlet("aeconn", clients.size);
  };
  socket.on("close", drop);
  socket.on("error", drop);
});

server.on("error", (e) => maxAPI.post("Phasebind server error: " + e.message, maxAPI.POST_LEVELS.ERROR));
server.listen(PORT, "127.0.0.1", () => maxAPI.post(`Phasebind listening on 127.0.0.1:${PORT}`));

function handleRequest(socket, req) {
  const id = req.id || shortId();
  switch (req.type) {
    case "ping":
      pending.set(id, { socket, type: "info" });
      maxAPI.outlet("info", encode({ id }));
      break;
    case "import":
      pending.set(id, { socket, type: "import" });
      maxAPI.outlet("importClips", encode({ id, files: req.files }));
      break;
    case "capture": {
      const options = Object.assign({}, req.options, {
        rawPath: toMaxPath(path.join(RAW_DIR, `raw_${Date.now()}.wav`)),
      });
      pending.set(id, { socket, type: "capture", options });
      maxAPI.outlet("captureRequest", encode({ id, options }));
      break;
    }
    case "setDefaults":
      // Options used when capture is triggered from the device button.
      maxAPI.outlet("setdefaults", encode(req.options || {}));
      send(socket, { id, ok: true });
      break;
    default:
      send(socket, { id, ok: false, code: "badRequest", error: "unknown request type: " + req.type });
  }
}

// ------------------------------------------------------------------ messages from [js]

maxAPI.addHandler("fromjs", (encoded) => {
  let msg;
  try {
    msg = JSON.parse(decodeURIComponent(encoded));
  } catch (e) {
    maxAPI.post("Phasebind: bad message from js: " + e.message, maxAPI.POST_LEVELS.ERROR);
    return;
  }

  if (msg.event === "jsReady") {
    maxAPI.outlet("setdir", toMaxPath(RAW_DIR));
    return;
  }

  const req = msg.id ? pending.get(msg.id) : null;
  if (msg.id) pending.delete(msg.id);

  if (msg.type === "captured" && msg.ok) {
    let reply;
    try {
      reply = { id: msg.id, ok: true, result: finalize(msg.result, req ? req.options : {}) };
    } catch (e) {
      reply = { id: msg.id, ok: false, code: e.code || "postFailed", error: e.message };
      // The raw recording is kept on failure; log where it is for diagnosis.
      maxAPI.post(`Phasebind error: ${reply.code}: ${e.message} (raw: ${msg.result.rawPath})`, maxAPI.POST_LEVELS.ERROR);
    }
    if (req) send(req.socket, reply);
    else broadcast(Object.assign({ event: "captured" }, reply)); // triggered from the device button
    return;
  }

  if (req) send(req.socket, msg);
  else if (!msg.ok) broadcast({ event: "error", code: msg.code, error: msg.error });
});

function finalize(r, options) {
  const linkId = r.linkId || shortId();
  // The Ae panel sends "<project folder>/Phasebind"; captures started from the
  // device button fall back to the home folder and are moved by Ae on import.
  const outDir = options.outDir || FROM_LIVE_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `pl_${linkId}_${sanitize(r.trackName)}_${Date.now()}.wav`);
  const rawPath = path.normalize(r.rawPath);
  const info = audio.finalizeCapture(rawPath, outPath, {
    tempo: r.tempo,
    playStartBeat: r.playStartBeat,
    posReadBeat: r.posReadBeat,
    posReadOffsetMs: r.posReadOffsetMs,
    rangeStartBeat: r.rangeStartBeat,
    rangeEndBeat: r.rangeEndBeat,
    fallbackOffsetMs: r.fallbackOffsetMs,
    latencyOffsetMs: options.latencyOffsetMs || 0,
    trimThresholdDb: options.trimThresholdDb,
    tailPadMs: options.tailPadMs,
    fadeOutMs: options.fadeOutMs,
    bitDepth: options.bitDepth,
  });
  if (!options.keepRaw) fs.unlinkSync(rawPath);
  if (r.tailCapped && info.warnings.indexOf("tailCut") < 0) info.warnings.push("tailCut");

  for (const w of info.warnings) maxAPI.post("Phasebind warning: " + w);
  return Object.assign(info, {
    path: outPath,
    name: r.trackName,
    linkId,
    // Live arrangement time 0 == Ae comp time 0 (constant tempo).
    startSec: (r.rangeStartBeat * 60) / r.tempo,
  });
}
