'use strict';
// Reactive soundtrack from audio/<folder>/*.mp3 (etc).
//
//   bed/             looping bed(s). Names containing "more-intense" are the high-
//                    intensity bed; the rest are the calm bed. Both loop; gains
//                    crossfade with eff_int. As intensity rises the bed also pans
//                    left/right, faster and wider. Without a more-intense file,
//                    only the calm bed runs (low-pass still opens on intensity).
//   peak/            *loop* file: a third layer that fades in slowly after eff_int has
//                    stayed high for PEAK_HOLD_SEC; *onset* file: one-shot played at
//                    that moment. The layer fades out when eff_int falls away.
//   intense/         one-shot when eff_int crosses up into a higher level band
//   head_appear/     one-shot when a face fades in, panned to that head's side
//   head_disappear/  one-shot when a face fades out, panned to where it was
//
// Files that share the same first part of the name (everything before "#") are
// variants of one sound: each trigger picks one of those at random. Folders that
// contain several first-parts pick a first-part at random, then a variant.
//
// Catalog comes from /audio.json (serve.py). Uses harness / heads globals:
// $, prefSlider, setStatus, effInt, getHeads.

const AUDIO_EXTS = /\.(ogg|mp3|wav|m4a)$/i;
const MORE_INTENSE_RE = /more[-_]?intense/i;
const INTENSE_LEVELS = [0.4, 0.7]; // band edges; crossing up fires intense/
const HEAD_ALPHA_ON = 0.35;        // count a head as present above this fade
const ONESHOT_COOLDOWN = 0.35;     // min gap between any two oneshots of the same kind
const HEAD_COOLDOWN = 0.12;        // heads appearing together still each get their own cue
const HEAD_PAN_MAX = 0.9;          // keep head cues just short of hard left/right
const DROP_RATE = 0.45;            // |d(eff_int)/dt| for a soft "fall" oneshot from intense/
const FILTER_CLOSED = 420;
const FILTER_OPEN = 9000;
const GAIN_FLOOR = 0.18;
const GAIN_CEIL = 1.0;
const SMOOTH_SEC = 0.45;
const BED_FADE_SEC = 2.8;          // bed bus and calm/hot parts ease from 0 / between levels
const PAN_RATE_MIN = 0.06;         // Hz: slow ear-to-ear drift at low intensity
const PAN_RATE_MAX = 2.8;          // Hz: faster left/right swaps at high intensity
const PAN_DEPTH_MAX = 0.9;         // StereoPanner pan amount at full intensity (-1..1)
const PAN_SMOOTH_SEC = 1.6;        // how quickly rate/depth follow eff_int
const PEAK_ENTER = 0.85;           // eff_int at or above this counts toward the peak hold
const PEAK_EXIT = 0.7;             // below this the hold resets / the peak layer fades out
const PEAK_HOLD_SEC = 5;           // seconds held high before the peak starts
const PEAK_GAIN = 0.7;             // peak loop level (relative to master)
const PEAK_FADE_IN_SEC = 3.5;      // time constant of the peak layer rising from silence
const PEAK_FADE_OUT_SEC = 1.8;     // ... and sinking again
const PEAK_ONSET_GAIN = 0.9;
const PEAK_LOOP_RE = /loop/i;
const PEAK_ONSET_RE = /onset/i;

let audioCtx = null;
let masterGain = null;
let peakGain = null;         // peak loop bus (straight to master, not auto-panned)
let peakSource = null;
let peakStopTimer = 0;
let peakActive = false;
let peakHold = 0;            // seconds eff_int has been held high
let bedFilter = null;
let bedPanner = null;        // swings the bed between ears as intensity rises
let panLfo = null;
let panDepth = null;
let bedGain = null;          // overall bed bus (after calm/hot crossfade)
let calmBedGain = null;
let hotBedGain = null;
let calmBedSource = null;
let hotBedSource = null;
let calmBedUrl = null;
let hotBedUrl = null;

// folder -> { prefix: [url, ...] }
let catalog = {};
// url -> AudioBuffer
const buffers = new Map();

let playing = false;
let loading = false;
let lastEffForAudio = null;
let lastIntenseLevel = 0;
const readyAt = { intense: 0, drop: 0, head_appear: 0, head_disappear: 0, peak_onset: 0 };

