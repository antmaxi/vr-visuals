'use strict';
// Effect harness: input -> chain of GLSL effects -> screen. Plain WebGL2, no build step.

const POLL_MS = 1000;
const MAX_DIM = 1920;          // cap on render-target size (longest side, in pixels)

const $ = (id) => document.getElementById(id);
const canvas = $('out');
const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
if (!gl) document.body.innerHTML = '<p style="color:#fff;padding:20px">WebGL2 is not available in this browser.</p>';

// ============================================================================
// Input source (swap later for the headset camera).
// Must provide: getSourceElement() -> a video/canvas/image ready to upload, or null.
// ============================================================================
const video = document.createElement('video');
video.muted = true; video.loop = true; video.playsInline = true;
let camStream = null;

function stopCamera() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
}

// Per-viewer preferences (camera choice, FOV). Storage can be unavailable; never rely on it.
function loadPref(key) { try { return localStorage.getItem(key); } catch { return null; } }
function savePref(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

// deviceId: a specific camera (from the picker); otherwise the remembered one, else the default.
async function useWebcam(deviceId) {
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
    video.removeAttribute('src');
    video.srcObject = camStream;
    await video.play();
    const label = camStream.getVideoTracks()[0].label;
    setStatus('Webcam' + (label ? ': ' + label : ''));
    await fillCameraList();
  } catch (e) {
    setStatus('Webcam failed: ' + e.message);
  }
}

// Camera labels are only available after permission, so fill the picker after the first start.
async function fillCameraList() {
  const sel = $('camSel');
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const current = camStream && camStream.getVideoTracks()[0].getSettings().deviceId;
  sel.textContent = '';
  cams.forEach((d, i) => sel.add(new Option(d.label || `camera ${i + 1}`, d.deviceId, false, d.deviceId === current)));
  sel.hidden = cams.length < 2;
}

async function useVideoFile(file) {
  stopCamera();
  video.srcObject = null;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  try { await video.play(); setStatus('Video: ' + file.name); }
  catch (e) { setStatus('Cannot play ' + file.name + ': ' + e.message); }
}

function getSourceElement() {
  return video.readyState >= 2 && video.videoWidth > 0 ? video : null;
}

// New-frame timing from the browser (used for the fps readout and headset reprojection).
// presentationTime is on the performance.now() clock.
const camFrames = { count: 0, presentationTime: 0 };
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  const onFrame = (now, meta) => {
    camFrames.count++;
    camFrames.presentationTime = meta.presentationTime || now;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

// ============================================================================
// eff_int source (swap later for head motion).
// Auto mode: mean absolute frame difference on a small downscaled copy.
// Builds up slowly (~10 s) while still, drops fast (~0.3 s) on motion.
// ============================================================================
const MOTION_W = 32, MOTION_H = 18;
const STILL_DIFF = 0.010;      // mean abs diff (0..1) at or below which we count as still
const MOVING_DIFF = 0.030;     // ... at or above which we count as fully moving
const BUILD_SECONDS = 10.0;
const DROP_SECONDS = 0.3;

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
function autoEffInt(current, dt, m) {
  const next = current + (1 - m) * dt / BUILD_SECONDS - m * dt / DROP_SECONDS;
  return Math.min(1, Math.max(0, next));
}

// ============================================================================
// Shaders
// ============================================================================
const HEADER = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_prev;
uniform float u_time;
uniform float eff_int;
uniform vec2 u_res;
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
/** name -> { name, src, prog, u, error, enabled, params, rts:[a,b], cur } */
const effects = new Map();
const enabledState = new Map();  // remembers checkbox state across reloads
const paramState = new Map();    // "file:uniform" -> slider value the user set (survives reloads)
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

// Per-effect sliders, declared in the effect file as:
//   uniform float <name>; // @param <min> <max> <default>
const PARAM_RE = /^\s*uniform\s+float\s+(\w+)\s*;\s*\/\/\s*@param\b(.*)$/gm;

function parseParams(name, src) {
  const out = [];
  for (const m of src.matchAll(PARAM_RE)) {
    const [min, max, def] = m[2].trim().split(/\s+/).map(Number);
    if (![min, max, def].every(Number.isFinite) || !(max > min)) {
      console.warn(`[${name}] ignoring "@param" for ${m[1]}: expected "@param <min> <max> <default>"`);
      continue;
    }
    out.push({ name: m[1], min, max, def: clamp(def, min, max) });
  }
  return out;
}

function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

function loadEffect(name, src) {
  let e = effects.get(name);
  if (!e) {
    e = { name, src: null, prog: null, u: null, error: null, params: [], rts: [null, null], cur: 0 };
    effects.set(name, e);
  }
  if (e.prog) gl.deleteProgram(e.prog);
  e.src = src; e.prog = null; e.u = null; e.error = null;
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
  e.enabled = enabledState.has(name) ? enabledState.get(name) : true;
  resetFeedback(e);
}

function unloadEffect(name) {
  const e = effects.get(name);
  if (!e) return;
  if (e.prog) gl.deleteProgram(e.prog);
  freeTarget(e.rts[0]); freeTarget(e.rts[1]);
  effects.delete(name);
}

function resetFeedback(e) {
  for (const t of e.rts) if (t) clearTarget(t);
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

function renderPanel() {
  const ol = $('effects');
  ol.textContent = '';
  if (!chain.length) {
    ol.innerHTML = '<li><i>no effects found in effects/</i></li>';
    return;
  }
  for (const e of chain) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = e.enabled;
    cb.onchange = () => {
      e.enabled = cb.checked;
      enabledState.set(e.name, cb.checked);
      if (cb.checked) resetFeedback(e);
    };
    label.append(cb, ' ', e.name.replace(/\.glsl$/, ''));
    li.append(label);
    if (!e.error) for (const q of e.params) li.append(paramRow(q));
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

// One slider row for an effect parameter. Double-click the slider to reset to the default.
function paramRow(q) {
  const row = document.createElement('div');
  row.className = 'row param';
  const name = document.createElement('span');
  name.textContent = q.name;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = q.min; slider.max = q.max; slider.step = (q.max - q.min) / 1000;
  slider.value = q.value;
  slider.title = `${q.min} .. ${q.max}, default ${q.def} (double-click to reset)`;
  const val = document.createElement('span');
  val.className = 'val';
  const show = () => { val.textContent = q.value.toFixed(2); };
  slider.oninput = () => { q.value = Number(slider.value); paramState.set(q.key, q.value); show(); };
  slider.ondblclick = () => { q.value = q.def; slider.value = q.def; paramState.delete(q.key); show(); };
  show();
  row.append(name, slider, val);
  return row;
}

const effIntSlider = $('effInt');
const autoBox = $('auto');
let effInt = Number(effIntSlider.value);
effIntSlider.oninput = () => { effInt = Number(effIntSlider.value); };
autoBox.onchange = () => { effIntSlider.disabled = autoBox.checked; prevLuma = null; };

$('camBtn').onclick = () => useWebcam();
$('camSel').onchange = (ev) => { savePref('camId', ev.target.value); useWebcam(ev.target.value); };
$('fileIn').onchange = (ev) => { const f = ev.target.files[0]; if (f) useVideoFile(f); };
$('toggle').onclick = () => $('panel').classList.toggle('hidden');
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'h' || ev.key === 'H') $('panel').classList.toggle('hidden');
});
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
let sourceProg, copyProg, sourceTex, sourceRT = null;

