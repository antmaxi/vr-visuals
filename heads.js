'use strict';
// Head tracking for effects that use u_heads (e.g. effects/head_masks.glsl). Loaded after harness.js
// and uses its globals (and xr.js's captureQ / camFov in the headset); harness.js calls updateHeads()
// and getHeads() once per lane per frame.
//
// Heads are found two ways, loaded from a CDN the first time an enabled effect uses u_heads:
// - MediaPipe's face detector (BlazeFace full range) on a crop. It shrinks its input to 192x192 and
//   needs a face of roughly 15-20 pixels there, so each call looks at only a part of the frame:
//   a crop around a tracked head (so a small, distant or fast-moving face still fills the input),
//   or one of twelve overlapping tiles (4 x 3) to find new faces.
// - MediaPipe's pose landmarker (lite), every few scans, on a small copy of the whole frame. It
//   finds people farther away and from the side or back, where BlazeFace sees no face; a later crop
//   then refines the head.
// Nothing runs while no effect uses u_heads. Calls run only on new camera frames, spaced so
// detection blocks the page at most about a quarter of the time (it runs on the main thread).
// In stereo the two cameras take turns.
//
// Between detections each head is a track. Positions are smoothed with a one-euro filter (steady
// when the head is still, little lag when it moves), matched and predicted from velocity, and faded
// in and out, so a face missed for a moment doesn't make its mask pop or flicker. The whole image's
// shift (or, in the headset, the wearer's head turn) is applied to every track, so masks stay on
// people when the camera pans.
//
// Track coordinates are in the video frame: x, y 0..1 with y up (like the uploaded frame), radius
// r in units of the frame height (half the face box), roll = tilt of the eye line in radians.

const MP_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/latest/blaze_face_full_range.tflite';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const MIN_CONFIDENCE = 0.7;   // real faces score 0.8+; the full-range model finds "faces" in
                              // patterns (flags, hands) at up to about 0.65
const CONFIRM_HITS = 2;       // a new track only fades in once it was detected this many times
const CROP_PX = 256;          // crops are drawn at this size before detection
const ROI_FACES = 3;          // crop around a tracked head: this many face widths across
const ROI_MIN = 0.08;         // ... but at least this fraction of the frame height
const SCAN_EVERY = 3;         // with heads tracked, every 3rd call scans for new faces instead
const TILE_COLS = 4, TILE_ROWS = 3;
const TILE = 0.55;            // scan tiles: squares of this fraction of the frame height (overlap so a
                              // face in the middle of the frame is never in a gap)
const SCAN_STEPS = [-1, -2, 0, 1, 2, 3, 4, 5, -2, 6, 7, 8, 9, 10, 11];
                              // -1 = whole frame (large nearby faces), -2 = pose, 0..11 = tiles
const POSE_W = 320, POSE_H = 180;  // pose runs on this downscaled copy of the whole frame
const SHIFT_W = 48, SHIFT_H = 27, SHIFT_MAX = 4;  // image pan, in these pixels
const BUSY_FRACTION = 0.25;   // detection may block the main thread at most this much of the time
const MIN_GAP_MS = 30;        // ... and runs at most about 30 times a second
const NO_CALLBACKS_MS = 300;  // no new-frame callbacks for this long (some headsets): don't wait for them
const MIN_CUTOFF = 1.5;       // Hz, one-euro filter: smoothing of a still head (lower = steadier, laggier)
const BETA = 3.0;             // ... extra Hz per head radius per second of motion (higher = less lag)
const SIZE_SMOOTH = 0.2;      // s, smoothing of size and tilt (detected size jitters more)
const MAX_EXTRAPOLATE = 0.25; // s, how far ahead of the last detection a moving head is predicted
const HOLD = 0.3;             // s a track stays fully visible after its last detection
const MAX_HOLD = 1.2;         // ... unless it wasn't looked at again: then up to this long
const FADE_IN = 0.15;         // s
const FADE_OUT = 0.4;         // s
const MATCH_DIST = 3;         // a detection continues a track if closer than this many radii
const MERGE_DIST = 0.8;       // two tracks closer than this many radii are the same head
const MAX_ROLL = 0.8;         // rad

