'use strict';
// Effect harness: input -> chain of GLSL effects -> screen. Plain WebGL2, no build step.

const POLL_MS = 1000;
const MAX_DIM = 1920;          // cap on render-target size (longest side, in pixels)

const $ = (id) => document.getElementById(id);
const canvas = $('out');
const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
if (!gl) document.body.innerHTML = '<p style="color:#fff;padding:20px">WebGL2 is not available in this browser.</p>';

// ============================================================================
// Input source.
// Must provide: getSourceElement(lane) -> a video/canvas/image ready to upload, or null.
// Lane 0 = the camera/video (left eye in stereo), lane 1 = the right camera (stereo only).
// ============================================================================
// New-frame timing per lane from the browser (fps readout and headset reprojection).
// presentationTime is on the performance.now() clock.
function makeLane() {
  const v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true;
  const lane = { video: v, stream: null, frames: { count: 0, presentationTime: 0, at: 0 } };
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const onFrame = (now, meta) => {
      lane.frames.count++;
      lane.frames.presentationTime = meta.presentationTime || now;
      lane.frames.at = performance.now();   // when the callback ran (they can stop in VR)
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }
  return lane;
}
const lanes = [makeLane(), makeLane()];
const video = lanes[0].video;
let camStream = null;            // lane 0 camera stream
let stereoOn = false;            // lane 1 (right camera) is running
let stereoInfo = 'off';

function stopCamera() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  lanes[0].stream = null;
}

function stopStereo(info = 'off') {
  const l = lanes[1];
  if (l.stream) l.stream.getTracks().forEach((t) => t.stop());
  l.stream = null;
  l.video.srcObject = null;
  stereoOn = false;
  stereoInfo = info;
}

async function videoInputs() {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
}

// Stereo: lane 0 = left camera, lane 1 = right camera. On the Quest the passthrough cameras
// are "camera 1, facing back" and "camera 2, facing back" (older builds: "camera 2 1",
// "camera 2 2"); the first one by name is assumed to be the left one. That is NOT verified:
// use the eye check in VR (A/X button) and "swap eyes" if it is the other way round.
// Without two back-facing cameras: the current camera plus the next one.
async function startStereo() {
  stopStereo();
  if (!camStream) { stopStereo('off - start the webcam first'); return; }
  const cams = await videoInputs();
  const back = cams.filter((d) => /back/i.test(d.label))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  let [left, right] = back;
  const current = camStream.getVideoTracks()[0].getSettings().deviceId;
  if (left && right) {
    if (current !== left.deviceId) await useWebcam(left.deviceId, true);
  } else {
    left = cams.find((d) => d.deviceId === current);
    right = cams.find((d) => d.deviceId !== current);
  }
  if (!right) { stopStereo('off - only one camera found'); setStatus('Stereo ' + stereoInfo); return; }
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: right.deviceId }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    lanes[1].stream = s;
    lanes[1].video.srcObject = s;
    await lanes[1].video.play();
    stereoOn = true;
    lanes[0].label = (left && left.label) || 'camera A';
    lanes[1].label = right.label || 'camera B';
    stereoInfo = `on (L: ${lanes[0].label}, R: ${lanes[1].label})`;
  } catch (e) {
    stopStereo('off - right camera failed: ' + e.message);
  }
  setStatus('Stereo ' + stereoInfo);
}

// Per-viewer preferences (camera choice, FOV). Storage can be unavailable; never rely on it.
function loadPref(key) { try { return localStorage.getItem(key); } catch { return null; } }
function savePref(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

// deviceId: a specific camera (from the picker); otherwise the remembered one, else the default.
// fromStereo: called by startStereo itself (don't restart stereo again).
async function useWebcam(deviceId, fromStereo = false) {
  const wanted = deviceId || loadPref('camId');
  const anyCam = { width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    stopCamera();
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: wanted ? { ...anyCam, height: { ideal: 960 }, deviceId: { exact: wanted } } : anyCam, audio: false });
    } catch (e) {
      if (!wanted) throw e;  // remembered camera is gone: fall back to the default one
      camStream = await navigator.mediaDevices.getUserMedia({ video: anyCam, audio: false });
    }
    lanes[0].stream = camStream;
    video.removeAttribute('src');
    video.srcObject = camStream;
    await video.play();
    const label = camStream.getVideoTracks()[0].label;
    setStatus('Webcam' + (label ? ': ' + label : ''));
    await fillCameraList();
    if (!fromStereo && $('stereo').checked) await startStereo();
  } catch (e) {
    setStatus('Webcam failed: ' + e.message);
  }
}

// Camera labels are only available after permission, so fill the picker after the first start.
async function fillCameraList() {
  const sel = $('camSel');
  const cams = await videoInputs();
  const current = camStream && camStream.getVideoTracks()[0].getSettings().deviceId;
  sel.textContent = '';
  cams.forEach((d, i) => sel.add(new Option(d.label || `camera ${i + 1}`, d.deviceId, false, d.deviceId === current)));
  sel.hidden = cams.length < 2;
}

async function useVideoFile(file) {
  stopCamera();
  stopStereo('off (video file: mono only)');
  video.srcObject = null;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  try { await video.play(); setStatus('Video: ' + file.name); }
  catch (e) { setStatus('Cannot play ' + file.name + ': ' + e.message); }
}

function getSourceElement(lane = 0) {
  if (lane === 1 && !stereoOn) return null;
  const v = lanes[lane].video;
  return v.readyState >= 2 && v.videoWidth > 0 ? v : null;
}

// ============================================================================
// eff_int source (swap later for head motion).
// Auto mode: mean absolute frame difference on a small downscaled copy.
// Builds up slowly (~10 s) while still, drops on motion: how fast ("drop time") and how far
// ("drop depth") are panel sliders.
// ============================================================================
const MOTION_W = 32, MOTION_H = 18;
const STILL_DIFF = 0.010;      // mean abs diff (0..1) at or below which we count as still
const MOVING_DIFF = 0.030;     // ... at or above which we count as fully moving
const BUILD_SECONDS = 10.0;

