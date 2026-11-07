'use strict';
// Headset mode (WebXR). Loaded after harness.js and uses its globals.
// The camera comes from getUserMedia (start it with the Webcam button BEFORE entering:
// permission prompts cannot appear inside VR). The effect chain runs once per frame and
// is shown to both eyes on a quad sized to the camera's field of view.
//
// Reprojection: the camera delivers fewer frames than the display (e.g. 30 vs 72 fps) and
// each arrives late. Every camera frame is tagged with where the head pointed when it was
// captured (frame time - camera delay), and drawn in THAT direction, rotated into the
// current view. So the image stays put in the world between camera frames instead of
// riding along with the head and jumping. Rotation only; fine for things more than ~1 m away.

// Controls in VR:  left stick  forward/back = image size, left/right = camera delay
//                  right stick = move the image (align it with the real passthrough)
//                  hold a trigger + right stick = stereo trim (left/right = separation,
//                                                 fwd/back = vertical mismatch)
//                  click a stick = reset that stick's settings (with trigger: the stereo trim)
//                  A or X button = stereo eye check: both eyes see only camera A (left lane),
//                                  then only camera B (right lane), then back to normal
// While adjusting, a text display shows the values and (in AR mode) the image turns
// half see-through so it can be lined up with the passthrough behind it.
const CAM_HFOV_DEFAULT = 70;      // degrees; image size
const CAM_DELAY_DEFAULT = 60;     // ms from capture to presentation
const STICK_DEADZONE = 0.25;
const ADJUST_SHOW_MS = 2500;      // keep the text display up this long after the last adjustment
const INTRO_SHOW_MS = 6000;       // ... and this long after entering VR
const ADJUST_ALPHA = 0.5;         // image opacity while adjusting (AR mode only)
const HEAD_STILL = 8;             // deg/s head rotation counted as still
const HEAD_MOVING = 45;           // deg/s counted as fully moving
const MOVE_STILL = 0.08;          // m/s head movement counted as still
const MOVE_MOVING = 0.6;          // m/s counted as fully moving
const MOTION_SMOOTH = 0.15;       // s, low-pass on head speed (tracking jitter is per-frame)

// Fixed-distance reprojection: the camera image is put on a rectangle at distance u_dist in
// front of the CAMERA (its real position: the eye plus a small offset), and that rectangle is
// viewed from the EYE's real position. Objects at u_dist line up exactly; farther / nearer
// objects are off by (camera offset / distance), much less than without the offset model.
const PRESENT_VERT = `#version 300 es
uniform mat4 u_proj;
uniform mat4 u_view;   // world -> this eye
uniform mat4 u_cam;    // camera space (at capture time) -> world
uniform vec2 u_half;   // half-size of the image at distance 1 (tan of half the camera FOV)
uniform float u_dist;  // match distance in metres
out vec2 v_uv;
void main() {
  vec2 c[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));
  v_uv = c[gl_VertexID];
  vec3 p = vec3((v_uv * 2.0 - 1.0) * u_half * u_dist, -u_dist);
  gl_Position = u_proj * u_view * u_cam * vec4(p, 1.0);
}`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform vec2 u_fade;   // soft edge width in uv units (x, y), same angle on both axes; 0 = hard edge
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 d = min(v_uv, 1.0 - v_uv);   // distance to the nearest edge, per axis
  float edge = smoothstep(0.0, max(u_fade.x, 1e-4), d.x) * smoothstep(0.0, max(u_fade.y, 1e-4), d.y);
  float a = u_alpha * edge;
  o = vec4(texture(u_tex, v_uv).rgb * a, a);   // premultiplied: fades into the passthrough
}`;

// Text display: a head-locked rectangle (in view space at distance 1) showing a canvas.
const HUD_VERT = `#version 300 es
uniform mat4 u_proj;
uniform vec4 u_rect;   // x0, y0, x1, y1
out vec2 v_uv;
void main() {
  vec2 c[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));
  v_uv = c[gl_VertexID];
  gl_Position = u_proj * vec4(mix(u_rect.xy, u_rect.zw, v_uv), -1.0, 1.0);
}`;

const HUD_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { vec4 c = texture(u_tex, v_uv); o = vec4(c.rgb * c.a, c.a); }`;

