// Phasebind shared audio utilities (WAV I/O, trimming, tail detection).
// Used by both the Ae CEP panel and the Max for Live node.script.
// tools/build.js copies this file into each side.
"use strict";

const fs = require("fs");

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

// ---------------------------------------------------------------- read

// Returns { sampleRate, channels: Float32Array[], bitDepth, isFloat }
function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file: " + filePath);
  }

  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      const numChannels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bitDepth = buf.readUInt16LE(body + 14);
      if (format === FORMAT_EXTENSIBLE && size >= 40) {
        format = buf.readUInt16LE(body + 24); // first 2 bytes of SubFormat GUID
      }
      fmt = { format, numChannels, sampleRate, bitDepth };
    } else if (id === "data") {
      dataOffset = body;
      // Some writers leave the size at 0 / 0xFFFFFFFF while recording.
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      dataSize = size;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt) throw new Error("Missing fmt chunk: " + filePath);
  if (dataOffset < 0) throw new Error("Missing data chunk: " + filePath);

  const { format, numChannels, sampleRate, bitDepth } = fmt;
  const bytesPerSample = bitDepth / 8;
  const frameSize = bytesPerSample * numChannels;
  const frames = Math.floor(dataSize / frameSize);
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

  const readSample = makeSampleReader(buf, format, bitDepth);
  for (let i = 0; i < frames; i++) {
    const base = dataOffset + i * frameSize;
    for (let c = 0; c < numChannels; c++) {
      channels[c][i] = readSample(base + c * bytesPerSample);
    }
  }
  return { sampleRate, channels, bitDepth, isFloat: format === FORMAT_FLOAT };
}

function makeSampleReader(buf, format, bitDepth) {
  if (format === FORMAT_FLOAT && bitDepth === 32) return (o) => buf.readFloatLE(o);
  if (format === FORMAT_FLOAT && bitDepth === 64) return (o) => buf.readDoubleLE(o);
  if (format === FORMAT_PCM) {
    if (bitDepth === 16) return (o) => buf.readInt16LE(o) / 32768;
    if (bitDepth === 24) return (o) => buf.readIntLE(o, 3) / 8388608;
    if (bitDepth === 32) return (o) => buf.readInt32LE(o) / 2147483648;
    if (bitDepth === 8) return (o) => (buf.readUInt8(o) - 128) / 128;
  }
  throw new Error("Unsupported WAV format " + format + " / " + bitDepth + "bit");
}

// AIFF / AIFF-C (Ae's bundled audio templates render AIFF). Big-endian PCM,
// plus AIFF-C "NONE", "sowt" (little-endian) and "fl32" (float).
// Returns the same shape as readWav.
function readAiff(filePath) {
  const buf = fs.readFileSync(filePath);
  const form = buf.toString("ascii", 8, 12);
  if (buf.toString("ascii", 0, 4) !== "FORM" || (form !== "AIFF" && form !== "AIFC")) {
    throw new Error("Not an AIFF file: " + filePath);
  }

  let comm = null;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32BE(pos + 4);
    const body = pos + 8;
    if (id === "COMM") {
      comm = {
        numChannels: buf.readInt16BE(body),
        frames: buf.readUInt32BE(body + 2),
        bitDepth: buf.readInt16BE(body + 6),
        sampleRate: Math.round(readExtended(buf, body + 8)),
        compression: form === "AIFC" && size >= 22 ? buf.toString("ascii", body + 18, body + 22) : "NONE",
      };
    } else if (id === "SSND") {
      const offset = buf.readUInt32BE(body);
      dataOffset = body + 8 + offset;
      dataSize = Math.min(size - 8 - offset, buf.length - dataOffset);
    }
    pos = body + size + (size % 2);
  }
  if (!comm) throw new Error("Missing COMM chunk: " + filePath);
  if (dataOffset < 0) throw new Error("Missing SSND chunk: " + filePath);

  const { numChannels, bitDepth, sampleRate, compression } = comm;
  const bytesPerSample = Math.ceil(bitDepth / 8);
  const frameSize = bytesPerSample * numChannels;
  const frames = Math.min(comm.frames, Math.floor(dataSize / frameSize));
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

  let readSample;
  const comp = compression.toLowerCase();
  if (comp === "fl32") readSample = (o) => buf.readFloatBE(o);
  else if (comp === "fl64") readSample = (o) => buf.readDoubleBE(o);
  else if (comp === "sowt") readSample = (o) => buf.readIntLE(o, bytesPerSample) / Math.pow(2, bytesPerSample * 8 - 1);
  else if (comp === "none" || comp === "twos") readSample = (o) => buf.readIntBE(o, bytesPerSample) / Math.pow(2, bytesPerSample * 8 - 1);
  else throw new Error("Unsupported AIFF-C compression: " + compression);

  for (let i = 0; i < frames; i++) {
    const base = dataOffset + i * frameSize;
    for (let c = 0; c < numChannels; c++) channels[c][i] = readSample(base + c * bytesPerSample);
  }
  return { sampleRate, channels, bitDepth, isFloat: comp === "fl32" || comp === "fl64" };
}