// Panel slider bound to a remembered number; returns a getter.
function prefSlider(id, key, format) {
  const slider = $(id), label = $(id + 'Val');
  const stored = loadPref(key);
  if (stored !== null && stored !== '' && isFinite(stored)) slider.value = stored;
  const show = () => { label.textContent = format(Number(slider.value)); };
  slider.oninput = () => { savePref(key, slider.value); show(); };
  slider.ondblclick = () => { slider.value = slider.defaultValue; savePref(key, slider.value); show(); };
  show();
  return () => Number(slider.value);
}
const dropSeconds = prefSlider('dropTime', 'dropTime', (v) => v.toFixed(1) + ' s');  // time for a full drop
const dropDepth = prefSlider('dropDepth', 'dropDepth', (v) => v.toFixed(2));         // 1 = can fall to 0

const motionCanvas = document.createElement('canvas');
motionCanvas.width = MOTION_W; motionCanvas.height = MOTION_H;
const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
let prevLuma = null;

function measureMotion(src) {
  motionCtx.drawImage(src, 0, 0, MOTION_W, MOTION_H);
  const px = motionCtx.getImageData(0, 0, MOTION_W, MOTION_H).data;
  const n = MOTION_W * MOTION_H;
  const luma = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    luma[i] = (0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]) / 255;
    if (prevLuma) sum += Math.abs(luma[i] - prevLuma[i]);
  }
  const had = prevLuma !== null;
  prevLuma = luma;
  return had ? sum / n : 0;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Motion of the image (0 = still, 1 = moving), from frame differences.
function imageMotion(src) {
  return smoothstep(STILL_DIFF, MOVING_DIFF, measureMotion(src));
}

// Returns the new eff_int given the current one and a motion amount m (0 = still, 1 = moving).
// The flat page passes imageMotion(); the headset mode (xr.js) passes head motion.
// Motion only pulls eff_int down to a floor of (1 - drop depth); below that it keeps building.
function autoEffInt(current, dt, m) {
  const floor = 1 - dropDepth();
  let next = current + (1 - m) * dt / BUILD_SECONDS;
  if (current > floor) next = Math.max(floor, next - m * dt / Math.max(0.05, dropSeconds()));
  return Math.min(1, Math.max(0, next));
}

// ============================================================================
// Shaders
// ============================================================================
const MAX_HEADS = 8;
const HEADER = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_prev;
uniform float u_time;
uniform float u_dt;
uniform vec2 u_look;
uniform vec2 u_gaze;
uniform vec2 u_focus;
uniform vec2 u_focusVel;
uniform float eff_int;
uniform vec2 u_res;
uniform vec4 u_heads[${MAX_HEADS}];
uniform float u_headRoll[${MAX_HEADS}];
uniform int u_headCount;
`;
const HEADER_LINES = HEADER.split('\n').length - 1;
const FOOTER = `
out vec4 harness_fragColor;
void main() { harness_fragColor = effect(gl_FragCoord.xy / u_res); }
`;

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Input pass: draw the source frame into a render target, cropped to fill ("cover").
const SOURCE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform vec2 u_res; uniform vec2 u_scale;
out vec4 o;
void main() { vec2 uv = (gl_FragCoord.xy / u_res - 0.5) * u_scale + 0.5; o = vec4(texture(u_tex, uv).rgb, 1.0); }`;