const xrBox = $('xrBox'), xrBtn = $('xrBtn');
let xrMode = null, xrRefSpace = null, presentProg = null, hudProg = null, xrLast = 0;

// ---- tunables: panel sliders outside VR, thumbsticks inside ----
function tunable(id, key, def, unit, decimals = 0) {
  const slider = $(id), label = $(id + 'Val');
  const stored = loadPref(key);
  const t = { value: stored !== null && stored !== '' && isFinite(stored) ? Number(stored) : def, def };
  t.text = () => t.value.toFixed(decimals) + unit;
  t.set = (v) => {
    t.value = Math.min(Number(slider.max), Math.max(Number(slider.min), v));
    slider.value = t.value;
    label.textContent = t.text();
  };
  t.save = () => savePref(key, t.value.toFixed(decimals));
  slider.oninput = () => { t.set(Number(slider.value)); t.save(); };
  t.set(t.value);
  return t;
}
const camFov = tunable('camFov', 'camFov2', CAM_HFOV_DEFAULT, '°');
const camDelay = tunable('camDelay', 'camDelay', CAM_DELAY_DEFAULT, ' ms');
const camYaw = tunable('camYaw', 'camYaw', 0, '°', 1);       // + = image moved right
const camPitch = tunable('camPitch', 'camPitch', 0, '°', 1);   // + = image moved up
const camSep = tunable('camSep', 'camSep', 0, '°', 1);       // stereo: + = eye images move apart
const xrRes = tunable('xrRes', 'xrRes', 960, ' px');       // VR render size (longest side)
const camVert = tunable('camVert', 'camVert', 0, '°', 1);    // stereo: + = left image up, right down
// Fixed-distance reprojection: where each camera sits relative to its eye, and the distance
// at which overlay and real world should line up exactly.
const matchDist = tunable('matchDist', 'matchDist', 1.5, ' m', 2);
const camSide = tunable('camSide', 'camSide', 0, ' cm', 1);  // + = camera further out than the eye
const camFwd = tunable('camFwd', 'camFwd', 5, ' cm', 1);     // + = camera in front of the eye
const camUp = tunable('camUp', 'camUp', -1, ' cm', 1);       // + = camera above the eye
const edgeFade = tunable('edgeFade', 'edgeFade', 6, '°', 1);  // soft edge width (degrees of view)

// Diagnostics: shown in the text display and in the status line when leaving VR.
const input = { sources: 0, gamepads: 0, raw: { left: '-', right: '-' } };
const clicked = { left: false, right: false };
const pressedA = { left: false, right: false };
let pressedB = false;            // B on the right controller (recording, record.js)
let eyeCheck = 0;   // 0 = normal stereo, 1 = both eyes see lane 0 (camera A), 2 = lane 1 (camera B)
const camFps = [0, 0], camFps0 = [0, 0];
let camFpsT = performance.now();
setInterval(() => {
  const now = performance.now(), secs = (now - camFpsT) / 1000;
  lanes.forEach((l, i) => { camFps[i] = (l.frames.count - camFps0[i]) / secs; camFps0[i] = l.frames.count; });
  camFpsT = now;
}, 1000);
let lastAdjust = -1e9, enteredAt = 0;