const audioVol = prefSlider('audioVol', 'audioVol', (v) => v.toFixed(2));
const audioReact = prefSlider('audioReact', 'audioReact', (v) => v.toFixed(2));

function audioStatus(msg) {
  const el = $('audioStatus');
  if (el) el.textContent = msg;
}

function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = audioVol();
    bedFilter = audioCtx.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = FILTER_CLOSED;
    bedFilter.Q.value = 0.7;
    bedGain = audioCtx.createGain();
    bedGain.gain.value = 0;
    calmBedGain = audioCtx.createGain();
    hotBedGain = audioCtx.createGain();
    calmBedGain.gain.value = 0;
    hotBedGain.gain.value = 0;
    calmBedGain.connect(bedGain);
    hotBedGain.connect(bedGain);
    bedGain.connect(bedFilter);
    // Auto-pan: LFO -> depth -> panner.pan; rate and depth rise with eff_int.
    bedPanner = audioCtx.createStereoPanner();
    bedPanner.pan.value = 0;
    panDepth = audioCtx.createGain();
    panDepth.gain.value = 0;
    panLfo = audioCtx.createOscillator();
    panLfo.type = 'sine';
    panLfo.frequency.value = PAN_RATE_MIN;
    panLfo.connect(panDepth);
    panDepth.connect(bedPanner.pan);
    panLfo.start();
    bedFilter.connect(bedPanner);
    bedPanner.connect(masterGain);
    peakGain = audioCtx.createGain();
    peakGain.gain.value = 0;
    peakGain.connect(masterGain);
    masterGain.connect(audioCtx.destination);
  }
  return audioCtx;
}

async function resumeSoundtrack() {
  const ctx = ensureAudioCtx();
  if (ctx && ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }
  return ctx;
}

// "bed_Instrumental_only,_s_#1-1794….mp3" -> "bed_Instrumental_only,_s_"
function filePrefix(name) {
  const base = name.replace(AUDIO_EXTS, '');
  const hash = base.indexOf('#');
  return hash >= 0 ? base.slice(0, hash) : base;
}

function audioUrl(folder, name) {
  // Filenames contain "#" (ElevenLabs variants) — must be encoded or the browser truncates the path.
  return 'audio/' + folder + '/' + encodeURIComponent(name);
}

function groupFiles(folder, names) {
  const groups = {};
  for (const name of names) {
    if (!AUDIO_EXTS.test(name)) continue;
    const key = filePrefix(name);
    (groups[key] || (groups[key] = [])).push(audioUrl(folder, name));
  }
  return groups;
}

function folderHasFiles(folder) {
  const g = catalog[folder];
  return !!(g && Object.keys(g).some((k) => g[k].length));
}

function pickUrl(folder, predicate) {
  const groups = catalog[folder];
  if (!groups) return null;
  const keys = Object.keys(groups).filter((k) => {
    if (!groups[k].length) return false;
    if (!predicate) return true;
    return groups[k].some((url) => predicate(decodeURIComponent(url.split('/').pop())));
  });
  if (!keys.length) return null;
  const key = keys[Math.floor(Math.random() * keys.length)];
  let files = groups[key];
  if (predicate) files = files.filter((url) => predicate(decodeURIComponent(url.split('/').pop())));
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}

function isMoreIntenseBed(name) {
  return MORE_INTENSE_RE.test(name);
}

async function decodeUrl(url) {
  const ctx = ensureAudioCtx();
  if (!ctx) throw new Error('Web Audio not supported');
  if (buffers.has(url)) return buffers.get(url);
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const raw = await r.arrayBuffer();
  const buf = await ctx.decodeAudioData(raw.slice(0));
  buffers.set(url, buf);
  return buf;
}

async function preloadFolder(folder) {
  const groups = catalog[folder];
  if (!groups) return;
  const urls = Object.values(groups).flat();
  await Promise.all(urls.map((u) => decodeUrl(u).catch((e) => {
    console.warn('audio preload failed', u, e);
  })));
}

function catalogSummary() {
  const parts = [];
  for (const folder of ['bed', 'peak', 'intense', 'head_appear', 'head_disappear']) {
    const g = catalog[folder];
    if (!g) continue;
    const n = Object.values(g).reduce((s, a) => s + a.length, 0);
    if (n) parts.push(`${folder}×${n}`);
  }
  return parts.join(', ') || 'no audio files';
}