// 80-bit IEEE 754 extended (AIFF sample rate).
function readExtended(buf, o) {
  const sign = buf[o] & 0x80 ? -1 : 1;
  const exp = ((buf[o] & 0x7f) << 8) | buf[o + 1];
  const hi = buf.readUInt32BE(o + 2);
  const lo = buf.readUInt32BE(o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  return sign * (hi * Math.pow(2, exp - 16383 - 31) + lo * Math.pow(2, exp - 16383 - 63));
}

// Reads WAV or AIFF by content.
function readAudio(filePath) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(filePath, "r");
  try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  return head.toString("ascii") === "FORM" ? readAiff(filePath) : readWav(filePath);
}

// Any supported file -> WAV (used for Ae's AIFF renders). Returns the bit depth written.
function convertToWav(srcPath, dstPath, bitDepth) {
  const a = readAudio(srcPath);
  return writeWav(dstPath, a.sampleRate, a.channels, bitDepth || (a.isFloat ? 32 : 24));
}

// ---------------------------------------------------------------- write

// bitDepth: 24 (PCM) or 32 (float). With 24 and peaks above 0 dBFS the file
// is written as 32-bit float instead so reverb/delay overs are not clipped.
// Returns the bit depth actually written.
function writeWav(filePath, sampleRate, channels, bitDepth) {
  bitDepth = bitDepth || 24;
  if (bitDepth === 24 && peak(channels) > 1.0) bitDepth = 32;
  const isFloat = bitDepth === 32;
  const numChannels = channels.length;
  const frames = channels.length ? channels[0].length : 0;
  const bytesPerSample = bitDepth / 8;
  const dataSize = frames * numChannels * bytesPerSample;
  const fmtSize = isFloat ? 18 : 16;
  const factSize = isFloat ? 12 : 0;
  const headerSize = 12 + 8 + fmtSize + factSize + 8;
  const buf = Buffer.alloc(headerSize + dataSize);

  let p = 0;
  buf.write("RIFF", p); p += 4;
  buf.writeUInt32LE(headerSize - 8 + dataSize, p); p += 4;
  buf.write("WAVE", p); p += 4;
  buf.write("fmt ", p); p += 4;
  buf.writeUInt32LE(fmtSize, p); p += 4;
  buf.writeUInt16LE(isFloat ? FORMAT_FLOAT : FORMAT_PCM, p); p += 2;
  buf.writeUInt16LE(numChannels, p); p += 2;
  buf.writeUInt32LE(sampleRate, p); p += 4;
  buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, p); p += 4;
  buf.writeUInt16LE(numChannels * bytesPerSample, p); p += 2;
  buf.writeUInt16LE(bitDepth, p); p += 2;
  if (isFloat) {
    buf.writeUInt16LE(0, p); p += 2; // cbSize
    buf.write("fact", p); p += 4;
    buf.writeUInt32LE(4, p); p += 4;
    buf.writeUInt32LE(frames, p); p += 4;
  }
  buf.write("data", p); p += 4;
  buf.writeUInt32LE(dataSize, p); p += 4;

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const v = channels[c][i];
      if (isFloat) {
        buf.writeFloatLE(v, p);
      } else {
        const s = Math.max(-1, Math.min(1, v));
        buf.writeIntLE(Math.round(s < 0 ? s * 8388608 : s * 8388607), p, 3);
      }
      p += bytesPerSample;
    }
  }
  fs.writeFileSync(filePath, buf);
  return bitDepth;
}