function readSticks(session, dt, now) {
  input.sources = Math.max(input.sources, session.inputSources.length);
  // Holding either trigger switches the right stick to the stereo trim.
  // (inputSources is an XRInputSourceArray: iterable, but not a real Array, so no .some())
  const held = (i) => Array.from(session.inputSources).some((s) => s.gamepad && s.gamepad.buttons[i] && s.gamepad.buttons[i].value > 0.5);
  const grip = held(1);              // grip: both sticks set the distance reprojection
  const trim = !grip && held(0);     // trigger: right stick sets the stereo trim
  let pads = 0;
  for (const s of session.inputSources) {
    const g = s.gamepad, a = g && g.axes;
    if (!a || a.length < 2) continue;
    pads++;
    const hand = s.handedness === 'left' ? 'left' : 'right';
    input.raw[hand] = Array.from(a, (v) => v.toFixed(2)).join(' ');
    // "xr-standard" puts the thumbstick in axes 2/3 (0/1 = touchpad); use whichever pair moves.
    let x = a[0], y = a[1];
    if (a.length >= 4 && Math.hypot(a[2], a[3]) > Math.hypot(a[0], a[1])) { x = a[2]; y = a[3]; }
    // Only the stronger direction counts: a sideways push always leaks a little forward/back.
    if (Math.abs(x) >= Math.abs(y)) y = 0; else x = 0;
    if (Math.abs(x) < STICK_DEADZONE) x = 0;
    if (Math.abs(y) < STICK_DEADZONE) y = 0;
    if (x || y) lastAdjust = now;
    if (grip && hand === 'left') {
      matchDist.set(matchDist.value * Math.exp(-y * 0.8 * dt));   // forward = farther
      camUp.set(camUp.value + x * 2 * dt);                         // right = camera higher
    } else if (grip) {
      camSide.set(camSide.value + x * 2 * dt);                     // right = camera further out
      camFwd.set(camFwd.value - y * 3 * dt);                       // forward = camera further forward
    } else if (hand === 'left') {
      camFov.set(camFov.value - y * 25 * dt);       // forward = bigger image
      camDelay.set(camDelay.value + x * 60 * dt);   // right = more delay
    } else if (trim) {
      camSep.set(camSep.value + x * 3 * dt);        // right = images apart
      camVert.set(camVert.value - y * 2 * dt);      // forward = left image up
    } else {
      camYaw.set(camYaw.value + x * 8 * dt);        // right = move right
      camPitch.set(camPitch.value - y * 8 * dt);    // forward = move up
    }
    const click = !!(g.buttons[3] && g.buttons[3].pressed);   // thumbstick press
    if (click && !clicked[hand]) {
      lastAdjust = now;
      if (grip && hand === 'left') { matchDist.set(matchDist.def); camUp.set(camUp.def); }
      else if (grip) { camSide.set(camSide.def); camFwd.set(camFwd.def); }
      else if (hand === 'left') { camFov.set(camFov.def); camDelay.set(camDelay.def); }
      else if (trim) { camSep.set(0); camVert.set(0); }
      else { camYaw.set(0); camPitch.set(0); }
    }
    clicked[hand] = click;
    const btnA = !!(g.buttons[4] && g.buttons[4].pressed);     // A (right hand) / X (left hand)
    if (btnA && !pressedA[hand]) { eyeCheck = (eyeCheck + 1) % 3; lastAdjust = now; }
    pressedA[hand] = btnA;
    if (hand === 'right') {                                    // B: start / stop recording
      const btnB = !!(g.buttons[5] && g.buttons[5].pressed);
      if (btnB && !pressedB && typeof recToggle === 'function') recToggle();
      pressedB = btnB;
    }
  }
  input.gamepads = Math.max(input.gamepads, pads);
}

// ---- text display ----
const hudCanvas = document.createElement('canvas');
hudCanvas.width = 1024; hudCanvas.height = 362;
const hudCtx = hudCanvas.getContext('2d');
let hudTex = null, hudText = '', hudDrawnAt = 0;