let headDetector = null, poseLandmarker = null;
let detectorState = 'off';        // off | loading | ready | failed
let headError = '';
let headDelegate = '';
let detectMs = 0, callGapMs = 0, lastCallAt = 0, nextCallAt = 0, nextLane = 0;
const headTracks = [[], []];  // per lane
const headLastStep = [0, 0];  // per lane, performance.now() of the last track update
const laneFrame = [-1, -1];   // per lane: camera frame count last seen
const laneFrameAt = [0, 0];   // ... when it last changed
const laneFresh = [false, false];  // ... a new frame arrived that wasn't detected on yet
const laneCalls = [0, 0];     // ... detection calls so far (picks crop or scan)
const laneScan = [0, 0];      // ... next scan step
const laneQ = [null, null];   // ... headset orientation the tracks are expressed in
const prevShift = [null, null];    // per lane: previous luma of the pan canvas
const cropCanvas = document.createElement('canvas');
cropCanvas.width = cropCanvas.height = CROP_PX;
const cropCtx = cropCanvas.getContext('2d');
const poseCanvas = document.createElement('canvas');
poseCanvas.width = POSE_W; poseCanvas.height = POSE_H;
const poseCtx = poseCanvas.getContext('2d');
const shiftCanvas = document.createElement('canvas');
shiftCanvas.width = SHIFT_W; shiftCanvas.height = SHIFT_H;
const shiftCtx = shiftCanvas.getContext('2d', { willReadFrequently: true });

// Only run while an enabled effect actually reads u_heads.
function headsWanted() {
  return chain.some((e) => e.enabled && e.prog && e.u['u_heads[0]']);
}

async function loadHeadDetector(delegate = 'GPU') {
  detectorState = 'loading';
  try {
    const { FilesetResolver, FaceDetector, PoseLandmarker } = await import(MP_URL + '/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(MP_URL + '/wasm');
    const make = (d) => FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: d },
      runningMode: 'IMAGE', minDetectionConfidence: MIN_CONFIDENCE });
    try {
      headDetector = await make(delegate);
      headDelegate = delegate;
    } catch (e) {
      if (delegate === 'CPU') throw e;
      console.warn('Face detector: GPU failed, using CPU:', e);
      headDetector = await make('CPU');
      headDelegate = 'CPU';
    }
    detectorState = 'ready';
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: headDelegate },
      runningMode: 'IMAGE', numPoses: 4, minPoseDetectionConfidence: 0.5,
    }).then((p) => { poseLandmarker = p; }).catch((e) => {
      console.warn('Pose landmarker failed to load (distant / side heads will be weaker):', e);
    });
  } catch (e) {
    console.error('Face detector failed to load:', e);
    detectorState = 'failed';
    headError = e.message || String(e);
  }
}

// Time of the lane's current camera frame (performance.now() clock), or now without frame callbacks.
function laneTime(lane, now) {
  return now - laneFrameAt[lane] > NO_CALLBACKS_MS ? now : lanes[lane].frames.presentationTime;
}

// Scan tile i (0..TILE_COLS*TILE_ROWS-1) in frame pixels, y down. Tiles overlap and cover the frame.
function tileRect(i, W, H) {
  const side = Math.min(W, H, TILE * Math.min(W, H));
  const col = i % TILE_COLS, row = Math.floor(i / TILE_COLS);
  return {
    sx: TILE_COLS > 1 ? col * (W - side) / (TILE_COLS - 1) : 0,
    sy: TILE_ROWS > 1 ? row * (H - side) / (TILE_ROWS - 1) : 0,
    side,
  };
}

function visOk(p) { return p && (p.visibility === undefined || p.visibility > 0.4); }

function earRoll(le, re, W, H) {
  let dx = (re.x - le.x) * W, dy = (le.y - re.y) * H;
  if (dx < 0) { dx = -dx; dy = -dy; }
  return clamp(Math.atan2(dy, dx), -MAX_ROLL, MAX_ROLL);
}

// Whole-frame pose: people farther away or turned away, where BlazeFace sees no face.
function detectPose(src) {
  if (!poseLandmarker) return [];
  const W = src.videoWidth, H = src.videoHeight;
  poseCtx.drawImage(src, 0, 0, POSE_W, POSE_H);
  const t0 = performance.now();
  let res;
  try { res = poseLandmarker.detect(poseCanvas); }
  catch (e) {
    console.warn('Pose detection failed:', e);
    poseLandmarker = null;
    return [];
  }
  detectMs += (performance.now() - t0 - detectMs) * 0.2;
  const out = [];
  for (const lm of res.landmarks) {
    const nose = lm[0], le = lm[7], re = lm[8], ls = lm[11], rs = lm[12];
    let x, y, r, roll = 0;
    if (visOk(le) && visOk(re)) {
      x = (le.x + re.x) / 2;
      y = 1 - (le.y + re.y) / 2;
      r = Math.hypot((re.x - le.x) * W, (re.y - le.y) * H) / 2 / H * 1.2;
      roll = earRoll(le, re, W, H);
    } else if (visOk(nose)) {
      x = nose.x;
      y = 1 - nose.y;
      if (visOk(ls) && visOk(rs)) {
        r = Math.hypot((rs.x - ls.x) * W, (rs.y - ls.y) * H) * 0.22 / H;
      } else r = 0.06;
    } else continue;
    if (r < 0.012) continue;
    out.push({ x, y, r, roll });
  }
  return out;
}

