'use strict';
// Headset mode (WebXR). Loaded after harness.js and uses its globals.
// The camera comes from getUserMedia (start it with the Webcam button BEFORE entering:
// permission prompts cannot appear inside VR). The effect chain runs once per frame and
// is shown to both eyes on a head-locked quad sized to the camera's field of view.

const CAM_HFOV_DEFAULT = 90;      // degrees; tune with the panel slider until the image matches reality
const HEAD_STILL = 5;             // deg/s head rotation counted as still
const HEAD_MOVING = 40;           // deg/s counted as fully moving
const MOVE_STILL = 0.05;          // m/s head movement counted as still
const MOVE_MOVING = 0.5;          // m/s counted as fully moving

const PRESENT_VERT = `#version 300 es
uniform mat4 u_proj;
uniform vec2 u_half;   // half-size of the quad at distance 1 (tan of half the camera FOV)
out vec2 v_uv;
void main() {
  vec2 c[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));
  v_uv = c[gl_VertexID];
  gl_Position = u_proj * vec4((v_uv * 2.0 - 1.0) * u_half, -1.0, 1.0);
}`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;

const xrBox = $('xrBox'), xrBtn = $('xrBtn'), fovSlider = $('camFov'), fovVal = $('camFovVal');
let xrMode = null, xrRefSpace = null, presentProg = null, xrLast = 0, lastPose = null;

let camFov = Number(loadPref('camFov')) || CAM_HFOV_DEFAULT;
fovSlider.value = camFov;
fovVal.textContent = camFov + '°';
fovSlider.oninput = () => {
  camFov = Number(fovSlider.value);
  fovVal.textContent = camFov + '°';
  savePref('camFov', camFov);
};

// ---- eff_int source in the headset: head motion (0 = still, 1 = moving) ----
function headMotion(transform, dt) {
  const q = transform.orientation, p = transform.position;
  let m = 0;
  if (lastPose && dt > 0) {
    const l = lastPose;
    const dot = Math.min(1, Math.abs(q.x * l.qx + q.y * l.qy + q.z * l.qz + q.w * l.qw));
    const degPerSec = (2 * Math.acos(dot) * 180 / Math.PI) / dt;
    const metersPerSec = Math.hypot(p.x - l.px, p.y - l.py, p.z - l.pz) / dt;
    m = Math.max(smoothstep(HEAD_STILL, HEAD_MOVING, degPerSec), smoothstep(MOVE_STILL, MOVE_MOVING, metersPerSec));
  }
  lastPose = { qx: q.x, qy: q.y, qz: q.z, qw: q.w, px: p.x, py: p.y, pz: p.z };
  return m;
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
      lastPose = null;
      xrLast = 0;
      setStatus('Left headset mode');
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

  const pose = frame.getViewerPose(xrRefSpace);
  const layer = session.renderState.baseLayer;
  const src = getSourceElement();
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.clearColor(0, 0, 0, xrMode === 'immersive-ar' ? 0 : 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!pose || !src) return;

  if (autoBox.checked) effInt = autoEffInt(effInt, dt, headMotion(pose.transform, dt));
  else headMotion(pose.transform, dt);  // keep the last pose current for when auto is switched on

  // Render targets match the camera, so nothing is cropped.
  const [w, h] = capSize(src.videoWidth, src.videoHeight);
  setTargetSize(w, h);
  const out = renderChain((now - startTime) / 1000);
  if (!out) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.useProgram(presentProg.prog);
  bindTex(0, out);
  gl.uniform1i(presentProg.u.u_tex, 0);
  const hx = Math.tan((camFov / 2) * Math.PI / 180);
  gl.uniform2f(presentProg.u.u_half, hx, hx * src.videoHeight / src.videoWidth);
  for (const view of pose.views) {
    const vp = layer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.uniformMatrix4fv(presentProg.u.u_proj, false, view.projectionMatrix);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

initXR();