function updateHud(problem = '') {
  const cams = lanes.map((l, i) => i === 0 || stereoOn ? Math.round(camFps[i]) : null).filter((v) => v !== null).join('/');
  const lines = [
    `size ${camFov.text()}    delay ${camDelay.text()}    move  x ${camYaw.text()}  y ${camPitch.text()}`,
    'LEFT stick: fwd/back = size, left/right = delay',
    'RIGHT stick: move image to line up with the room.  Click a stick = reset',
    'Hold TRIGGER + right stick: stereo separation (left/right), vertical (fwd/back)',
    'Hold GRIP: left stick = match distance (fwd/back), camera height (l/r); right stick = camera side / forward',
    `match distance ${matchDist.text()}   camera offset: side ${camSide.text()}  forward ${camFwd.text()}  up ${camUp.text()}`,
    eyeCheck && stereoOn
      ? `EYE CHECK: both eyes see camera ${eyeCheck === 1 ? 'A' : 'B'} = "${lanes[eyeCheck - 1].label}"  (A/X = next)`
      : `stereo ${stereoInfo}   sep ${camSep.text()}  vert ${camVert.text()}   A/X = eye check   B = record`,
    `VR ${Math.round(xrPerf.fps)} fps  frame ${xrPerf.ms.toFixed(1)} ms (worst ${xrPerf.worstMs.toFixed(0)})  camera ${cams} fps  render ${rtW}x${rtH}  sticks L[${input.raw.left}] R[${input.raw.right}]`,
    problem,
  ];
  const text = lines.join('\n');
  if (text === hudText && hudTex) return;
  // Redrawing + uploading the text canvas costs time: at most 10 times a second.
  const t = performance.now();
  if (hudTex && t - hudDrawnAt < 100) return;
  hudDrawnAt = t;
  hudText = text;
  const c = hudCtx;
  c.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  c.fillStyle = 'rgba(0,0,0,0.7)';
  c.fillRect(0, 0, hudCanvas.width, hudCanvas.height);
  c.fillStyle = '#fff';
  c.font = 'bold 36px sans-serif';
  c.fillText(lines[0], 20, 46);
  c.font = '28px sans-serif';
  c.fillText(lines[1], 20, 88);
  c.fillText(lines[2], 20, 124);
  c.fillText(lines[3], 20, 160);
  c.font = '24px sans-serif';
  c.fillText(lines[4], 20, 194);
  c.fillStyle = '#8cf';
  c.font = '28px sans-serif';
  c.fillText(lines[5], 20, 230);
  c.fillStyle = stereoOn ? '#8f8' : '#fc8';
  c.fillText(lines[6], 20, 268);
  c.fillStyle = '#aaa';
  c.font = '22px monospace';
  c.fillText(lines[7], 20, 304);
  if (lines[8]) {
    c.fillStyle = '#f66';
    c.font = 'bold 28px sans-serif';
    c.fillText(lines[8], 20, 344);
  }
  if (!hudTex) { hudTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, hudTex); setTexParams(); }
  gl.bindTexture(gl.TEXTURE_2D, hudTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hudCanvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

// ---- quaternions {x, y, z, w} ----
const qConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const qMul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
function qNlerp(a, b, t) {
  const s = (a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) < 0 ? -1 : 1;
  const q = { x: a.x + (s * b.x - a.x) * t, y: a.y + (s * b.y - a.y) * t,
              z: a.z + (s * b.z - a.z) * t, w: a.w + (s * b.w - a.w) * t };
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}
// Head yaw / pitch (radians) of the forward direction (0, 0, -1):
// +yaw = turned right, +pitch = looking up.
function qYawPitch(q) {
  const fx = -2 * (q.w * q.y + q.x * q.z);
  const fy = 2 * (q.w * q.x - q.y * q.z);
  const fz = -1 + 2 * (q.x * q.x + q.y * q.y);
  return [Math.atan2(fx, -fz), Math.asin(Math.max(-1, Math.min(1, fy)))];
}
function qToMat3(q) {   // column-major
  const { x, y, z, w } = q;
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ]);
}
const copyQ = (q) => ({ x: q.x, y: q.y, z: q.z, w: q.w });
// Rotate vector v by quaternion q.
function qRotate(q, v) {
  const t = qMul(qMul(q, { x: v.x, y: v.y, z: v.z, w: 0 }), qConj(q));
  return { x: t.x, y: t.y, z: t.z };
}
// 4x4 column-major matrix: rotate by q, then move to position p (local -> world).
function poseMatrix(q, p) {
  const r = qToMat3(q);
  return new Float32Array([r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, p.x, p.y, p.z, 1]);
}
// Inverse of poseMatrix (world -> local), e.g. the view matrix of an eye.
function viewMatrix(q, p) {
  const qi = qConj(q), t = qRotate(qi, p);
  return poseMatrix(qi, { x: -t.x, y: -t.y, z: -t.z });
}
function qAxis(ax, ay, az, deg) {
  const h = (deg * Math.PI) / 360, s = Math.sin(h);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) };
}
// Alignment offset in head space: + yaw moves the image right, + pitch moves it up.
// eye: -1 = left, +1 = right, 0 = mono; the stereo trim moves the two eye images oppositely.
function offsetQ(eye) {
  const yaw = camYaw.value + eye * camSep.value / 2;
  const pitch = camPitch.value - eye * camVert.value / 2;
  return qMul(qAxis(0, 1, 0, -yaw), qAxis(1, 0, 0, pitch));
}