async function probeSoundtrack() {
  try {
    const r = await fetch('audio.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    catalog = {};
    for (const folder of Object.keys(data || {})) {
      catalog[folder] = groupFiles(folder, data[folder] || []);
    }
  } catch (e) {
    catalog = {};
    audioStatus('audio.json missing — is serve.py running?');
    $('audioBtn').disabled = true;
    return;
  }
  if (!folderHasFiles('bed')) {
    audioStatus('drop files in audio/bed/');
    $('audioBtn').disabled = true;
    return;
  }
  $('audioBtn').disabled = false;
  audioStatus(catalogSummary() + ' ready');
}

function stopSource(src) {
  if (!src) return null;
  try { src.stop(); } catch { /* already stopped */ }
  try { src.disconnect(); } catch { /* ignore */ }
  return null;
}

function stopBedSources() {
  calmBedSource = stopSource(calmBedSource);
  hotBedSource = stopSource(hotBedSource);
  clearTimeout(peakStopTimer);
  peakSource = stopSource(peakSource);
  peakActive = false;
  peakHold = 0;
  if (peakGain && audioCtx) {
    peakGain.gain.cancelScheduledValues(audioCtx.currentTime);
    peakGain.gain.setValueAtTime(0, audioCtx.currentTime);
  }
}

// ---- peak layer: eff_int held high for PEAK_HOLD_SEC ----
function startPeak() {
  if (peakActive) return;
  peakActive = true;
  clearTimeout(peakStopTimer);
  const now = audioCtx.currentTime;
  // One-shot marking the moment (centre, no pan).
  playOneShot('peak', PEAK_ONSET_GAIN, 'peak_onset', 0, 1, (n) => PEAK_ONSET_RE.test(n));
  // Loop starts from its beginning unless a previous one is still fading out.
  if (!peakSource) {
    const url = pickUrl('peak', (n) => PEAK_LOOP_RE.test(n));
    const buf = url && buffers.get(url);
    if (buf) peakSource = startLoop(buf, peakGain);
  }
  if (peakSource) {
    // The master volume slider applies on top; "react" scales how present the peak is.
    peakGain.gain.setTargetAtTime(PEAK_GAIN * (0.35 + 0.65 * audioReact()), now, PEAK_FADE_IN_SEC);
  }
}

function endPeak() {
  if (!peakActive) return;
  peakActive = false;
  const now = audioCtx.currentTime;
  peakGain.gain.setTargetAtTime(0, now, PEAK_FADE_OUT_SEC);
  clearTimeout(peakStopTimer);
  // After the fade is inaudible, free the source so the next peak restarts from the top.
  peakStopTimer = setTimeout(() => { peakSource = stopSource(peakSource); }, PEAK_FADE_OUT_SEC * 6000);
}

function updatePeak(intensity, dt) {
  if (!audioCtx || !peakGain) return;
  if (intensity >= PEAK_ENTER) peakHold += dt;
  else if (intensity < PEAK_EXIT) peakHold = 0;
  if (!peakActive && peakHold >= PEAK_HOLD_SEC) startPeak();
  else if (peakActive && intensity < PEAK_EXIT) { peakHold = 0; endPeak(); }
}

function startLoop(buffer, gainNode) {
  const ctx = ensureAudioCtx();
  if (!ctx || !buffer || !gainNode) return null;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(gainNode);
  src.start(0);
  return src;
}

function setPlayingUi(on) {
  playing = on;
  const btn = $('audioBtn');
  if (btn) btn.textContent = on ? 'Stop' : 'Play';
}

// pan: -1 (left ear) .. 1 (right ear), 0 = centre. predicate: only consider files whose name matches.
function playOneShot(folder, gainScale, readyKey, pan = 0, cooldown = ONESHOT_COOLDOWN, predicate) {
  if (!playing || !audioCtx || !masterGain) return false;
  const now = audioCtx.currentTime;
  const key = readyKey || folder;
  if (now < (readyAt[key] || 0)) return false;
  const url = pickUrl(folder, predicate);
  if (!url) return false;
  const buf = buffers.get(url);
  if (!buf) return false;
  readyAt[key] = now + cooldown;
  const src = audioCtx.createBufferSource();
  const g = audioCtx.createGain();
  g.gain.value = gainScale * audioVol() * (0.35 + 0.65 * audioReact());
  src.buffer = buf;
  src.connect(g);
  if (pan !== 0 && audioCtx.createStereoPanner) {
    const p = audioCtx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(masterGain);
  } else {
    g.connect(masterGain);
  }
  src.start(0);
  return true;
}

function intenseLevel(intensity) {
  let n = 0;
  for (const t of INTENSE_LEVELS) if (intensity >= t) n++;
  return n;
}

function bedMix(intensity) {
  const react = audioReact();
  const t = react * intensity + (1 - react) * 0.5;
  const g = GAIN_FLOOR + (GAIN_CEIL - GAIN_FLOOR) * t;
  const f = FILTER_CLOSED * Math.pow(FILTER_OPEN / FILTER_CLOSED, t);
  // Equal-power crossfade between calm and more-intense beds when both exist.
  const hasHot = !!hotBedSource;
  const hasCalm = !!calmBedSource;
  let calm = 1, hot = 0;
  if (hasHot && hasCalm) {
    const x = t * t; // bias a bit toward calm until intensity is clearly up
    const a = x * Math.PI * 0.5;
    calm = Math.cos(a);
    hot = Math.sin(a);
  } else if (hasHot) {
    calm = 0;
    hot = 1;
  } else if (!hasCalm) {
    calm = 0;
  }
  return { t, g, f, calm, hot };
}

// Bed gains always ease — never snap — so parts rise from silence slowly.
function applyAudioTargets(intensity) {
  if (!audioCtx || !masterGain || !bedGain || !bedFilter) return;
  const { t, g, f, calm, hot } = bedMix(intensity);
  const now = audioCtx.currentTime;
  masterGain.gain.setTargetAtTime(audioVol(), now, 0.08);
  bedGain.gain.setTargetAtTime(g, now, BED_FADE_SEC);
  bedFilter.frequency.setTargetAtTime(f, now, SMOOTH_SEC);
  if (calmBedGain) calmBedGain.gain.setTargetAtTime(calm, now, BED_FADE_SEC);
  if (hotBedGain) hotBedGain.gain.setTargetAtTime(hot, now, BED_FADE_SEC);
  // Intensity up → wider and faster left/right motion (squared so it wakes late).
  if (panLfo && panDepth) {
    const motion = t * t;
    const rate = PAN_RATE_MIN + (PAN_RATE_MAX - PAN_RATE_MIN) * motion;
    const depth = PAN_DEPTH_MAX * motion;
    panLfo.frequency.setTargetAtTime(rate, now, PAN_SMOOTH_SEC);
    panDepth.gain.setTargetAtTime(depth, now, PAN_SMOOTH_SEC);
  }
}

// Silence every bed gain immediately, then let applyAudioTargets ramp them up.
function silenceBedsNow() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  if (bedGain) bedGain.gain.setValueAtTime(0, now);
  if (calmBedGain) calmBedGain.gain.setValueAtTime(0, now);
  if (hotBedGain) hotBedGain.gain.setValueAtTime(0, now);
}

