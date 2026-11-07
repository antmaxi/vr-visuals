'use strict';
// Recording: the processed image (one eye in the headset = lane 0, or the flat page's output)
// to a video file saved on this device (Downloads). Loaded after xr.js and uses the globals of
// harness.js / xr.js. Top-level names start with "rec" so they don't collide with other scripts.
//
// Start / stop: the B button on the right controller in VR, or the Record button in the panel.
// The real passthrough around the image is not recorded (web pages can't see it); for the full
// view use the Quest's own recorder (Meta button -> Camera -> Record video).
//
// How: after a frame is drawn into the WebGL canvas, it is copied into a separate 2D canvas
// (in the same task, so the WebGL drawing buffer is still valid) and that canvas is recorded
// with MediaRecorder; frames are pushed explicitly (requestFrame), at most REC_FPS a second,
// so it also works inside VR where the page canvas is never shown.
// Recordings made inside VR are downloaded when you leave VR (downloads don't work inside).

const REC_FPS = 30;
const REC_BITRATE = 8e6;          // bits per second (about 1 MB per second of video)

const recCanvas = document.createElement('canvas');
const recCtx = recCanvas.getContext('2d');
const recSupported = typeof MediaRecorder !== 'undefined' && typeof recCanvas.captureStream === 'function';
let recWanted = false;            // recording requested (the recorder starts on the next frame)
let recRecorder = null, recTrack = null, recChunks = [], recMime = '';
let recStartedAt = 0, recLastFrameAt = 0;
const recDone = [];               // finished recordings of this page visit: { url, name, size, secs, saved }

function recPickMime() {
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function recIsOn() { return recWanted; }

function recSetStatus(msg) { $('recStatus').textContent = msg; }

function recToggle() {
  if (!recSupported) { recSetStatus('recording is not supported in this browser'); return; }
  if (recWanted) recStop();
  else { recWanted = true; recSetStatus('recording...'); $('recBtn').textContent = 'Stop recording'; }
}

function recStop() {
  recWanted = false;
  $('recBtn').textContent = 'Record';
  if (recRecorder && recRecorder.state !== 'inactive') recRecorder.stop();   // onstop saves it
  else { recRecorder = null; recSetStatus(''); }
}

function recBegin(w, h) {
  recCanvas.width = Math.max(2, w & ~1);    // even sizes (H.264)
  recCanvas.height = Math.max(2, h & ~1);
  const stream = recCanvas.captureStream(0);
  recTrack = stream.getVideoTracks()[0];
  recMime = recPickMime();
  try {
    recRecorder = new MediaRecorder(stream, recMime ? { mimeType: recMime, videoBitsPerSecond: REC_BITRATE }
                                                    : { videoBitsPerSecond: REC_BITRATE });
  } catch (e) {
    recWanted = false; recRecorder = null;
    recSetStatus('cannot record: ' + e.message);
    return false;
  }
  recChunks = [];
  recRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
  recRecorder.onstop = recFinish;
  recRecorder.start(1000);
  recStartedAt = performance.now();
  return true;
}

// Is a frame due? (Recording requested, and at most REC_FPS frames a second.)
function recDue() {
  return recWanted && (!recRecorder || performance.now() - recLastFrameAt >= 1000 / REC_FPS - 2);
}

// Copy what the WebGL canvas holds right now into the recording. Flat page: call after drawing.
function recCaptureFlat() {
  if (!recDue()) return;
  if (!recRecorder && !recBegin(canvas.width, canvas.height)) return;
  recCtx.drawImage(canvas, 0, 0, recCanvas.width, recCanvas.height);
  if (recTrack.requestFrame) recTrack.requestFrame();
  recLastFrameAt = performance.now();
}

// Headset: draw the eye's processed texture into the (hidden) page canvas, then record it.
// Only does work while recording, at most REC_FPS times a second.
function recCaptureXR(tex) {
  if (!recDue()) return;
  if (canvas.width !== rtW || canvas.height !== rtH) { canvas.width = rtW; canvas.height = rtH; }
  draw(copyProg, null, tex, null, 0);
  recCaptureFlat();
}

function recFinish() {
  const secs = (performance.now() - recStartedAt) / 1000;
  const type = (recRecorder && recRecorder.mimeType) || recMime || 'video/webm';
  const blob = new Blob(recChunks, { type });
  recRecorder = null; recTrack = null; recChunks = [];
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const name = `vr-visuals-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  const item = { url: URL.createObjectURL(blob), name, size: blob.size, secs, saved: false };
  recDone.push(item);
  recRenderList();
  if (xrSession) recSetStatus(`recorded ${secs.toFixed(0)} s - it is saved when you leave VR`);
  else recDownload(item);
}

function recDownload(item) {
  const a = document.createElement('a');
  a.href = item.url;
  a.download = item.name;
  document.body.append(a);
  a.click();
  a.remove();
  item.saved = true;
  recSetStatus(`saved ${item.name} (Downloads)`);
  recRenderList();
}

// Leaving VR: stop a running recording (saved when it finishes) and save the ones made inside.
function recOnXrEnd() {
  if (recWanted) recStop();
  for (const item of recDone) if (!item.saved) recDownload(item);
}

// Panel list of this visit's recordings, each with a Save link (in case a download was blocked).
function recRenderList() {
  const ul = $('recList');
  ul.textContent = '';
  for (const item of recDone) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = item.url;
    a.download = item.name;
    a.textContent = `Save ${item.secs.toFixed(0)} s, ${(item.size / 1e6).toFixed(1)} MB`;
    a.onclick = () => { item.saved = true; };
    li.append(a, item.saved ? ' (saved)' : '');
    ul.append(li);
  }
}

// ---- in-VR "REC" badge (head-locked, top of the view) ----
const recBadgeCanvas = document.createElement('canvas');
recBadgeCanvas.width = 256; recBadgeCanvas.height = 64;
const recBadgeCtx = recBadgeCanvas.getContext('2d');
let recBadgeTex = null, recBadgeText = '';

function recDrawBadge(pose, layer) {
  if (!recWanted || !hudProg) return;
  const s = Math.floor((performance.now() - recStartedAt) / 1000);
  const text = `REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (text !== recBadgeText || !recBadgeTex) {
    recBadgeText = text;
    const c = recBadgeCtx;
    c.clearRect(0, 0, 256, 64);
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fillRect(0, 0, 256, 64);
    c.fillStyle = '#f33';
    c.beginPath(); c.arc(36, 32, 16, 0, 2 * Math.PI); c.fill();
    c.fillStyle = '#fff';
    c.font = 'bold 34px sans-serif';
    c.fillText(text, 64, 44);
    if (!recBadgeTex) { recBadgeTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, recBadgeTex); setTexParams(); }
    gl.bindTexture(gl.TEXTURE_2D, recBadgeTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, recBadgeCanvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(hudProg.prog);
  bindTex(0, recBadgeTex);
  gl.uniform1i(hudProg.u.u_tex, 0);
  gl.uniform4f(hudProg.u.u_rect, -0.08, 0.30, 0.08, 0.34);   // at distance 1, above the centre
  for (const view of pose.views) {
    const vp = layer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.uniformMatrix4fv(hudProg.u.u_proj, false, view.projectionMatrix);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.disable(gl.BLEND);
}

$('recBtn').onclick = recToggle;
if (!recSupported) recSetStatus('recording is not supported in this browser');