// ---- head orientation history, to look up where the head pointed at capture time ----
const history = [];   // { t, q }, oldest first, ~0.5 s
function poseAt(t) {
  for (let i = history.length - 1; i > 0; i--) {
    const a = history[i - 1], b = history[i];
    if (a.t <= t) return t >= b.t ? b.q : qNlerp(a.q, b.q, (t - a.t) / (b.t - a.t));
  }
  return history.length ? history[0].q : null;
}

// Per lane (eye camera): head orientation when its current frame was captured.
const captureQ = [null, null], seenFrames = [-1, -1], lastNewFrame = [0, 0];
function updateCaptureOrientation(now, headQ) {
  history.push({ t: now, q: copyQ(headQ) });
  while (history.length > 2 && history[0].t < now - 500) history.shift();
  lanes.forEach((lane, i) => {
    const f = lane.frames;
    if (f.count !== seenFrames[i]) {               // a new camera frame arrived
      seenFrames[i] = f.count;
      lastNewFrame[i] = now;
      captureQ[i] = poseAt(f.presentationTime - camDelay.value);
    } else if (now - lastNewFrame[i] > CALLBACK_STALE_MS) {   // callbacks stopped (VR): delay only
      captureQ[i] = poseAt(now - camDelay.value);
    }
  });
}

// ---- eff_int source in the headset: smoothed head motion (0 = still, 1 = moving) ----
let lastPose = null, rotSpeed = 0, moveSpeed = 0;
function headMotion(transform, dt) {
  const q = transform.orientation, p = transform.position;
  if (lastPose && dt > 0) {
    const l = lastPose;
    const dot = Math.min(1, Math.abs(q.x * l.q.x + q.y * l.q.y + q.z * l.q.z + q.w * l.q.w));
    const degPerSec = (2 * Math.acos(dot) * 180 / Math.PI) / dt;
    const metersPerSec = Math.hypot(p.x - l.p.x, p.y - l.p.y, p.z - l.p.z) / dt;
    const k = 1 - Math.exp(-dt / MOTION_SMOOTH);
    rotSpeed += (degPerSec - rotSpeed) * k;
    moveSpeed += (metersPerSec - moveSpeed) * k;
  }
  lastPose = { q: copyQ(q), p: { x: p.x, y: p.y, z: p.z } };
  return Math.max(smoothstep(HEAD_STILL, HEAD_MOVING, rotSpeed), smoothstep(MOVE_STILL, MOVE_MOVING, moveSpeed));
}

async function initXR() {
  if (!gl || !navigator.xr) return;
  for (const mode of ['immersive-ar', 'immersive-vr']) {
    try { if (await navigator.xr.isSessionSupported(mode)) { xrMode = mode; break; } } catch { /* try next */ }
  }
  if (!xrMode) return;
  xrBox.hidden = false;
  xrBtn.onclick = enterXR;
  setInterval(() => { xrBtn.disabled = !getSourceElement() || !!xrSession; }, 300);
}