// Left/right position (-1..1) of a head track as the wearer / viewer sees it.
// Neither the page nor the headset mirrors the camera, so a head on the right of the picture
// sounds on the right; "flip L/R" in the panel reverses it if it feels backwards.
function headPan(x) {
  let p;
  if (typeof xrSession !== 'undefined' && xrSession && typeof camFov !== 'undefined') {
    // Headset: x is in the camera frame; use the real angle off the line of sight.
    const half = Math.tan(camFov.value * Math.PI / 360);
    p = Math.atan((x - 0.5) * 2 * half) / (Math.PI / 3);   // +-60 degrees = full pan
  } else {
    // Flat page: the picture is cover-cropped to the canvas, so convert to what is on screen.
    let sx = 1;
    const v = typeof lanes !== 'undefined' && lanes[0] && lanes[0].video;
    if (v && v.videoWidth && rtW && rtH) {
      const ca = rtW / rtH, va = v.videoWidth / v.videoHeight;
      sx = ca > va ? 1 : ca / va;
    }
    p = ((x - 0.5) / sx) * 2;
  }
  p = Math.max(-1, Math.min(1, p)) * HEAD_PAN_MAX;
  return $('audioFlip') && $('audioFlip').checked ? -p : p;
}

// Heads currently counted as present: track object -> last known x (kept so a head that just
// vanished still has a direction).
let presentHeads = new Map();

function currentHeads() {
  const m = new Map();
  if (typeof getHeads !== 'function') return m;
  for (const h of getHeads(0)) if (h.alpha >= HEAD_ALPHA_ON) m.set(h, h.x);
  return m;
}

