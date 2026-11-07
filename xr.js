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

const CAM_HFOV_DEFAULT = 70;      // degrees; image size. Tune in VR with the right thumbstick
const CAM_DELAY_DEFAULT = 60;     // ms from capture to presentation; tune with the thumbstick
const HEAD_STILL = 8;             // deg/s head rotation counted as still
const HEAD_MOVING = 45;           // deg/s counted as fully moving
const MOVE_STILL = 0.08;          // m/s head movement counted as still
const MOVE_MOVING = 0.6;          // m/s counted as fully moving
const MOTION_SMOOTH = 0.15;       // s, low-pass on head speed (tracking jitter is per-frame)

const PRESENT_VERT = `#version 300 es
uniform mat4 u_proj;
uniform mat3 u_rot;    // capture-time head direction -> current eye direction
uniform vec2 u_half;   // half-size of the quad at distance 1 (tan of half the camera FOV)
out vec2 v_uv;
void main() {
  vec2 c[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));
  v_uv = c[gl_VertexID];
  gl_Position = u_proj * vec4(u_rot * vec3((v_uv * 2.0 - 1.0) * u_half, -1.0), 1.0);
}`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;

const xrBox = $('xrBox'), xrBtn = $('xrBtn');
let xrMode = null, xrRefSpace = null, presentProg = null, xrLast = 0;

// ---- tunables: panel sliders outside VR, thumbstick inside ----
function tunable(id, key, def, unit) {
  const slider = $(id), label = $(id + 'Val');
  const t = { value: Number(loadPref(key)) || def };
  t.set = (v) => {
    t.value = Math.min(Number(slider.max), Math.max(Number(slider.min), v));
    slider.value = t.value;
    label.textContent = Math.round(t.value) + unit;
  };
  t.save = () => savePref(key, Math.round(t.value));
  slider.oninput = () => { t.set(Number(slider.value)); t.save(); };
  t.set(t.value);
  return t;
}
const camFov = tunable('camFov', 'camFov2', CAM_HFOV_DEFAULT, '°');
const camDelay = tunable('camDelay', 'camDelay', CAM_DELAY_DEFAULT, ' ms');

// Diagnostics, shown in the status line when leaving VR.
const input = { sources: 0, gamepads: 0, maxStick: 0 };

function readThumbstick(session, dt) {
  input.sources = Math.max(input.sources, session.inputSources.length);
  let pads = 0;
  for (const s of session.inputSources) {
    const a = s.gamepad && s.gamepad.axes;
    if (!a || a.length < 2) continue;
    pads++;
    // "xr-standard" puts the thumbstick in axes 2/3 (0/1 = touchpad); use whichever pair moves.
    let x = a[0], y = a[1];
    if (a.length >= 4 && Math.hypot(a[2], a[3]) > Math.hypot(a[0], a[1])) { x = a[2]; y = a[3]; }
    input.maxStick = Math.max(input.maxStick, Math.hypot(x, y));
    if (Math.abs(y) > 0.2) camFov.set(camFov.value - y * 25 * dt);     // forward = bigger image
    if (Math.abs(x) > 0.2) camDelay.set(camDelay.value + x * 60 * dt); // right = more delay
  }
  input.gamepads = Math.max(input.gamepads, pads);
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
function qToMat3(q) {   // column-major
  const { x, y, z, w } = q;
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ]);
}
const copyQ = (q) => ({ x: q.x, y: q.y, z: q.z, w: q.w });

// ---- head orientation history, to look up where the head pointed at capture time ----
const history = [];   // { t, q }, oldest first, ~0.5 s
function poseAt(t) {
  for (let i = history.length - 1; i > 0; i--) {
    const a = history[i - 1], b = history[i];
    if (a.t <= t) return t >= b.t ? b.q : qNlerp(a.q, b.q, (t - a.t) / (b.t - a.t));
  }
  return history.length ? history[0].q : null;
}

let captureQ = null, seenFrames = -1, lastNewFrame = 0;
function updateCaptureOrientation(now, headQ) {
  history.push({ t: now, q: copyQ(headQ) });
  while (history.length > 2 && history[0].t < now - 500) history.shift();
  if (camFrames.count !== seenFrames) {          // a new camera frame arrived
    seenFrames = camFrames.count;
    lastNewFrame = now;
    captureQ = poseAt(camFrames.presentationTime - camDelay.value);
  } else if (now - lastNewFrame > 300) {         // no frame callbacks in VR: delay only
    captureQ = poseAt(now - camDelay.value);
  }
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
    await gl.makeXRCompatible();
    const session = await navigator.xr.requestSession(xrMode);
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    xrRefSpace = await session.requestReferenceSpace('local');
    session.addEventListener('end', () => {
      xrSession = null;
      lastPose = null; captureQ = null; history.length = 0;
      rotSpeed = moveSpeed = 0; xrLast = 0;
      camFov.save(); camDelay.save();
      setStatus(`Left VR. Controllers seen: ${input.sources}, with sticks: ${input.gamepads}, ` +
        `strongest stick push: ${input.maxStick.toFixed(2)}. Size ${Math.round(camFov.value)}°, delay ${Math.round(camDelay.value)} ms.`);
      input.sources = input.gamepads = input.maxStick = 0;
    });
    xrSession = session;
    session.requestAnimationFrame(xrFrame);
  } catch (e) {
    xrSession = null;
    setStatus('Enter VR failed: ' + e.message);
  }
}

function xrFrame(now, frame) {
  const session = frame.session;
  session.requestAnimationFrame(xrFrame);
  const dt = xrLast ? Math.min(0.1, (now - xrLast) / 1000) : 0;
  xrLast = now;
  stats.renderFrames++;

  const pose = frame.getViewerPose(xrRefSpace);
  const layer = session.renderState.baseLayer;
  const src = getSourceElement();
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.clearColor(0, 0, 0, xrMode === 'immersive-ar' ? 0 : 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!pose || !src) return;

  readThumbstick(session, dt);
  const m = headMotion(pose.transform, dt);
  if (autoBox.checked) effInt = autoEffInt(effInt, dt, m);
  updateCaptureOrientation(now, pose.transform.orientation);

  // Render targets match the camera, so nothing is cropped.
  const [w, h] = capSize(src.videoWidth, src.videoHeight);
  setTargetSize(w, h);
  const out = renderChain((now - startTime) / 1000);
  if (!out) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.useProgram(presentProg.prog);
  bindTex(0, out);
  gl.uniform1i(presentProg.u.u_tex, 0);
  const hx = Math.tan((camFov.value / 2) * Math.PI / 180);
  gl.uniform2f(presentProg.u.u_half, hx, hx * src.videoHeight / src.videoWidth);
  const capQ = captureQ || pose.transform.orientation;
  for (const view of pose.views) {
    const vp = layer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.uniformMatrix4fv(presentProg.u.u_proj, false, view.projectionMatrix);
    gl.uniformMatrix3fv(presentProg.u.u_rot, false, qToMat3(qMul(qConj(view.transform.orientation), capQ)));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

initXR();