// ---------------------------------------------------------------- helpers

function peak(channels) {
  let m = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > m) m = a;
    }
  }
  return m;
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function sliceChannels(channels, start, end) {
  return channels.map((ch) => {
    const out = new Float32Array(Math.max(0, end - start));
    // Regions outside the source are left as silence.
    const s = Math.max(0, start);
    const e = Math.min(ch.length, end);
    if (e > s) out.set(ch.subarray(s, e), s - start);
    return out;
  });
}

// Cut [startSec, endSec) of a WAV file into a new file (Ae -> Live fast mode).
function cutWav(srcPath, dstPath, startSec, endSec, bitDepth) {
  const wav = readWav(srcPath);
  const start = Math.round(startSec * wav.sampleRate);
  const end = Math.round(endSec * wav.sampleRate);
  const channels = sliceChannels(wav.channels, start, end);
  const written = writeWav(dstPath, wav.sampleRate, channels, bitDepth);
  return { sampleRate: wav.sampleRate, durationSec: (end - start) / wav.sampleRate, bitDepth: written };
}

// Index of the first sample where the transport-marker channel starts moving.
// The marker is plugphasor~ (beat phase 0..1): constant while stopped, ramping
// while playing. Returns -1 when no clean stopped->running edge is found.
function findTransportStart(marker) {
  const EPS = 1e-9;
  for (let i = 1; i < marker.length; i++) {
    if (Math.abs(marker[i] - marker[i - 1]) > EPS) return i === 1 ? -1 : i;
  }
  return -1;
}

// True when the marker ramps by one unit per beat after t0 (i.e. it really is
// a per-beat phasor), so its value can be used as the fractional beat.
function isBeatPhasor(marker, t0, samplesPerBeat) {
  const n = Math.min(Math.round(samplesPerBeat / 4), marker.length - t0 - 1);
  if (n < 16) return false;
  let d = marker[t0 + n] - marker[t0];
  if (d < 0) d += 1; // at most one wrap within a quarter beat
  const expected = n / samplesPerBeat;
  return Math.abs(d - expected) < expected * 0.05;
}

// Last index at or after `from` whose level exceeds `threshold` (linear), or -1.
function findLastAbove(channels, from, threshold) {
  for (let i = channels[0].length - 1; i >= from; i--) {
    for (const ch of channels) {
      if (Math.abs(ch[i]) > threshold) return i;
    }
  }
  return -1;
}

/**
 * Turn a raw Live capture (L, R, transportMarker) into the final stereo file.
 *
 * The beat at which playback actually started is measured rather than assumed:
 * a coarse estimate comes from one LOM reading of current_song_time (posReadBeat,
 * taken posReadOffsetMs after recording started), and the exact fractional beat
 * comes from the phasor marker at the transport-start sample.
 *
 * meta:
 *   tempo              BPM (constant tempo assumed)
 *   posReadBeat        current_song_time read during playback
 *   posReadOffsetMs    wall-clock ms between record start and that reading
 *   playStartBeat      requested play position; estimate used only without posReadBeat
 *   rangeStartBeat     start of the requested range
 *   rangeEndBeat       end of the requested range (tail is kept after this)
 *   fallbackOffsetMs   wall-clock delay between record start and play start, used
 *                      only when the marker channel cannot be read
 *   latencyOffsetMs    manual correction (positive = audio arrives later)
 *   trimThresholdDb    tail is kept until the signal last exceeds this level
 *   tailPadMs          extra silence kept after the last audible sample
 *   fadeOutMs          fade applied to the very end of the tail
 *   bitDepth           24 or 32
 *
 * warnings in the result are codes: markerMissing, approxAlign, tailCut.
 */