function updateHeadOneShots() {
  const now = currentHeads();
  for (const [h, x] of now) {
    if (!presentHeads.has(h)) playOneShot('head_appear', 0.7, 'head_appear', headPan(x), HEAD_COOLDOWN);
  }
  for (const [h, x] of presentHeads) {
    if (!now.has(h)) playOneShot('head_disappear', 0.55, 'head_disappear', headPan(x), HEAD_COOLDOWN);
  }
  presentHeads = now;
}

async function toggleSoundtrack() {
  if (playing) {
    stopBedSources();
    setPlayingUi(false);
    audioStatus(catalogSummary() + ' stopped');
    return;
  }
  if (loading) return;
  loading = true;
  $('audioBtn').disabled = true;
  audioStatus('loading…');
  try {
    await resumeSoundtrack();
    if (!folderHasFiles('bed')) await probeSoundtrack();
    if (!folderHasFiles('bed')) throw new Error('no files in audio/bed/');
    await preloadFolder('bed');
    await Promise.all(['peak', 'intense', 'head_appear', 'head_disappear'].map(preloadFolder));

    calmBedUrl = pickUrl('bed', (n) => !isMoreIntenseBed(n));
    hotBedUrl = pickUrl('bed', isMoreIntenseBed);
    // No calm file at all → treat a random bed as calm (covers a folder of only calm names).
    if (!calmBedUrl && !hotBedUrl) calmBedUrl = pickUrl('bed');

    const calmBuf = calmBedUrl && buffers.get(calmBedUrl);
    const hotBuf = hotBedUrl && buffers.get(hotBedUrl);
    if (!calmBuf && !hotBuf) throw new Error('could not decode a bed file');

    stopBedSources();
    silenceBedsNow();
    if (calmBuf) calmBedSource = startLoop(calmBuf, calmBedGain);
    if (hotBuf) hotBedSource = startLoop(hotBuf, hotBedGain);

    lastEffForAudio = effInt;
    lastIntenseLevel = intenseLevel(effInt);
    presentHeads = currentHeads();
    setPlayingUi(true);
    applyAudioTargets(effInt);
    const bits = [];
    if (calmBedUrl) bits.push(decodeURIComponent(calmBedUrl.split('/').pop()));
    if (hotBedUrl) bits.push('hot:' + decodeURIComponent(hotBedUrl.split('/').pop()));
    audioStatus('playing ' + bits.join(' + '));
  } catch (e) {
    setPlayingUi(false);
    audioStatus('load failed: ' + (e && e.message ? e.message : e));
    setStatus('Soundtrack: ' + (e && e.message ? e.message : e));
  } finally {
    loading = false;
    $('audioBtn').disabled = !folderHasFiles('bed');
  }
}

// Call once per frame (flat page and headset) after eff_int is updated.
function updateSoundtrack(intensity, dt) {
  if (!playing) {
    lastEffForAudio = intensity;
    lastIntenseLevel = intenseLevel(intensity);
    return;
  }
  if (audioCtx && audioCtx.state === 'suspended') resumeSoundtrack();
  applyAudioTargets(intensity);
  updatePeak(intensity, dt);

  const level = intenseLevel(intensity);
  if (level > lastIntenseLevel) playOneShot('intense', 0.75, 'intense');
  lastIntenseLevel = level;

  if (lastEffForAudio !== null && dt > 0) {
    const dropRate = (lastEffForAudio - intensity) / dt;
    if (dropRate > DROP_RATE) playOneShot('intense', 0.5, 'drop');
  }
  lastEffForAudio = intensity;
  updateHeadOneShots();
}

$('audioFlip').checked = loadPref('audioFlip') === '1';
$('audioFlip').onchange = (ev) => savePref('audioFlip', ev.target.checked ? '1' : '0');

$('audioBtn').onclick = () => toggleSoundtrack();
$('audioVol').addEventListener('input', () => {
  if (masterGain && audioCtx) masterGain.gain.setTargetAtTime(audioVol(), audioCtx.currentTime, 0.05);
});

const prevCamClick = $('camBtn').onclick;
$('camBtn').onclick = () => { resumeSoundtrack(); if (prevCamClick) prevCamClick(); };
$('fileIn').addEventListener('change', () => resumeSoundtrack());

probeSoundtrack();