async function enterXR() {
  if (!getSourceElement() || xrSession) return;
  try {
    if (!presentProg) presentProg = linkProgram(PRESENT_FRAG, PRESENT_VERT);
    if (!hudProg) hudProg = linkProgram(HUD_FRAG, HUD_VERT);
    await gl.makeXRCompatible();
    const session = await navigator.xr.requestSession(xrMode);
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    xrRefSpace = await session.requestReferenceSpace('local');
    session.addEventListener('end', () => {
      xrSession = null;
      if (typeof recOnXrEnd === 'function') recOnXrEnd();   // stop + save recordings (record.js)
      lastPose = null; captureQ.fill(null); history.length = 0; resetHead();
      rotSpeed = moveSpeed = 0; xrLast = 0;
      for (const t of [camFov, camDelay, camYaw, camPitch, camSep, camVert, matchDist, camSide, camFwd, camUp]) t.save();
      setStatus(`Left VR. Controllers seen: ${input.sources}, with sticks: ${input.gamepads}. ` +
        `Size ${camFov.text()}, delay ${camDelay.text()}, move x ${camYaw.text()} y ${camPitch.text()}. ` +
        `VR ${Math.round(xrPerf.fps)} fps.` + (xrError ? ' Problem: ' + xrError : ''));
      input.sources = input.gamepads = 0;
    });
    xrSession = session;
    enteredAt = performance.now();
    xrError = ''; xrPerf.frames = 0; xrPerf.t0 = 0; xrPerf.fps = 0; xrPerf.slowSince = 0;
    session.requestAnimationFrame(xrFrame);
  } catch (e) {
    xrSession = null;
    setStatus('Enter VR failed: ' + e.message);
  }
}

// Problems shown in VR (and in the status line after leaving).
let xrError = '';
const xrPerf = { frames: 0, t0: 0, fps: 0, slowSince: 0, ms: 0, worstMs: 0, worst: 0 };
if (canvas) canvas.addEventListener('webglcontextlost', () => {
  xrError = 'GPU context lost (effects too heavy?). Reload the page.';
  setStatus(xrError);
});

function xrFrame(now, frame) {
  const session = frame.session;
  session.requestAnimationFrame(xrFrame);
  const t0 = performance.now();
  try { xrFrameBody(now, frame, session); }
  finally {
    // CPU time of this frame (JS + GL calls; GPU work may add to it), average and worst per second.
    const ms = performance.now() - t0;
    xrPerf.ms += (ms - xrPerf.ms) * 0.05;
    xrPerf.worst = Math.max(xrPerf.worst, ms);
  }
}

function xrFrameBody(now, frame, session) {
  const dt = xrLast ? Math.min(0.1, (now - xrLast) / 1000) : 0;
  xrLast = now;
  stats.renderFrames++;
  xrPerf.frames++;
  if (!xrPerf.t0) xrPerf.t0 = now;
  if (now - xrPerf.t0 > 1000) {
    xrPerf.fps = (xrPerf.frames * 1000) / (now - xrPerf.t0 || 1);
    xrPerf.frames = 0; xrPerf.t0 = now;
    xrPerf.worstMs = xrPerf.worst; xrPerf.worst = 0;
    xrPerf.slowSince = xrPerf.fps < 30 ? xrPerf.slowSince || now : 0;
  }

  const pose = frame.getViewerPose(xrRefSpace);
  const layer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.clearColor(0, 0, 0, xrMode === 'immersive-ar' ? 0 : 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!pose) return;

  let problem = xrError;
  try {
    readSticks(session, dt, now);
    const m = headMotion(pose.transform, dt);
    if (autoBox.checked) effInt = autoEffInt(effInt, dt, m);
    updateCaptureOrientation(now, pose.transform.orientation);
    // u_look / u_gaze for effects: the head direction the camera frame was taken in.
    const [yaw, pitch] = qYawPitch(captureQ[0] || pose.transform.orientation);
    updateHead(yaw, pitch, camFov.value, dt);
    const src = getSourceElement();
    if (!src) problem = problem || 'no camera frame - is the webcam running?';
    else drawCamera(now, pose, layer, src);
  } catch (e) {
    xrError = problem = 'error: ' + (e && e.message ? e.message : e);
    console.error(e);
  }
  if (!problem && xrPerf.slowSince && now - xrPerf.slowSince > 2000) {
    problem = 'too slow - untick some effects, lower VR render size, or turn stereo off';
  }

  // Text display: while adjusting, for a few seconds after entering, and whenever there is a problem.
  const show = problem || (eyeCheck && stereoOn) || now - lastAdjust < ADJUST_SHOW_MS || performance.now() - enteredAt < INTRO_SHOW_MS;
  if (show) {
    try { updateHud(problem); drawHud(pose, layer); } catch (e) { console.error(e); }
  }
  if (typeof recDrawBadge === 'function') {
    try { recDrawBadge(pose, layer); } catch (e) { console.error(e); }
  }
}