// Square crop around where track t is expected now, in frame pixels, y down.
function roiRect(t, W, H, ahead) {
  const side = Math.min(W, H, Math.max(ROI_MIN * H, ROI_FACES * 2 * t.tr * H));
  const cx = (t.tx + t.vx * ahead) * W, cy = (1 - t.ty - t.vy * ahead) * H;
  return { sx: clamp(cx - side / 2, 0, W - side), sy: clamp(cy - side / 2, 0, H - side), side };
}

// Detections in track coordinates [{ x, y, r, roll }], from the whole frame (rect null) or a square crop.
function detectIn(src, rect) {
  const W = src.videoWidth, H = src.videoHeight;
  let img = src, ox = 0, oy = 0, sw = W, sh = H;   // the frame area the detector sees, in pixels
  if (rect) {
    cropCtx.drawImage(src, rect.sx, rect.sy, rect.side, rect.side, 0, 0, CROP_PX, CROP_PX);
    img = cropCanvas; ox = rect.sx; oy = rect.sy; sw = sh = rect.side;
  }
  const iw = rect ? CROP_PX : W, ih = rect ? CROP_PX : H;   // pixel size of what the detector got
  const t0 = performance.now();
  const res = headDetector.detect(img);
  detectMs += (performance.now() - t0 - detectMs) * 0.2;
  const out = [];
  for (const d of res.detections) {
    const b = d.boundingBox;
    if (!b) continue;
    // A face cut off by the crop's edge (inside the frame) has a wrong box; another crop sees it whole.
    if (rect && ((b.originX < 2 && ox > 0) || (b.originY < 2 && oy > 0) ||
        (b.originX + b.width > iw - 2 && ox + sw < W) || (b.originY + b.height > ih - 2 && oy + sh < H))) continue;
    let roll = 0;
    const k = d.keypoints;
    if (k && k.length >= 2) {   // keypoints 0 and 1 = the eyes, normalized, y down
      let dx = (k[1].x - k[0].x) * sw, dy = (k[0].y - k[1].y) * sh;
      if (dx < 0) { dx = -dx; dy = -dy; }   // mirrored image: same tilt either way
      roll = clamp(Math.atan2(dy, dx), -MAX_ROLL, MAX_ROLL);
    }
    out.push({
      x: (ox + (b.originX + b.width / 2) / iw * sw) / W,
      y: 1 - (oy + (b.originY + b.height / 2) / ih * sh) / H,
      r: Math.max(b.width / iw * sw, b.height / ih * sh) / 2 / H,
      roll,
    });
  }
  return out;
}

// Continue the nearest track with each detection (closest pairs first); others start new tracks.
function matchHeads(tracks, dets, now, frameT, aspect) {
  const pairs = [];
  tracks.forEach((t, i) => dets.forEach((d, j) => {
    const ahead = clamp((frameT - t.hitT) / 1000, 0, MAX_EXTRAPOLATE);
    const dist = Math.hypot((d.x - t.tx - t.vx * ahead) * aspect, d.y - t.ty - t.vy * ahead) / Math.max(t.tr, d.r);
    if (dist < MATCH_DIST) pairs.push({ i, j, dist });
  }));
  pairs.sort((a, b) => a.dist - b.dist);
  const usedT = new Set(), usedD = new Set();
  for (const { i, j } of pairs) {
    if (usedT.has(i) || usedD.has(j)) continue;
    usedT.add(i); usedD.add(j);
    const t = tracks[i], d = dets[j];
    const dt = Math.max(0.02, (frameT - t.hitT) / 1000);
    t.vx += ((d.x - t.tx) / dt - t.vx) * 0.5;
    t.vy += ((d.y - t.ty) / dt - t.vy) * 0.5;
    Object.assign(t, { tx: d.x, ty: d.y, tr: d.r, troll: d.roll, lastHit: now, hitT: frameT, hits: t.hits + 1 });
  }
  dets.forEach((d, j) => {
    if (usedD.has(j)) return;
    tracks.push({ x: d.x, y: d.y, r: d.r, roll: d.roll, tx: d.x, ty: d.y, tr: d.r, troll: d.roll,
      vx: 0, vy: 0, alpha: 0, lastHit: now, hitT: frameT, hits: 1, lastLook: 0, missed: false });
  });
}

