// Phasebind build script (source step; tools/build-zxp.ps1 runs this first).
//   node tools/build.js [--device-out <dir>]
//
// 1. Checks that package.json, the CEP manifest and the device agree on the version.
// 2. Copies shared/audio.js into the Ableton device and the Ae extension.
// 3. Generates the Max for Live patcher (Phasebind.maxpat) and device (Phasebind.amxd).
// 4. Copies the device to dist/Phasebind-<version>-ableton (or --device-out).
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const deviceDir = path.join(root, "ableton", "device");
const aeLibDir = path.join(root, "aftereffects", "extension", "lib");

const version = require(path.join(root, "package.json")).version;
const manifest = fs.readFileSync(path.join(root, "aftereffects", "extension", "CSXS", "manifest.xml"), "utf8");
const lom = fs.readFileSync(path.join(deviceDir, "phasebind_lom.js"), "utf8");
const versions = {
  "manifest ExtensionBundleVersion": (/ExtensionBundleVersion="([^"]+)"/.exec(manifest) || [])[1],
  "manifest Extension Version": (/<Extension Id="[^"]+" Version="([^"]+)"/.exec(manifest) || [])[1],
  "phasebind_lom.js VERSION": (/var VERSION = "([^"]+)"/.exec(lom) || [])[1],
};
for (const [where, v] of Object.entries(versions)) {
  if (v !== version) throw new Error(`Version mismatch: package.json ${version} vs ${where} ${v}`);
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("--device-out");
const deviceOut = outIdx >= 0
  ? path.resolve(args[outIdx + 1])
  : path.join(root, "dist", `Phasebind-${version}-ableton`);
const DEVICE_FILES = ["Phasebind.amxd", "phasebind_lom.js", "phasebind_bridge.js", "audio.js"];

fs.mkdirSync(aeLibDir, { recursive: true });
fs.copyFileSync(path.join(root, "shared", "audio.js"), path.join(deviceDir, "audio.js"));
fs.copyFileSync(path.join(root, "shared", "audio.js"), path.join(aeLibDir, "audio.js"));

// ---------------------------------------------------------------- patcher

const boxes = [];
const lines = [];

function box(id, maxclass, text, inlets, outlets, rect, extra) {
  const outlettype = Array.isArray(outlets) ? outlets : new Array(outlets).fill("");
  boxes.push({
    box: Object.assign(
      {
        id,
        maxclass,
        numinlets: inlets,
        numoutlets: outlettype.length,
        outlettype,
        patching_rect: rect,
      },
      text != null ? { text } : {},
      extra || {}
    ),
  });
}

function line(src, srcOutlet, dst, dstInlet) {
  lines.push({ patchline: { source: [src, srcOutlet], destination: [dst, dstInlet] } });
}

const presentation = (rect) => ({ presentation: 1, presentation_rect: rect });

// Device face: same tokens as the Ae panel (black #060606 / white #eeeeee / pink #f62660).
const DEVICE_WIDTH = 128;
const C = {
  bg: [0.024, 0.024, 0.024, 1],
  text: [0.933, 0.933, 0.933, 1],
  muted: [0.933, 0.933, 0.933, 0.58],
  line: [0.933, 0.933, 0.933, 0.17],
  accent: [0.965, 0.149, 0.376, 1],
};
const FONT = "Ableton Sans Medium";
const text = (size, color, rect, extra) => Object.assign(
  { fontname: FONT, fontsize: size, textcolor: color }, presentation(rect), extra || {}
);

// Background first so everything else draws on top of it.
box("face", "panel", null, 1, 0, [640, 20, 128, 169],
  Object.assign({ bgcolor: C.bg, bordercolor: C.bg, border: 0, background: 1 }, presentation([0, 0, DEVICE_WIDTH, 169])));
box("title", "comment", "Phasebind", 1, 0, [640, 200, 80, 18], text(11, C.text, [8, 6, 76, 16]));
box("aeConn", "comment", "○ Ae", 1, 0, [640, 230, 50, 18], text(9, C.muted, [80, 7, 40, 14], { textjustification: 2 }));
box("button", "live.text", null, 1, ["", ""], [140, 20, 90, 20],
  Object.assign({
    mode: 0, text: "Send to Ae", texton: "Send to Ae", parameter_enable: 0,
    fontname: FONT, fontsize: 11,
    bgcolor: C.accent, activebgcolor: C.accent, bgoncolor: C.text, activebgoncolor: C.text,
    bordercolor: C.accent, focusbordercolor: C.text,
    textcolor: C.bg, activetextcolor: C.bg, textoncolor: C.bg, activetextoncolor: C.bg,
  }, presentation([8, 28, DEVICE_WIDTH - 16, 36])));
box("status", "comment", "Loading", 1, 0, [330, 170, 260, 20], text(9, C.muted, [8, 70, DEVICE_WIDTH - 16, 30]));
box("credit", "comment", "© 2026 Sqkurq", 1, 0, [330, 200, 260, 20], text(8, C.line, [8, 150, DEVICE_WIDTH - 16, 13]));

// Control
box("thisdevice", "live.thisdevice", null, 1, ["bang", "int", "int"], [30, 20, 85, 22]);
box("init", "message", "init", 2, 1, [30, 55, 35, 22]);
box("trig", "newobj", "t b", 1, ["bang"], [140, 50, 25, 22]);
box("capmsg", "message", "capture_device", 2, 1, [140, 80, 95, 22]);
box("node", "newobj", "node.script phasebind_bridge.js @autostart 1 @watch 0", 1, ["", ""], [300, 20, 330, 22]);
box("js", "newobj", "js phasebind_lom.js", 2, ["", "", "", ""], [30, 130, 290, 22]);

// Audio
box("plugin", "newobj", "plugin~", 2, ["signal", "signal"], [30, 230, 60, 22]);
box("plugout", "newobj", "plugout~", 2, 0, [30, 400, 60, 22]);
box("phasor", "newobj", "plugphasor~", 1, ["signal"], [200, 230, 80, 22]);
box("rec", "newobj", "sfrecord~ 3", 3, ["signal"], [30, 350, 190, 22]);
box("peakL", "newobj", "peakamp~ 50", 2, [""], [330, 260, 80, 22]);
box("peakR", "newobj", "peakamp~ 50", 2, [""], [420, 260, 80, 22]);
box("max", "newobj", "maximum 0.", 2, ["float"], [330, 290, 80, 22]);

line("thisdevice", 0, "init", 0);
line("init", 0, "js", 0);
line("button", 0, "trig", 0);
line("trig", 0, "capmsg", 0);
line("capmsg", 0, "js", 0);
line("node", 0, "js", 0);
line("js", 0, "rec", 0);
line("js", 1, "node", 0);
line("js", 2, "status", 0);
line("js", 3, "aeConn", 0);

line("plugin", 0, "plugout", 0);
line("plugin", 1, "plugout", 1);
line("plugin", 0, "rec", 0);
line("plugin", 1, "rec", 1);
line("phasor", 0, "rec", 2); // beat phase marker for sample-exact alignment
line("plugin", 0, "peakL", 0);
line("plugin", 1, "peakR", 0);
line("peakR", 0, "max", 1);
line("peakL", 0, "max", 0);
line("max", 0, "js", 1);

// No dependency_cache: Max finds the scripts next to the .amxd, and the device
// must not carry absolute paths from the build machine.
const patcher = {
  patcher: {
    fileversion: 1,
    appversion: { major: 8, minor: 6, revision: 0, architecture: "x64", modernui: 1 },
    classnamespace: "box",
    rect: [100, 100, 700, 480],
    openinpresentation: 1,
    default_fontsize: 10.0,
    default_fontname: "Arial Bold",
    gridsize: [8, 8],
    devicewidth: DEVICE_WIDTH,
    boxes,
    lines,
    autosave: 0,
  },
};

const json = JSON.stringify(patcher, null, "\t");
fs.writeFileSync(path.join(deviceDir, "Phasebind.maxpat"), json);

// .amxd container: "ampf" header, device type, meta, then the patcher JSON.
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
const ptch = Buffer.concat([Buffer.from(json + "\n", "utf8"), Buffer.from([0])]);
const amxd = Buffer.concat([
  Buffer.from("ampf"), u32(4), Buffer.from("aaaa"), // audio effect
  Buffer.from("meta"), u32(4), u32(0),
  Buffer.from("ptch"), u32(ptch.length), ptch,
]);
fs.writeFileSync(path.join(deviceDir, "Phasebind.amxd"), amxd);

fs.rmSync(deviceOut, { recursive: true, force: true });
fs.mkdirSync(deviceOut, { recursive: true });
for (const f of DEVICE_FILES) {
  fs.copyFileSync(path.join(deviceDir, f), path.join(deviceOut, f));
}
fs.copyFileSync(path.join(root, "LICENSE"), path.join(deviceOut, "LICENSE"));

console.log(`Built Phasebind ${version}:`);
console.log("  Ableton device: " + deviceOut);
console.log("  Ae extension lib: " + path.join(aeLibDir, "audio.js"));