function initGL() {
  sourceProg = linkProgram(SOURCE_FRAG);
  copyProg = linkProgram(COPY_FRAG);
  gl.bindVertexArray(gl.createVertexArray());
  sourceTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sourceTex);
  setTexParams();
}

// Fit (w, h) inside MAX_DIM, keeping the aspect ratio.
function capSize(w, h) {
  const s = Math.min(1, MAX_DIM / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// Flat page: render targets match the canvas.
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const [w, h] = capSize(Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  setTargetSize(w, h);
}

// (Re)create all render targets at w x h. Headset mode sizes them to the camera instead.
function setTargetSize(w, h) {
  if (w === rtW && h === rtH) return;
  rtW = w; rtH = h;
  freeTarget(sourceRT);
  sourceRT = makeTarget(w, h);
  for (const e of effects.values()) {
    freeTarget(e.rts[0]); freeTarget(e.rts[1]);
    e.rts = [null, null];
  }
}

function ensureTargets(e) {
  if (!e.rts[0]) e.rts = [makeTarget(rtW, rtH), makeTarget(rtW, rtH)];
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
  gl.uniform1f(p.u.eff_int, effInt);
  gl.uniform2f(p.u.u_res, rtW, rtH);
  if (p.params) for (const q of p.params) if (q.loc) gl.uniform1f(q.loc, q.value);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const startTime = performance.now();
let lastNow = startTime;
let xrSession = null;   // set by xr.js while the headset mode is active

function showEffInt() {
  if (autoBox.checked) effIntSlider.value = effInt;
  $('effIntVal').textContent = effInt.toFixed(2);
}

// Stats readout, twice a second: camera size and fps, render fps.
const stats = { renderFrames: 0, t0: performance.now(), cam0: 0 };
setInterval(() => {
  const now = performance.now(), secs = (now - stats.t0) / 1000;
  const camFps = (camFrames.count - stats.cam0) / secs, renderFps = stats.renderFrames / secs;
  stats.t0 = now; stats.cam0 = camFrames.count; stats.renderFrames = 0;
  $('stats').textContent = video.videoWidth
    ? `camera ${video.videoWidth}x${video.videoHeight} @ ${camFps.toFixed(0)} fps · render ${rtW}x${rtH} @ ${renderFps.toFixed(0)} fps`
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

  const out = renderChain((now - startTime) / 1000);
  if (!out) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return;
  }
  draw(copyProg, null, out, null, 0);
}

// Upload the current source frame and run the effect chain into the render targets.
// Returns the final texture, or null when there is no source yet.
function renderChain(time) {
  const src = getSourceElement();
  if (!src) return null;

  // Upload frame (flipped so uv (0,0) is bottom-left, like Shadertoy).
  bindTex(0, sourceTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  // Source pass: cover-fit into the first render target ((1,1) when the aspects match).
  const ca = rtW / rtH, va = src.videoWidth / src.videoHeight;
  gl.useProgram(sourceProg.prog);
  gl.uniform2f(sourceProg.u.u_scale, ca > va ? 1 : ca / va, ca > va ? va / ca : 1);
  draw(sourceProg, sourceRT.fbo, sourceTex, null, time);

  // Effect chain.
  let input = sourceRT.tex;
  for (const e of chain) {
    if (!e.enabled || !e.prog) continue;
    ensureTargets(e);
    const write = e.rts[e.cur], prev = e.rts[1 - e.cur];
    draw(e, write.fbo, input, prev.tex, time);
    e.cur = 1 - e.cur;
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