// Two tracks on the same head (e.g. found by two overlapping scans): keep the more visible one.
function mergeHeads(tracks, aspect) {
  for (let i = tracks.length - 1; i > 0; i--) {
    for (let j = 0; j < i; j++) {
      const a = tracks[i], b = tracks[j];
      if (Math.hypot((a.tx - b.tx) * aspect, a.ty - b.ty) < MERGE_DIST * Math.max(a.tr, b.tr)) {
        tracks.splice(a.alpha > b.alpha ? j : i, 1);
        break;
      }
    }
  }
}

// One detection call: a crop around the track looked at longest ago, or the next scan step.
function runDetection(lane, tracks, src, now) {
  const W = src.videoWidth, H = src.videoHeight;
  const frameT = laneTime(lane, now);
  let looked = null;
  let dets;
  if (tracks.length && laneCalls[lane]++ % SCAN_EVERY !== 0) {
    looked = tracks.reduce((a, b) => (b.lastLook < a.lastLook ? b : a));
    looked.lastLook = now;
    dets = detectIn(src, roiRect(looked, W, H, clamp((frameT - looked.hitT) / 1000, 0, MAX_EXTRAPOLATE)));
  } else {
    const step = SCAN_STEPS[laneScan[lane]++ % SCAN_STEPS.length];
    dets = step === -2 ? detectPose(src)
      : step === -1 ? detectIn(src, null)
      : detectIn(src, tileRect(step, W, H));
  }
  matchHeads(tracks, dets, now, frameT, W / H);
  if (looked) looked.missed = looked.lastHit !== now;
  mergeHeads(tracks, W / H);
}

// Glide each track toward its (slightly extrapolated) detection, fade it in or out.
function stepHeads(tracks, now, frameT, dt, aspect) {
  const ks = 1 - Math.exp(-dt / SIZE_SMOOTH);
  for (const t of tracks) {
    const ahead = clamp((frameT - t.hitT) / 1000, 0, MAX_EXTRAPOLATE);
    const speed = Math.hypot(t.vx * aspect, t.vy) / Math.max(t.r, 1e-3);   // head radii per second
    const km = 1 - Math.exp(-dt * 2 * Math.PI * (MIN_CUTOFF + BETA * speed));
    t.x += (t.tx + t.vx * ahead - t.x) * km;
    t.y += (t.ty + t.vy * ahead - t.y) * km;
    t.r += (t.tr - t.r) * ks;
    t.roll += (t.troll - t.roll) * ks;
    // Fade out only once a crop around the head came up empty (or it went unseen for too long).
    const since = (now - t.lastHit) / 1000;
    if ((since >= HOLD && t.missed) || since >= MAX_HOLD) t.alpha = Math.max(0, t.alpha - dt / FADE_OUT);
    else if (t.hits >= CONFIRM_HITS) t.alpha = Math.min(1, t.alpha + dt / FADE_IN);
  }
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    if (t.alpha <= 0 && (now - t.lastHit) / 1000 > HOLD && (t.missed || t.hits < CONFIRM_HITS)) tracks.splice(i, 1);
  }
}

// Rotate vector v = [x, y, z] by unit quaternion q.
function qRotate(q, v) {
  const [x, y, z] = v;
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
}

// Webcam / video: when the whole image pans, slide every track by that shift (the headset path
// below already does this from head orientation, so skip it there).
function followImage(lane, tracks, src) {
  shiftCtx.drawImage(src, 0, 0, SHIFT_W, SHIFT_H);
  const px = shiftCtx.getImageData(0, 0, SHIFT_W, SHIFT_H).data;
  const luma = new Float32Array(SHIFT_W * SHIFT_H);
  for (let i = 0; i < luma.length; i++) luma[i] = px[4 * i] + px[4 * i + 1] + px[4 * i + 2];
  const prev = prevShift[lane];
  prevShift[lane] = luma;
  if (!prev || !tracks.length) return;
  let best = Infinity, bx = 0, by = 0;
  const x0 = SHIFT_MAX, x1 = SHIFT_W - SHIFT_MAX, y0 = SHIFT_MAX, y1 = SHIFT_H - SHIFT_MAX;
  for (let dy = -SHIFT_MAX; dy <= SHIFT_MAX; dy++) {
    for (let dx = -SHIFT_MAX; dx <= SHIFT_MAX; dx++) {
      let s = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * SHIFT_W, prow = (y - dy) * SHIFT_W - dx;
        for (let x = x0; x < x1; x++) s += Math.abs(luma[row + x] - prev[prow + x]);
      }
      if (s < best) { best = s; bx = dx; by = dy; }
    }
  }
  if (!bx && !by) return;
  const sx = bx / SHIFT_W, sy = -by / SHIFT_H;
  for (const t of tracks) { t.tx += sx; t.ty += sy; t.x += sx; t.y += sy; }
}