function finalizeCapture(rawPath, outPath, meta) {
  const raw = readWav(rawPath);
  const sr = raw.sampleRate;
  if (raw.channels.length < 3) throw new Error("Raw capture must have 3 channels (L, R, marker)");
  const audio = raw.channels.slice(0, 2);
  const marker = raw.channels[2];

  const warnings = [];
  const samplesPerBeat = (60 / meta.tempo) * sr;

  // Coarse beat position at sample t, from the LOM reading.
  const estimateBeat = (t) => meta.posReadBeat == null
    ? meta.playStartBeat
    : meta.posReadBeat - (meta.posReadOffsetMs / 1000 - t / sr) * (meta.tempo / 60);

  let t0 = findTransportStart(marker);
  let startBeat;
  if (t0 < 0) {
    t0 = Math.round(((meta.fallbackOffsetMs || 0) / 1000) * sr);
    startBeat = estimateBeat(t0);
    warnings.push("markerMissing");
  } else if (isBeatPhasor(marker, t0, samplesPerBeat)) {
    const phase = marker[t0];
    startBeat = Math.round(estimateBeat(t0) - phase) + phase;
  } else {
    startBeat = estimateBeat(t0);
    warnings.push("approxAlign");
  }
  t0 += Math.round(((meta.latencyOffsetMs || 0) / 1000) * sr);

  const rangeStart = t0 + Math.round((meta.rangeStartBeat - startBeat) * samplesPerBeat);
  const rangeEnd = t0 + Math.round((meta.rangeEndBeat - startBeat) * samplesPerBeat);

  // The marker only changes at the first audio buffer boundary after the
  // transport starts, so t0 can be up to one buffer after the real start. When
  // the range begins at beat 0 there is no pre-roll and the range start lands
  // just before t0; that is fine. Only a start well after the range is an error.
  const BUFFER_TOLERANCE = 4096; // largest common audio buffer size
  if (rangeStart < t0 - BUFFER_TOLERANCE) {
    const err = new Error(
      "playback started at beat " + startBeat.toFixed(3) + ", after the range start " + meta.rangeStartBeat.toFixed(3)
    );
    err.code = "lateStart";
    throw err;
  }

  // Tail: keep everything after rangeEnd until the signal decays below the threshold.
  const threshold = dbToLinear(meta.trimThresholdDb != null ? meta.trimThresholdDb : -70);
  const pad = Math.round(((meta.tailPadMs != null ? meta.tailPadMs : 50) / 1000) * sr);
  const lastAudible = findLastAbove(audio, Math.max(0, rangeEnd), threshold);
  let end = rangeEnd;
  if (lastAudible >= 0) end = Math.max(rangeEnd, Math.min(audio[0].length, lastAudible + 1 + pad));
  const recordedEnd = audio[0].length;
  if (lastAudible >= recordedEnd - pad - 1 && recordedEnd > rangeEnd) {
    warnings.push("tailCut");
  }

  const out = sliceChannels(audio, rangeStart, end);

  // Fade only inside the tail so the requested range itself is untouched.
  const tailLen = end - rangeEnd;
  const fade = Math.min(tailLen, Math.round(((meta.fadeOutMs != null ? meta.fadeOutMs : 20) / 1000) * sr));
  if (fade > 0) {
    const n = out[0].length;
    for (let i = 0; i < fade; i++) {
      const g = 1 - (i + 1) / fade;
      for (const ch of out) ch[n - fade + i] *= g;
    }
  }

  const bitDepth = writeWav(outPath, sr, out, meta.bitDepth || 24);
  return {
    sampleRate: sr,
    durationSec: out[0].length / sr,
    rangeDurationSec: (rangeEnd - rangeStart) / sr,
    tailSec: tailLen / sr,
    peakDb: 20 * Math.log10(Math.max(peak(out), 1e-12)),
    bitDepth,
    startBeat,
    warnings,
  };
}

module.exports = {
  readWav,
  readAiff,
  readAudio,
  convertToWav,
  writeWav,
  cutWav,
  finalizeCapture,
  findTransportStart,
  dbToLinear,
};