function drawCamera(now, pose, layer, src) {
  // Render targets follow the camera shape, capped by the VR render size setting.
  const s = Math.min(1, xrRes.value / Math.max(src.videoWidth, src.videoHeight));
  setTargetSize(Math.max(1, Math.round(src.videoWidth * s)), Math.max(1, Math.round(src.videoHeight * s)));
  // Stereo: one chain per eye camera; otherwise lane 0 for both eyes.
  const time = (now - startTime) / 1000;
  const stereo = !!getSourceElement(1);
  const outs = [renderChain(time, 0), stereo ? renderChain(time, 1) : null];
  if (!outs[0]) return;

  const adjusting = now - lastAdjust < ADJUST_SHOW_MS;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied alpha
  const hx = Math.tan((camFov.value / 2) * Math.PI / 180);
  const swap = $('swapEyes').checked;
  for (const view of pose.views) {
    const vp = layer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    const eye = view.eye === 'left' ? -1 : view.eye === 'right' ? 1 : 0;
    const lane = !(stereo && outs[1]) ? 0
      : eyeCheck ? eyeCheck - 1                // eye check: one camera for both eyes
      : (eye === 1) !== swap ? 1 : 0;
    const laneSrc = getSourceElement(lane) || src;
    const headQ = captureQ[lane] || pose.transform.orientation;   // head direction at capture
    const camQ = qMul(headQ, offsetQ(stereo && !eyeCheck ? eye : 0));

    // Camera position: this eye's position plus the camera offset (sideways mirrored per eye),
    // turned with the head as it was at capture time.
    const ep = view.transform.position;
    const off = qRotate(headQ, { x: eye * camSide.value / 100, y: camUp.value / 100, z: -camFwd.value / 100 });
    const camPos = { x: ep.x + off.x, y: ep.y + off.y, z: ep.z + off.z };

    gl.useProgram(presentProg.prog);
    bindTex(0, outs[lane]);
    gl.uniform1i(presentProg.u.u_tex, 0);
    gl.uniform1f(presentProg.u.u_alpha, adjusting && xrMode === 'immersive-ar' ? ADJUST_ALPHA : 1);
    // Soft edges: the image spans 2*atan(hx) degrees across; convert the fade angle to uv units.
    const fadeX = edgeFade.value / (2 * Math.atan(hx) * 180 / Math.PI);
    const hy = hx * laneSrc.videoHeight / laneSrc.videoWidth;
    const fadeY = edgeFade.value / (2 * Math.atan(hy) * 180 / Math.PI);
    gl.uniform2f(presentProg.u.u_fade, Math.min(0.5, fadeX), Math.min(0.5, fadeY));
    gl.uniform2f(presentProg.u.u_half, hx, hx * laneSrc.videoHeight / laneSrc.videoWidth);
    gl.uniform1f(presentProg.u.u_dist, matchDist.value);
    gl.uniformMatrix4fv(presentProg.u.u_proj, false, view.projectionMatrix);
    gl.uniformMatrix4fv(presentProg.u.u_view, false, viewMatrix(view.transform.orientation, ep));
    gl.uniformMatrix4fv(presentProg.u.u_cam, false, poseMatrix(camQ, camPos));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.disable(gl.BLEND);
  // Recording (record.js): the left-lane image, only while recording.
  if (typeof recCaptureXR === 'function') recCaptureXR(outs[0]);
}

function drawHud(pose, layer) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(hudProg.prog);
  bindTex(0, hudTex);
  gl.uniform1i(hudProg.u.u_tex, 0);
  const w2 = 0.36, h = (2 * w2 * hudCanvas.height) / hudCanvas.width, y0 = -0.42;
  gl.uniform4f(hudProg.u.u_rect, -w2, y0, w2, y0 + h);
  for (const view of pose.views) {
    const vp = layer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.uniformMatrix4fv(hudProg.u.u_proj, false, view.projectionMatrix);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.disable(gl.BLEND);
}

initXR();