const COPY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform vec2 u_res;
out vec4 o;
void main() { o = texture(u_tex, gl_FragCoord.xy / u_res); }`;

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) || 'unknown compile error';
    gl.deleteShader(s);
    throw new Error(log);
  }
  return s;
}

let vertShader = null;
// vertSrc: optional custom vertex shader (default: fullscreen triangle).
function linkProgram(fragSrc, vertSrc) {
  if (!vertShader) vertShader = compileShader(gl.VERTEX_SHADER, VERT);
  const vs = vertSrc ? compileShader(gl.VERTEX_SHADER, vertSrc) : vertShader;
  const fs = compileShader(gl.FRAGMENT_SHADER, fragSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(fs);
  if (vertSrc) gl.deleteShader(vs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) || 'unknown link error';
    gl.deleteProgram(p);
    throw new Error(log);
  }
  const u = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { prog: p, u };
}

// Rewrite "ERROR: 0:<line>:" so line numbers match the effect file.
function mapErrorLines(log, fileLineCount) {
  return log.replace(/(ERROR|WARNING):\s*\d+:(\d+):/g, (_, kind, n) => {
    const line = Number(n) - HEADER_LINES;
    return line >= 1 && line <= fileLineCount ? `${kind}: line ${line}:` : `${kind}: (harness code):`;
  }).trim();
}

function compileEffect(src) {
  return linkProgram(HEADER + src + FOOTER);
}

// ============================================================================
// Render targets
// ============================================================================
function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  setTexParams();
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fbo };
}

function freeTarget(t) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

function clearTarget(t) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function setTexParams() {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// ============================================================================
// Effects: discovery, ordering, hot reload
// ============================================================================
/** name -> { name, src, desc, prog, u, error, enabled, params, rts: per lane [a, b], cur: per lane index } */
const effects = new Map();
const enabledState = new Map();  // remembers checkbox state across reloads
const paramState = new Map();    // "file:uniform" -> slider value the user set (survives reloads)
const openParams = new Set();    // effect names whose "parameters" list is expanded (survives reloads)
let chain = [];                  // ordered list of effect objects
let orderText = null;
let rtW = 0, rtH = 0;

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

function parseOrder(text) {
  if (!text) return [];
  return text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.endsWith('.glsl') ? l : l + '.glsl'));
}

// order.txt entries first (in that order, skipping unknown names), then the rest alphabetically.
function computeOrder(names, order) {
  const known = new Set(names);
  const seen = new Set();
  const out = [];
  for (const n of order) if (known.has(n) && !seen.has(n)) { seen.add(n); out.push(n); }
  for (const n of [...names].sort()) if (!seen.has(n)) out.push(n);
  return out;
}

const COMMENT_RE = /^\s*\/\/ ?(.*)$/;

// Comment lines -> text: lines are joined into paragraphs, an empty "//" line starts a new one.
function joinComment(lines) {
  const paras = [[]];
  for (const l of lines.map((s) => s.trim())) {
    if (l) paras[paras.length - 1].push(l);
    else if (paras[paras.length - 1].length) paras.push([]);
  }
  return paras.filter((p) => p.length).map((p) => p.join(' ')).join('\n\n');
}

// Effect description: the comment block at the very top of the file (ends at the first non-comment line).
function parseDescription(src) {
  const lines = [];
  for (const l of src.split(/\r?\n/)) {
    const m = l.match(COMMENT_RE);
    if (!m) break;
    lines.push(m[1]);
  }
  return joinComment(lines);
}

// Per-effect parameters, declared in the effect file as a slider:
//   uniform float <name>; // @param <min> <max> <default> <description>
// as a whole-number slider (steps of 1, e.g. a count):
//   uniform float <name>; // @int <min> <max> <default> <description>
// or as a dropdown (the uniform gets the option's index 0, 1, 2, ...; the first is the default):
//   uniform float <name>; // @choice <option>|<option>|... <description>
// A comment-only line below can show the parameter only for one value of another parameter:
//   // @when <other parameter>=<option name, or number>
// Comment-only lines directly below continue the description.
const PARAM_RE = /^\s*uniform\s+float\s+(\w+)\s*;\s*\/\/\s*@(param|choice|int)\b(.*)$/;

function parseParams(name, src) {
  const out = [];
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(PARAM_RE);
    if (!m) return;
    let q;
    if (m[2] === 'choice') {
      const [opts = '', ...words] = m[3].trim().split(/\s+/);
      const choices = opts.split('|').filter(Boolean);
      if (choices.length < 2) {
        console.warn(`[${name}] ignoring "@choice" for ${m[1]}: expected "@choice <option>|<option>|... <description>"`);
        return;
      }
      q = { name: m[1], min: 0, max: choices.length - 1, def: 0, choices, words };
    } else {
      const [min, max, def, ...words] = m[3].trim().split(/\s+/);
      const [lo, hi, d] = [min, max, def].map(Number);
      const whole = m[2] === 'int';
      if (![lo, hi, d].every(Number.isFinite) || !(hi > lo) || (whole && ![lo, hi].every(Number.isInteger))) {
        console.warn(`[${name}] ignoring "@${m[2]}" for ${m[1]}: expected "@${m[2]} <min> <max> <default> <description>"${whole ? ' with whole numbers as min and max' : ''}`);
        return;
      }
      q = { name: m[1], min: lo, max: hi, def: clamp(whole ? Math.round(d) : d, lo, hi), words };
      if (whole) q.int = true;
    }
    const desc = [q.words.join(' ')];
    delete q.words;
    for (let j = i + 1; j < lines.length; j++) {
      const c = lines[j].match(COMMENT_RE);
      if (!c) break;
      const w = c[1].match(/^@when\s+(\w+)\s*=\s*(\S+)\s*$/);
      if (w) q.when = { name: w[1], value: w[2] };
      else desc.push(c[1]);
    }
    q.desc = joinComment(desc);
    out.push(q);
  });
  return out;
}

function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

function loadEffect(name, src) {
  let e = effects.get(name);
  if (!e) {
    e = { name, src: null, prog: null, u: null, error: null, params: [], rts: [[null, null], [null, null]], cur: [0, 0],
          strength: loadStrength(name) };
    effects.set(name, e);
  }
  if (e.prog) gl.deleteProgram(e.prog);
  e.src = src; e.prog = null; e.u = null; e.error = null;
  e.desc = parseDescription(src);
  try {
    const p = compileEffect(src);
    e.prog = p.prog; e.u = p.u;
  } catch (err) {
    e.error = mapErrorLines(err.message, src.split('\n').length);
    console.warn(`[${name}]\n${e.error}`);
  }
  // Untouched sliders follow the file's default; ones the user moved keep their value.
  e.params = parseParams(name, src).map((q) => {
    const key = name + ':' + q.name;
    return {
      ...q,
      key,
      value: paramState.has(key) ? clamp(paramState.get(key), q.min, q.max) : q.def,
      loc: e.prog ? gl.getUniformLocation(e.prog, q.name) : null,
    };
  });
  e.enabled = enabledState.has(name) ? enabledState.get(name) : false;   // new effects start unticked
  resetFeedback(e);
}

function unloadEffect(name) {
  const e = effects.get(name);
  if (!e) return;
  if (e.prog) gl.deleteProgram(e.prog);
  freeEffectTargets(e);
  effects.delete(name);
}

function freeEffectTargets(e) {
  for (const pair of e.rts) { freeTarget(pair[0]); freeTarget(pair[1]); }
  e.rts = [[null, null], [null, null]];
}

function resetFeedback(e) {
  for (const pair of e.rts) for (const t of pair) if (t) clearTarget(t);
}

let polling = false;
async function poll() {
  if (polling || !gl) return;
  polling = true;
  try {
    const listText = await fetchText('effects.json');
    if (listText === null) { setStatus('Could not load effects.json (run: python3 serve.py)'); return; }
    let names = JSON.parse(listText).filter((n) => n.endsWith('.glsl') && !n.startsWith('_'));
    const [newOrder, ...sources] = await Promise.all([
      fetchText('effects/order.txt'),
      ...names.map((n) => fetchText('effects/' + encodeURIComponent(n))),
    ]);

    let changed = newOrder !== orderText;
    orderText = newOrder;
    const present = new Set();
    names.forEach((n, i) => {
      if (sources[i] === null) return;  // listed but unreadable: treat as missing
      present.add(n);
      const e = effects.get(n);
      if (!e || e.src !== sources[i]) { loadEffect(n, sources[i]); changed = true; }
    });
    for (const n of [...effects.keys()]) if (!present.has(n)) { unloadEffect(n); changed = true; }

    if (changed) {
      chain = computeOrder([...present], parseOrder(orderText)).map((n) => effects.get(n));
      renderPanel();
    }
  } catch (err) {
    console.error(err);
  } finally {
    polling = false;
  }
}

// ============================================================================
// Panel
// ============================================================================
function setStatus(msg) { $('status').textContent = msg; }

// Description bubble: click an effect or parameter name to open it; click it again,
// click anywhere else or press Escape to close.
const bubble = $('bubble');
let bubbleAnchor = null;

function toggleBubble(anchor, text, meta) {
  if (bubbleAnchor === anchor) { hideBubble(); return; }
  bubbleAnchor = anchor;
  bubble.textContent = text;
  if (meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = meta;
    bubble.append(m);
  }
  bubble.hidden = false;
  const r = anchor.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const top = r.bottom + 4 + b.height > innerHeight ? r.top - 4 - b.height : r.bottom + 4;
  bubble.style.left = Math.max(8, Math.min(r.left, innerWidth - b.width - 8)) + 'px';
  bubble.style.top = Math.max(8, top) + 'px';
}

function hideBubble() { bubble.hidden = true; bubbleAnchor = null; }

function clickableName(text, onclick) {
  const s = document.createElement('span');
  s.className = 'name';
  s.textContent = text;
  s.onclick = onclick;
  return s;
}

window.addEventListener('pointerdown', (ev) => {
  if (!bubble.hidden && !bubble.contains(ev.target) && ev.target !== bubbleAnchor) hideBubble();
});
$('panel').addEventListener('scroll', hideBubble);

function renderPanel() {
  hideBubble();
  const ol = $('effects');
  ol.textContent = '';
  if (!chain.length) {
    ol.innerHTML = '<li><i>no effects found in effects/</i></li>';
    return;
  }
  for (const e of chain) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = e.enabled;
    cb.onchange = () => {
      e.enabled = cb.checked;
      enabledState.set(e.name, cb.checked);
      if (cb.checked) resetFeedback(e);
    };
    const title = clickableName(e.name.replace(/\.glsl$/, ''), () => toggleBubble(title,
      e.desc || 'No description yet.',
      e.desc ? 'effects/' + e.name : `Add one as a comment block at the very top of effects/${e.name}.`));
    li.append(cb, ' ', title, strengthRow(e));
    if (!e.error && e.params.length) {
      // "parameters" button next to the name: shows/hides this effect's sliders.
      const box = document.createElement('div');
      box.className = 'params';
      box.hidden = !openParams.has(e.name);
      const btn = document.createElement('button');
      btn.className = 'paramsBtn';
      const shown = () => e.params.filter((q) => !q.row || q.row.style.display !== 'none').length;
      const label = () => { btn.textContent = `parameters (${shown()}) ${box.hidden ? '▸' : '▾'}`; };
      const refresh = () => { applyWhen(e.params); label(); };
      for (const q of e.params) { q.changed = refresh; q.row = box.appendChild(paramRow(q)); }
      applyWhen(e.params);
      btn.onclick = () => {
        hideBubble();
        box.hidden = !box.hidden;
        if (box.hidden) openParams.delete(e.name); else openParams.add(e.name);
        label();
      };
      label();
      li.append(' ', btn, box);
    }
    if (e.error) {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = 'compile error (skipped):\n' + e.error;
      li.append(err);
    }
    ol.append(li);
  }
  const orderNote = document.createElement('li');
  orderNote.className = 'note';
  orderNote.textContent = orderText === null ? 'order: no order.txt (alphabetical)' : 'order: from order.txt, then alphabetical';
  ol.append(orderNote);
}

// Per-effect strength: multiplies the shared eff_int for this effect (0..2, default 1),
// remembered per effect in this browser. Double-click the slider to reset to 1.
function loadStrength(name) {
  const v = Number(loadPref('strength:' + name));
  return loadPref('strength:' + name) !== null && Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 1;
}

function strengthRow(e) {
  const row = document.createElement('div');
  row.className = 'row param';
  const name = document.createElement('span');
  name.textContent = 'strength';
  name.title = 'This effect gets eff_int x strength (capped at 1). 0 = off, 1 = normal, 2 = full strength at half eff_int.';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0; slider.max = 2; slider.step = 0.01;
  slider.value = e.strength;
  slider.title = '0 .. 2, default 1 (double-click to reset)';
  const val = document.createElement('span');
  val.className = 'val';
  const show = () => { val.textContent = e.strength.toFixed(2); };
  const set = (v) => { e.strength = v; savePref('strength:' + e.name, v); show(); };
  slider.oninput = () => set(Number(slider.value));
  slider.ondblclick = () => { slider.value = 1; set(1); };
  show();
  row.append(name, slider, val);
  return row;
}

// Hide the parameters whose "@when <other>=<value>" doesn't hold right now.
function applyWhen(params) {
  for (const q of params) {
    if (!q.when || !q.row) continue;
    const other = params.find((o) => o.name === q.when.name);
    let want = Number(q.when.value);
    if (other && other.choices && !Number.isFinite(want)) want = other.choices.indexOf(q.when.value);
    q.row.style.display = other && Math.round(other.value) === want ? '' : 'none';
  }
}

// One slider row for an effect parameter. Double-click the slider to reset to the default.
function paramRow(q) {
  if (q.choices) return choiceRow(q);
  const row = document.createElement('div');
  row.className = 'row param';
  const range = `${q.min} .. ${q.max}, default ${q.def} (double-click the slider to reset)`;
  const name = clickableName(q.name, () => toggleBubble(name,
    q.desc || 'No description yet.',
    q.desc ? range : range + '\nAdd one after the numbers on the @param line.'));
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = q.min; slider.max = q.max; slider.step = q.int ? 1 : (q.max - q.min) / 1000;
  slider.value = q.value;
  slider.title = range;
  const val = document.createElement('span');
  val.className = 'val';
  const show = () => { val.textContent = q.value.toFixed(q.int ? 0 : 2); };
  slider.oninput = () => { q.value = Number(slider.value); paramState.set(q.key, q.value); show(); if (q.changed) q.changed(); };
  slider.ondblclick = () => { q.value = q.def; slider.value = q.def; paramState.delete(q.key); show(); if (q.changed) q.changed(); };
  show();
  row.append(name, slider, val);
  return row;
}

// Dropdown row for an "@choice" parameter; the uniform gets the selected option's index.
function choiceRow(q) {
  const row = document.createElement('div');
  row.className = 'row param';
  const range = `options: ${q.choices.join(', ')}; default ${q.choices[0]}`;
  const name = clickableName(q.name, () => toggleBubble(name,
    q.desc || 'No description yet.',
    q.desc ? range : range + '\nAdd one after the options on the @choice line.'));
  const sel = document.createElement('select');
  q.choices.forEach((c, i) => sel.add(new Option(c, i, false, i === Math.round(q.value))));
  sel.onchange = () => {
    q.value = Number(sel.value);
    if (q.value === q.def) paramState.delete(q.key); else paramState.set(q.key, q.value);
    if (q.changed) q.changed();
  };
  row.append(name, sel);
  return row;
}

const effIntSlider = $('effInt');
const autoBox = $('auto');
let effInt = Number(effIntSlider.value);
effIntSlider.oninput = () => { effInt = Number(effIntSlider.value); };
autoBox.onchange = () => { effIntSlider.disabled = autoBox.checked; prevLuma = null; };

$('camBtn').onclick = () => useWebcam();
$('stereo').checked = loadPref('stereo') === '1';
$('swapEyes').checked = loadPref('swapEyes') === '1';
$('stereo').onchange = (ev) => {
  savePref('stereo', ev.target.checked ? '1' : '0');
  if (ev.target.checked) startStereo(); else { stopStereo(); setStatus('Stereo off'); }
};
$('swapEyes').onchange = (ev) => savePref('swapEyes', ev.target.checked ? '1' : '0');
$('camSel').onchange = (ev) => { savePref('camId', ev.target.value); useWebcam(ev.target.value); };
$('fileIn').onchange = (ev) => { const f = ev.target.files[0]; if (f) useVideoFile(f); };

// Call mode: fixed 16:9 output + hidden chrome for OBS Virtual Camera / Window Capture.
const CALL_SIZES = { '720': [1280, 720], '1080': [1920, 1080] };
let callMode = false;
let callSizeKey = loadPref('callSize') === '1080' ? '1080' : '720';
let callHintTimer = 0;
$('callSize').value = callSizeKey;
$('callSize').onchange = (ev) => {
  callSizeKey = ev.target.value === '1080' ? '1080' : '720';
  savePref('callSize', callSizeKey);
  if (callMode) resize();
};
function showCallHint() {
  const hint = $('callHint');
  const [w, h] = CALL_SIZES[callSizeKey];
  hint.textContent = `Call mode ${w}×${h} · H = panel · Esc = exit`;
  hint.hidden = false;
  hint.classList.add('show');
  clearTimeout(callHintTimer);
  callHintTimer = setTimeout(() => hint.classList.remove('show'), 4000);
}
function setCallMode(on) {
  callMode = !!on;
  $('callMode').checked = callMode;
  document.body.classList.toggle('call-mode', callMode);
  document.body.classList.remove('show-ui');
  hideBubble();
  if (callMode) {
    $('panel').classList.remove('hidden'); // visibility is CSS via body.call-mode
    showCallHint();
  } else {
    $('callHint').hidden = true;
    $('callHint').classList.remove('show');
  }
  resize();
}
$('callMode').onchange = (ev) => setCallMode(ev.target.checked);
$('toggle').onclick = () => {
  hideBubble();
  if (callMode) document.body.classList.toggle('show-ui');
  else $('panel').classList.toggle('hidden');
};
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (callMode) { setCallMode(false); return; }
    hideBubble();
    return;
  }
  if (ev.key === 'h' || ev.key === 'H') {
    hideBubble();
    if (callMode) document.body.classList.toggle('show-ui');
    else $('panel').classList.toggle('hidden');
  }
});
{
  const q = new URLSearchParams(location.search).get('call');
  if (q !== null) {
    if (q === '1080' || q === '720') { callSizeKey = q; $('callSize').value = q; savePref('callSize', q); }
    setCallMode(true);
  }
}
window.addEventListener('dragover', (ev) => { ev.preventDefault(); document.body.classList.add('drag'); });
window.addEventListener('dragleave', () => document.body.classList.remove('drag'));
window.addEventListener('drop', (ev) => {
  ev.preventDefault();
  document.body.classList.remove('drag');
  const f = [...ev.dataTransfer.files].find((x) => x.type.startsWith('video/')) || ev.dataTransfer.files[0];
  if (f) useVideoFile(f);
});

// ============================================================================
// Render loop
// ============================================================================
let sourceProg, copyProg;
const sourceTex = [null, null];   // per lane: uploaded camera frame
const uploadedFrame = [-1, -1];   // per lane: camera frame count at the last upload
const uploadedSrc = [null, null];
const CALLBACK_STALE_MS = 100;    // no new-frame callback for this long: upload every frame
const sourceRT = [null, null];    // per lane: cover-fitted input to the chain

function initGL() {
  sourceProg = linkProgram(SOURCE_FRAG);
  copyProg = linkProgram(COPY_FRAG);
  gl.bindVertexArray(gl.createVertexArray());
  for (let i = 0; i < 2; i++) {
    sourceTex[i] = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTex[i]);
    setTexParams();
  }
}

// Fit (w, h) inside MAX_DIM, keeping the aspect ratio.
function capSize(w, h) {
  const s = Math.min(1, MAX_DIM / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// Flat page: render targets match the canvas. Call mode locks to a fixed 16:9 size (no DPR).
function resize() {
  if (callMode) {
    const [w, h] = CALL_SIZES[callSizeKey] || CALL_SIZES['720'];
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    setTargetSize(w, h);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const [w, h] = capSize(Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  setTargetSize(w, h);
}

// (Re)create all render targets at w x h. Headset mode sizes them to the camera instead.
function setTargetSize(w, h) {
  if (w === rtW && h === rtH) return;
  rtW = w; rtH = h;
  for (let i = 0; i < 2; i++) { freeTarget(sourceRT[i]); sourceRT[i] = null; }
  for (const e of effects.values()) freeEffectTargets(e);
}

// Targets are created on first use, so the right-eye lane costs nothing in mono.
function ensureTargets(e, lane) {
  if (!e.rts[lane][0]) e.rts[lane] = [makeTarget(rtW, rtH), makeTarget(rtW, rtH)];
}

function bindTex(unit, tex) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
}

function draw(p, fbo, inTex, prevTex, time) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, rtW, rtH);
  gl.useProgram(p.prog);
  bindTex(0, inTex); gl.uniform1i(p.u.u_tex, 0);
  if (p.u.u_prev) { bindTex(1, prevTex); gl.uniform1i(p.u.u_prev, 1); }
  gl.uniform1f(p.u.u_time, time);
  gl.uniform1f(p.u.u_dt, frameDt);
  gl.uniform2f(p.u.u_look, headLook[0], headLook[1]);
  gl.uniform2f(p.u.u_gaze, headGaze[0], headGaze[1]);
  gl.uniform2f(p.u.u_focus, focus.pos[0], focus.pos[1]);
  gl.uniform2f(p.u.u_focusVel, focus.vel[0], focus.vel[1]);
  // Per-effect strength (0..2) scales the shared eff_int; clamped so effects still get 0..1,
  // and eff_int = 0 stays 0 whatever the strength.
  gl.uniform1f(p.u.eff_int, Math.min(1, effInt * (p.strength === undefined ? 1 : p.strength)));
  gl.uniform2f(p.u.u_res, rtW, rtH);
  if (p.params) for (const q of p.params) if (q.loc) gl.uniform1f(q.loc, q.value);
  if (p.u['u_heads[0]']) {
    gl.uniform4fv(p.u['u_heads[0]'], headData);
    if (p.u['u_headRoll[0]']) gl.uniform1fv(p.u['u_headRoll[0]'], headRoll);
    gl.uniform1i(p.u.u_headCount, headCount);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// Heads for the lane being rendered, in render-target coordinates (see heads.js):
// u_heads[i] = (center uv, radius in uv height units, alpha 0..1), u_headRoll[i] = tilt in radians.
const headData = new Float32Array(4 * MAX_HEADS);
const headRoll = new Float32Array(MAX_HEADS);
let headCount = 0;

// tracks: from getHeads(), in video coordinates; (sx, sy): the source pass's cover-fit scale.
function setHeads(tracks, sx, sy) {
  headCount = Math.min(tracks.length, MAX_HEADS);
  for (let i = 0; i < headCount; i++) {
    const h = tracks[i];
    headData.set([(h.x - 0.5) / sx + 0.5, (h.y - 0.5) / sy + 0.5, h.r / sy, h.alpha], 4 * i);
    headRoll[i] = h.roll;
  }
}

const startTime = performance.now();
let lastNow = startTime;
let xrSession = null;   // set by xr.js while the headset mode is active

// ============================================================================
// Head direction for effects (u_look, u_gaze). xr.js feeds the headset's head
// direction at camera-capture time; the flat page simulates it with a mouse drag
// on the video (hold the button: the pointer position is where you "face").
//   u_look: how far the scene has shifted across the image because the head
//           turned (uv units). Effects that sample their pattern at
//           uv - u_look keep it attached to the scene instead of the screen.
//   u_gaze: which way the head is turning relative to a few seconds ago,
//           -1..1 per axis (+x = right, +y = up); recenters when the head rests.
// ============================================================================
const GAZE_RECENTER = 2.5;     // s for u_gaze to settle back to 0 after a turn
const GAZE_RANGE = 20;         // degrees of turn that give u_gaze = 1
let headLook = [0, 0], headGaze = [0, 0];
const headState = { yaw: null, accYaw: 0, refYaw: 0, refPitch: 0 };
const simHead = { active: false, yaw: 0, pitch: 0, sy: 0, sp: 0 };   // flat-page mouse stand-in

// yaw/pitch in radians (+yaw = turned right, +pitch = up), hfovDeg = camera horizontal FOV
function updateHead(yaw, pitch, hfovDeg, dt) {
  const s = headState;
  if (s.yaw === null) { s.yaw = yaw; s.accYaw = yaw; s.refYaw = yaw; s.refPitch = pitch; }
  let dy = yaw - s.yaw;                             // unwrap across +-180 deg
  if (dy > Math.PI) dy -= 2 * Math.PI;
  if (dy < -Math.PI) dy += 2 * Math.PI;
  s.yaw = yaw;
  s.accYaw += dy;
  const f = 0.5 / Math.tan((hfovDeg / 2) * Math.PI / 180);   // uv per radian (small angles)
  headLook = [-s.accYaw * f, -pitch * f * (rtW / Math.max(rtH, 1))];
  const k = 1 - Math.exp(-dt / GAZE_RECENTER);
  s.refYaw += (s.accYaw - s.refYaw) * k;
  s.refPitch += (pitch - s.refPitch) * k;
  const r = GAZE_RANGE * Math.PI / 180;
  const c = (v) => Math.max(-1, Math.min(1, v));
  headGaze = [c((s.accYaw - s.refYaw) / r), c((pitch - s.refPitch) / r)];
}
// ============================================================================
// Main object in view (u_focus): uv of the biggest / closest-looking object,
// smoothed so it glides after it as things move. No depth camera, so this is a
// heuristic on a tiny copy of the frame: every pixel is scored by how different
// its color is from the background (the frame border's average), its local
// contrast and its motion; the connected region with the largest total score
// wins (big + distinct + moving ~ close to the camera). Its weighted center is
// the target. Runs at FOCUS_HZ on lane 0 only (both eyes share it).
// ============================================================================
const FOCUS_W = 48, FOCUS_H = 27;
const FOCUS_HZ = 20;           // analyses per second
const FOCUS_TARGET_SMOOTH = 0.3;    // s, low-pass on the detected target (detection is jumpy)
const FOCUS_DEADZONE = 0.02;   // uv; target moves smaller than this are ignored (no wobble)
const FOCUS_SETTLE = 0.45;     // s, time scale of the critically damped spring that moves u_focus
const focusCanvas = document.createElement('canvas');
focusCanvas.width = FOCUS_W; focusCanvas.height = FOCUS_H;
const focusCtx = focusCanvas.getContext('2d', { willReadFrequently: true });
const focus = { pos: [0.5, 0.5], vel: [0, 0], target: [0.5, 0.5], goal: [0.5, 0.5], prevL: null, last: -1 };

function findFocusTarget(src) {
  focusCtx.drawImage(src, 0, 0, FOCUS_W, FOCUS_H);
  const px = focusCtx.getImageData(0, 0, FOCUS_W, FOCUS_H).data;
  const n = FOCUS_W * FOCUS_H, L = new Float32Array(n), S = new Float32Array(n);
  // background estimate = average color of the border pixels
  let br = 0, bg = 0, bb = 0, bc = 0;
  for (let y = 0; y < FOCUS_H; y++) for (let x = 0; x < FOCUS_W; x++) {
    const i = y * FOCUS_W + x, o = 4 * i;
    L[i] = (0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]) / 255;
    if (x === 0 || y === 0 || x === FOCUS_W - 1 || y === FOCUS_H - 1) {
      br += px[o]; bg += px[o + 1]; bb += px[o + 2]; bc++;
    }
  }
  br /= bc; bg /= bc; bb /= bc;
  let mean = 0;
  for (let y = 0; y < FOCUS_H; y++) for (let x = 0; x < FOCUS_W; x++) {
    const i = y * FOCUS_W + x, o = 4 * i;
    const dc = Math.hypot(px[o] - br, px[o + 1] - bg, px[o + 2] - bb) / 255;
    const gx = L[y * FOCUS_W + Math.min(x + 1, FOCUS_W - 1)] - L[y * FOCUS_W + Math.max(x - 1, 0)];
    const gy = L[Math.min(y + 1, FOCUS_H - 1) * FOCUS_W + x] - L[Math.max(y - 1, 0) * FOCUS_W + x];
    const mo = focus.prevL ? Math.abs(L[i] - focus.prevL[i]) : 0;
    S[i] = dc + 0.5 * Math.hypot(gx, gy) + 2.0 * mo;
    mean += S[i];
  }
  focus.prevL = L;
  mean /= n;
  let vr = 0;
  for (let i = 0; i < n; i++) vr += (S[i] - mean) * (S[i] - mean);
  const thr = Math.max(0.12, mean + 0.5 * Math.sqrt(vr / n));
  // connected regions above the threshold; keep the one with the largest total score
  const seen = new Uint8Array(n), stack = new Int32Array(n);
  let best = 0, bx = 0.5, by = 0.5;
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0] || S[s0] < thr) continue;
    let top = 0, sum = 0, sx = 0, sy = 0;
    stack[top++] = s0; seen[s0] = 1;
    while (top) {
      const i = stack[--top], x = i % FOCUS_W, y = (i - x) / FOCUS_W, w = S[i];
      sum += w; sx += w * (x + 0.5); sy += w * (y + 0.5);
      if (x > 0 && !seen[i - 1] && S[i - 1] >= thr) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < FOCUS_W - 1 && !seen[i + 1] && S[i + 1] >= thr) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !seen[i - FOCUS_W] && S[i - FOCUS_W] >= thr) { seen[i - FOCUS_W] = 1; stack[top++] = i - FOCUS_W; }
      if (y < FOCUS_H - 1 && !seen[i + FOCUS_W] && S[i + FOCUS_W] >= thr) { seen[i + FOCUS_W] = 1; stack[top++] = i + FOCUS_W; }
    }
    if (sum > best) { best = sum; bx = sx / sum / FOCUS_W; by = 1 - sy / sum / FOCUS_H; }   // uv: y up
  }
  return [bx, by];
}

// Only effects that read u_focus / u_focusVel need the analysis (unused uniforms are inactive).
function focusWanted() {
  return chain.some((e) => e.enabled && e.prog && (e.u.u_focus || e.u.u_focusVel));
}

function updateFocus(src, time, dt) {
  if (time - focus.last >= 1 / FOCUS_HZ || focus.last < 0 || time < focus.last) {
    focus.last = time;
    try { focus.target = findFocusTarget(src); } catch (e) { /* e.g. frame not ready: keep target */ }
  }
  if (dt <= 0) return;
  // 1) smooth the jumpy detection into a goal, ignoring tiny changes
  const kt = 1 - Math.exp(-dt / FOCUS_TARGET_SMOOTH);
  if (Math.hypot(focus.target[0] - focus.goal[0], focus.target[1] - focus.goal[1]) > FOCUS_DEADZONE) {
    focus.goal[0] += (focus.target[0] - focus.goal[0]) * kt;
    focus.goal[1] += (focus.target[1] - focus.goal[1]) * kt;
  }
  // 2) critically damped spring toward the goal: eases in and out, never overshoots.
  //    Sub-stepped so it stays stable at any frame rate.
  const w = 1 / FOCUS_SETTLE, steps = Math.ceil(dt / 0.01), h = dt / steps;
  for (let s = 0; s < steps; s++) {
    for (let a = 0; a < 2; a++) {
      const acc = w * w * (focus.goal[a] - focus.pos[a]) - 2 * w * focus.vel[a];
      focus.vel[a] += acc * h;
      focus.pos[a] += focus.vel[a] * h;
    }
  }
}

function resetHead() { headState.yaw = null; headLook = [0, 0]; headGaze = [0, 0]; }

canvas.addEventListener('pointerdown', (ev) => { simHead.active = true; simPointer(ev); });
canvas.addEventListener('pointermove', (ev) => { if (simHead.active) simPointer(ev); });
window.addEventListener('pointerup', () => { simHead.active = false; simHead.yaw = 0; simHead.pitch = 0; });
function simPointer(ev) {
  const r = canvas.getBoundingClientRect();
  simHead.yaw = ((ev.clientX - r.left) / r.width - 0.5) * 60 * Math.PI / 180;
  simHead.pitch = (0.5 - (ev.clientY - r.top) / r.height) * 34 * Math.PI / 180;
}
let frameDt = 0;               // seconds since the previous chain render (clamped), for u_dt
let lastChainTime = null;

function showEffInt() {
  if (autoBox.checked) effIntSlider.value = effInt;
  $('effIntVal').textContent = effInt.toFixed(2);
}

// Stats readout, twice a second: camera size and fps (per eye in stereo), render fps.
const stats = { renderFrames: 0, t0: performance.now(), cam0: [0, 0] };
setInterval(() => {
  const now = performance.now(), secs = (now - stats.t0) / 1000;
  const fps = lanes.map((l, i) => (l.frames.count - stats.cam0[i]) / secs);
  const renderFps = stats.renderFrames / secs;
  stats.t0 = now; stats.cam0 = lanes.map((l) => l.frames.count); stats.renderFrames = 0;
  const cams = stereoOn ? `L ${fps[0].toFixed(0)} / R ${fps[1].toFixed(0)} fps` : `${fps[0].toFixed(0)} fps`;
  $('stats').textContent = video.videoWidth
    ? `camera ${video.videoWidth}x${video.videoHeight} @ ${cams} · render ${rtW}x${rtH} @ ${renderFps.toFixed(0)} fps · stereo ${stereoInfo}` +
      (callMode ? ' · call' : '') +
      (headsInfo() ? ' · ' + headsInfo() : '')
    : '';
}, 500);

// Flat page loop: chain -> canvas.
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (xrSession) return;
  stats.renderFrames++;
  resize();

  const src = getSourceElement();
  if (src && autoBox.checked) effInt = autoEffInt(effInt, dt, imageMotion(src));
  showEffInt();
  if (typeof updateSoundtrack === 'function') updateSoundtrack(effInt, dt);
  // Mouse stand-in for head direction, eased like a real head turn.
  const ease = 1 - Math.exp(-dt / 0.15);
  simHead.sy += (simHead.yaw - simHead.sy) * ease;
  simHead.sp += (simHead.pitch - simHead.sp) * ease;
  updateHead(simHead.sy, simHead.sp, 70, dt);

  const out = renderChain((now - startTime) / 1000);
  if (!out) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  draw(copyProg, null, out, null, 0);
  if (typeof recCaptureFlat === 'function') recCaptureFlat();   // recording (record.js)
}

// Upload the lane's current frame and run the effect chain into that lane's render targets
// (each lane = eye has its own feedback state). Returns the final texture, or null.
function renderChain(time, lane = 0) {
  // u_dt: time since the previous frame. Only lane 0 advances it, so the right eye
  // (rendered right after, same frame) gets the same u_dt instead of 0.
  if (lane === 0) {
    frameDt = lastChainTime === null ? 0 : Math.min(0.1, Math.max(0, time - lastChainTime));
    lastChainTime = time;
  }
  const src = getSourceElement(lane);
  if (!src) return null;
  // u_focus analysis reads pixels back from the GPU (a stall, ~20x a second): only when used.
  if (lane === 0 && focusWanted()) updateFocus(src, time, frameDt);
  if (!sourceRT[lane]) sourceRT[lane] = makeTarget(rtW, rtH);

  // Upload frame (flipped so uv (0,0) is bottom-left, like Shadertoy). Only when the camera
  // delivered a new frame: the display runs at 72-90 fps, the camera at ~30, and re-uploading
  // the same 1280x960 picture (twice in stereo) is a big part of the frame time on the headset.
  // If the callbacks stop (no frame callbacks at all, or the headset pauses them inside VR),
  // upload every frame instead, or the picture would freeze between rare callbacks.
  const fr = lanes[lane].frames, fc = fr.count;
  const callbacksStale = !fc || performance.now() - fr.at > CALLBACK_STALE_MS;
  if (callbacksStale || fc !== uploadedFrame[lane] || src !== uploadedSrc[lane]) {
    uploadedFrame[lane] = fc;
    uploadedSrc[lane] = src;
    bindTex(0, sourceTex[lane]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  // Source pass: cover-fit into the first render target ((1,1) when the aspects match).
  const ca = rtW / rtH, va = src.videoWidth / src.videoHeight;
  const sx = ca > va ? 1 : ca / va, sy = ca > va ? va / ca : 1;
  gl.useProgram(sourceProg.prog);
  gl.uniform2f(sourceProg.u.u_scale, sx, sy);
  draw(sourceProg, sourceRT[lane].fbo, sourceTex[lane], null, time);

  updateHeads(lane, src, performance.now());
  setHeads(getHeads(lane), sx, sy);

  // Effect chain.
  let input = sourceRT[lane].tex;
  for (const e of chain) {
    if (!e.enabled || !e.prog) continue;
    ensureTargets(e, lane);
    const c = e.cur[lane], write = e.rts[lane][c], prev = e.rts[lane][1 - c];
    draw(e, write.fbo, input, prev.tex, time);
    e.cur[lane] = 1 - c;
    input = write.tex;
  }
  return input;
}

if (gl) {
  initGL();
  poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
}