// Headset: when the camera's capture orientation changes (the wearer turned), move the tracks
// across the image as the room moved, so masks stay on people until the next detection.
function followHeadset(lane, tracks, src) {
  const q = xrSession && typeof captureQ !== 'undefined' ? captureQ[lane] : null;
  const prev = laneQ[lane];
  laneQ[lane] = q && { x: q.x, y: q.y, z: q.z, w: q.w };
  if (!q || !prev || Math.abs(q.x * prev.x + q.y * prev.y + q.z * prev.z + q.w * prev.w) > 1 - 1e-9) return;
  const W = src.videoWidth, H = src.videoHeight;
  const hx = Math.tan(camFov.value * Math.PI / 360), hy = hx * H / W;
  const rel = qMul(qConj(q), prev);   // old camera direction -> new camera direction
  const move = (x, y) => {
    const d = qRotate(rel, [(x - 0.5) * 2 * hx, (y - 0.5) * 2 * hy, -1]);
    return d[2] < -1e-3 ? [0.5 + d[0] / -d[2] / (2 * hx), 0.5 + d[1] / -d[2] / (2 * hy)] : null;
  };
  for (const t of tracks) {
    const a = move(t.tx, t.ty), b = move(t.tx + 0.01, t.ty), c = move(t.x, t.y);
    if (!a || !b || !c) continue;
    const turn = Math.atan2((b[1] - a[1]) * H, (b[0] - a[0]) * W);   // the wearer's head roll
    t.tx = a[0]; t.ty = a[1]; t.x = c[0]; t.y = c[1];
    t.troll += turn; t.roll += turn;
  }
}

// Called by renderChain for each lane, every frame. Schedules detection itself.
function updateHeads(lane, src, now) {
  if (!headsWanted()) {
    headTracks[0].length = headTracks[1].length = 0;
    laneQ.fill(null);
    prevShift[0] = prevShift[1] = null;
    return;
  }
  if (detectorState === 'off') loadHeadDetector();
  const dt = headLastStep[lane] ? Math.min(0.1, (now - headLastStep[lane]) / 1000) : 0;
  headLastStep[lane] = now;
  const tracks = headTracks[lane];
  const count = lanes[lane].frames.count;
  if (count !== laneFrame[lane]) { laneFrame[lane] = count; laneFrameAt[lane] = now; laneFresh[lane] = true; }
  followHeadset(lane, tracks, src);
  if (laneFresh[lane] && !xrSession) followImage(lane, tracks, src);

  const fresh = laneFresh[lane] || now - laneFrameAt[lane] > NO_CALLBACKS_MS;
  if (detectorState === 'ready' && fresh && now >= nextCallAt && (lane === nextLane || !stereoOn)) {
    laneFresh[lane] = false;
    nextLane = stereoOn ? 1 - lane : 0;
    try {
      runDetection(lane, tracks, src, now);
    } catch (e) {
      console.error('Face detection failed:', e);
      headDetector = null;
      if (headDelegate === 'GPU') loadHeadDetector('CPU');
      else { detectorState = 'failed'; headError = e.message || String(e); }
    }
    const end = performance.now();
    nextCallAt = end + Math.max(MIN_GAP_MS, (end - now) * (1 - BUSY_FRACTION) / BUSY_FRACTION);
    if (lastCallAt) callGapMs += (now - lastCallAt - callGapMs) * 0.1;
    lastCallAt = now;
  }
  stepHeads(tracks, now, laneTime(lane, now), dt, src.videoWidth / src.videoHeight);
}

// Visible tracks for a lane, largest first (at most MAX_HEADS).
function getHeads(lane) {
  const t = headTracks[lane].filter((h) => h.alpha > 0);
  if (t.length > MAX_HEADS) t.sort((a, b) => b.r - a.r).length = MAX_HEADS;
  return t;
}

// Short status for the stats line ('' while no effect uses heads).
function headsInfo() {
  if (detectorState === 'off' || !headsWanted()) return '';
  if (detectorState === 'loading') return 'heads: loading face detector';
  if (detectorState === 'failed') return 'heads: detector failed - ' + headError;
  const rate = callGapMs > 0 ? (1000 / callGapMs).toFixed(0) : '-';
  return `heads ${getHeads(0).length} (detect ${detectMs.toFixed(0)} ms, ${rate}/s, ${headDelegate}${poseLandmarker ? '+pose' : ''})`;
}
