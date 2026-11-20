// Simulated calibration with the rig the generator makes - the backend of /simulate.
//
// Photographs the printable geometry (render.js) through a known camera, then runs the same pipeline
// as calibrate.py with OpenCV (opencv.js in Node): ArUco detection, 2D-3D correspondences from the
// rig, Zhang's calibration with every face of every view as a planar target, and solvePnP per view.
// Because the camera and every pose are known, every estimate can be compared with the truth.
//
//   single view: one photo. A 3D rig still gives three tilted planes - enough for the focal length
//                and principal point; one plane gives one, so only the focal length can be solved.
//   multi-view:  N photos from around the rig, most aimed off-centre so the markers reach the image
//                edges where lens distortion is measurable.
import { buildRig } from '../rig/rigModel.js';
import { buildRigMesh } from '../rig/rigMesh.js';
import { renderView, lookFrom, mulberry32 } from './render.js';
import { encodePng } from './png.js';

export const SIM_DEFAULTS = {
  views: 'multi',
  nViews: 8,
  noise: 2,          // sensor noise, grey levels (sigma)
  seed: 1,
  distanceMm: [330, 470],
  hfovGuessDeg: 60,  // what calibration starts from - it does not know the true camera
  camera: { W: 1280, H: 960, fx: 1100, fy: 1100, cx: 645, cy: 478, k1: -0.08, k2: 0.02, p1: 0, p2: 0, k3: 0 },
};

// calibrateCamera's flag values (calib3d.hpp). Do NOT take these from opencv.js: that build exports
// the cv::fisheye constants under the same names (there CALIB_FIX_K1 = 16, which calibrateCamera
// reads as CALIB_FIX_FOCAL_LENGTH; CALIB_FIX_PRINCIPAL_POINT = 512 = CALIB_SAME_FOCAL_LENGTH).
const CALIB = { USE_INTRINSIC_GUESS: 1, FIX_ASPECT_RATIO: 2, FIX_PRINCIPAL_POINT: 4, ZERO_TANGENT_DIST: 8,
                FIX_K1: 32, FIX_K2: 64, FIX_K3: 128 };

const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sub = (a, b) => a.map((x, i) => x - b[i]);
const add = (a, b) => a.map((x, i) => x + b[i]);
const scale = (a, s) => a.map((x) => x * s);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const normv = (a) => scale(a, 1 / Math.hypot(...a));

function viewpoints(rig, views, n, rng, [dmin, dmax]) {
  const centre = rig.tags.reduce((s, t) => add(s, scale(t.center, 1 / rig.tags.length)), [0, 0, 0]);
  const plane = rig.params.mode === 'plane';
  const deg = Math.PI / 180;
  const at = (az, el, r) => add(centre, scale([Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)], r));
  if (views === 'single') {
    return [{ eye: plane ? at(30 * deg, 55 * deg, 400) : at(45 * deg, 40 * deg, 400), aim: centre }];
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    const az = plane ? rng() * 2 * Math.PI : (20 + 50 * rng()) * deg;
    const el = plane ? (35 + 35 * rng()) * deg : (25 + 30 * rng()) * deg;
    const r = dmin + (dmax - dmin) * rng();
    // aim past the rig in most photos so it lands towards the image edges
    const aim = k % 4 ? add(centre, [(rng() * 2 - 1) * 110, (rng() * 2 - 1) * 110, (rng() * 2 - 1) * 66]) : centre;
    out.push({ eye: at(az, el, r), aim });
  }
  return out;
}

function makeDetector(cv) {
  const dict = cv.getPredefinedDictionary(cv.DICT_ARUCO_ORIGINAL);
  const params = new cv.aruco_DetectorParameters();
  params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
  const refine = new cv.aruco_RefineParameters(10, 3, true);
  return { det: new cv.aruco_ArucoDetector(dict, params, refine), free: () => [dict, params, refine].forEach((o) => o.delete?.()) };
}

function detect(cv, detector, gray) {
  const corners = new cv.MatVector(), ids = new cv.Mat(), rejected = new cv.MatVector();
  try {
    detector.det.detectMarkers(gray, corners, ids, rejected);
    const out = [];
    for (let i = 0; i < ids.rows; i++) {
      const c = corners.get(i);
      const d = Array.from(c.data32F);
      c.delete();
      out.push({ id: ids.data32S[i], corners: [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]] });
    }
    return out;
  } finally {
    corners.delete(); ids.delete(); rejected.delete();
  }
}

// a tag's corners in its own face, 2D, z = 0 (mm): all planar calibration needs
function planeLocal(rig, tag) {
  const p = rig.planes.find((q) => q.name === tag.plane);
  return tag.corners.map((c) => [dot(c, p.u), -dot(c, p.v), 0]);
}

const rotAngleDeg = (A, B) => {   // angle of A^T B, both 3x3 row arrays
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += A[k][i] * B[k][i];
  return Math.acos(clamp((tr - 1) / 2, -1, 1)) * 180 / Math.PI;
};

function fov(K, W, H) {
  const d = (x) => +(2 * Math.atan(x) * 180 / Math.PI).toFixed(2);
  return { h: d(W / (2 * K[0])), v: d(H / (2 * K[4])), d: d(Math.hypot(W / K[0], H / K[4]) / 2) };
}

export function simulate(cv, request = {}) {
  const T0 = Date.now();
  const rig = buildRig(request.rig || {});
  const meshes = buildRigMesh(rig);
  const cam = { ...SIM_DEFAULTS.camera };
  for (const k of Object.keys(cam)) cam[k] = num(request.camera?.[k], cam[k]);
  cam.W = clamp(Math.round(cam.W), 320, 1920);
  cam.H = clamp(Math.round(cam.H), 240, 1440);
  const views = request.views === 'single' ? 'single' : 'multi';
  const n = views === 'single' ? 1 : clamp(Math.round(num(request.nViews, SIM_DEFAULTS.nViews)), 2, 16);
  const noise = clamp(num(request.noise, SIM_DEFAULTS.noise), 0, 40);
  const seed = Math.round(num(request.seed, SIM_DEFAULTS.seed));
  const rng = mulberry32(seed);
  const poses = viewpoints(rig, views, n, rng, SIM_DEFAULTS.distanceMm);
  const tagById = new Map(rig.tags.map((t) => [t.id, t]));
  const timing = {};

  // ---- photograph and detect ------------------------------------------------------------
  let t = Date.now();
  const shots = poses.map((p, i) => {
    const { R, t: tv } = lookFrom(p.eye, p.aim);
    return { i, eye: p.eye, aim: p.aim, R, t: tv, gray: renderView(meshes, cam, R, tv, { noise, rng }) };
  });
  timing.render_ms = Date.now() - t;
  t = Date.now();
  const detector = makeDetector(cv);
  for (const s of shots) {
    const m = cv.matFromArray(cam.H, cam.W, cv.CV_8UC1, s.gray);
    s.dets = detect(cv, detector, m).filter((d) => tagById.has(d.id));
    m.delete();
    // markers that face the camera and fall inside the frame: what a perfect detector would find
    s.visible = rig.tags.filter((tag) => {
      const pl = rig.planes.find((q) => q.name === tag.plane);
      const c = s.R.map((row, k) => dot(row, tag.center) + s.t[k]);
      const nrm = s.R.map((row) => dot(row, pl.normal));
      if (c[2] <= 0 || dot(nrm, scale(c, -1)) <= 0) return false;
      return tag.corners.every((q) => {
        const qc = s.R.map((row, k) => dot(row, q) + s.t[k]);
        const u = cam.fx * qc[0] / qc[2] + cam.cx, v = cam.fy * qc[1] / qc[2] + cam.cy;
        return u > 2 && v > 2 && u < cam.W - 3 && v < cam.H - 3;
      });
    }).length;
  }
  detector.free();
  timing.detect_ms = Date.now() - t;

  // ---- calibrate: every face of every view is a planar target ----------------------------------
  t = Date.now();
  const objVec = new cv.MatVector(), imgVec = new cv.MatVector();
  const labels = [];
  let nPts = 0, reach = 0;
  const halfDiag = Math.hypot(cam.W, cam.H) / 2;
  for (const s of shots) {
    const per = new Map();
    for (const d of s.dets) {
      const tag = tagById.get(d.id);
      if (!per.has(tag.plane)) per.set(tag.plane, []);
      per.get(tag.plane).push([d, tag]);
    }
    for (const [plane, items] of per) {
      if (items.length < 2) continue;
      const obj = items.flatMap(([, tag]) => planeLocal(rig, tag).flat());
      const img = items.flatMap(([d]) => d.corners.flat());
      for (let k = 0; k < img.length; k += 2) reach = Math.max(reach, Math.hypot(img[k] - cam.W / 2, img[k + 1] - cam.H / 2) / halfDiag);
      objVec.push_back(cv.matFromArray(obj.length / 3, 1, cv.CV_32FC3, obj));
      imgVec.push_back(cv.matFromArray(img.length / 2, 1, cv.CV_32FC2, img));
      labels.push(`view ${s.i} ${plane}`);
      nPts += img.length / 2;
    }
  }
  if (!labels.length) {
    objVec.delete(); imgVec.delete();
    return { ok: false, error: 'no view had 2+ markers of one face detected - nothing to calibrate from', shots: shots.map((s) => ({ i: s.i, detected: s.dets.length })) };
  }
  // same rules as calibrate.py: tangential terms 0; k2 only with 120+ corners reaching 60 % of the
  // way to the image corners; k1 fixed if they stay within 30 %; fewer than 3 planar views: the
  // principal point stays at the centre and fx = fy
  let flags = CALIB.USE_INTRINSIC_GUESS | CALIB.FIX_K3 | CALIB.ZERO_TANGENT_DIST;
  const notes = ['k3 and tangential p1, p2 fixed at 0'];
  if (nPts < 120 || reach < 0.6) { flags |= CALIB.FIX_K2; notes.push(`k2 fixed: ${nPts} corners reaching ${Math.round(reach * 100)} % of the way to the image corners`); }
  if (reach < 0.3) { flags |= CALIB.FIX_K1; notes.push('k1 fixed too: markers stayed near the image centre'); }
  const f0 = (cam.W / 2) / Math.tan(SIM_DEFAULTS.hfovGuessDeg * Math.PI / 360);
  const K = cv.matFromArray(3, 3, cv.CV_64F, [f0, 0, cam.W / 2, 0, f0, cam.H / 2, 0, 0, 1]);
  if (labels.length < 3) { flags |= CALIB.FIX_PRINCIPAL_POINT | CALIB.FIX_ASPECT_RATIO; notes.push(`only ${labels.length} planar view(s): principal point fixed at the image centre, fx = fy`); }
  const D = cv.Mat.zeros(1, 5, cv.CV_64F);
  const rvecs = new cv.MatVector(), tvecs = new cv.MatVector();
  const sdi = new cv.Mat(), sde = new cv.Mat(), pve = new cv.Mat();
  const crit = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 100, 1e-12);
  const rms = cv.calibrateCameraExtended(objVec, imgVec, new cv.Size(cam.W, cam.H), K, D, rvecs, tvecs, sdi, sde, pve, flags, crit);
  const Kd = Array.from(K.data64F), Dd = Array.from(D.data64F);
  const perView = labels.map((l, k) => ({ view: l, rms_px: +pve.data64F[k].toFixed(3) }));
  [objVec, imgVec, rvecs, tvecs, sdi, sde, pve].forEach((m) => m.delete());
  timing.calibrate_ms = Date.now() - t;

  // ---- pose of every view with the calibrated camera, against the truth ------------------------
  t = Date.now();
  const results = shots.map((s) => {
    const r = { i: s.i, detected: s.dets.length, visible: s.visible, distance_mm: +Math.hypot(...sub(s.eye, s.aim)).toFixed(1) };
    const rgb = new cv.Mat();
    const g = cv.matFromArray(cam.H, cam.W, cv.CV_8UC1, s.gray);
    cv.cvtColor(g, rgb, cv.COLOR_GRAY2RGB);
    g.delete();
    for (const d of s.dets) {
      for (let k = 0; k < 4; k++) {
        const a = d.corners[k], b = d.corners[(k + 1) % 4];
        cv.line(rgb, new cv.Point(a[0], a[1]), new cv.Point(b[0], b[1]), new cv.Scalar(0, 200, 0, 255), 2);
      }
      cv.circle(rgb, new cv.Point(d.corners[0][0], d.corners[0][1]), 5, new cv.Scalar(255, 220, 0, 255), -1);
      cv.putText(rgb, String(d.id), new cv.Point(d.corners[0][0], d.corners[0][1] - 8), cv.FONT_HERSHEY_SIMPLEX, 0.9, new cv.Scalar(0, 90, 255, 255), 2);
    }
    if (s.dets.length >= 2 || (s.dets.length === 1)) {
      const obj = s.dets.flatMap((d) => tagById.get(d.id).corners.flat());
      const img = s.dets.flatMap((d) => d.corners.flat());
      const O = cv.matFromArray(obj.length / 3, 1, cv.CV_64FC3, obj), I = cv.matFromArray(img.length / 2, 1, cv.CV_64FC2, img);
      const rvec = new cv.Mat(), tvec = new cv.Mat(), Rm = new cv.Mat(), proj = new cv.Mat();
      if (cv.solvePnP(O, I, K, D, rvec, tvec, false, s.dets.length === 1 ? cv.SOLVEPNP_IPPE : cv.SOLVEPNP_ITERATIVE)) {
        cv.Rodrigues(rvec, Rm);
        const Rr = [0, 1, 2].map((k) => Array.from(Rm.data64F.slice(3 * k, 3 * k + 3)));
        const tt = Array.from(tvec.data64F);
        const camPos = [0, 1, 2].map((k) => -(Rr[0][k] * tt[0] + Rr[1][k] * tt[1] + Rr[2][k] * tt[2]));
        cv.projectPoints(O, rvec, tvec, K, D, proj);
        const P = proj.data64F;
        let e2 = 0;
        for (let k = 0; k < img.length; k += 2) e2 += (P[k] - img[k]) ** 2 + (P[k + 1] - img[k + 1]) ** 2;
        for (let k = 0; k < P.length; k += 2) cv.circle(rgb, new cv.Point(P[k], P[k + 1]), 3, new cv.Scalar(255, 0, 255, 255), -1);
        cv.drawFrameAxes(rgb, K, D, rvec, tvec, 40, 4);
        Object.assign(r, {
          reproj_rms_px: +Math.sqrt(e2 / (img.length / 2)).toFixed(3),
          camera_mm: camPos.map((v) => +v.toFixed(2)),
          true_camera_mm: s.eye.map((v) => +v.toFixed(2)),
          position_error_mm: +Math.hypot(...sub(camPos, s.eye)).toFixed(3),
          rotation_error_deg: +rotAngleDeg(Rr, s.R).toFixed(4),
        });
      }
      [O, I, rvec, tvec, Rm, proj].forEach((m) => m.delete());
    }
    const small = new cv.Mat();
    const w = 640, h = Math.round(640 * cam.H / cam.W);
    cv.resize(rgb, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    r.png = encodePng(small.data, w, h, 3).toString('base64');
    r.size = [w, h];
    rgb.delete(); small.delete();
    return r;
  });
  K.delete(); D.delete();
  timing.pose_ms = Date.now() - t;
  timing.total_ms = Date.now() - T0;

  const Kt = [cam.fx, 0, cam.cx, 0, cam.fy, cam.cy, 0, 0, 1];
  const posed = results.filter((r) => r.position_error_mm !== undefined);
  return {
    ok: true,
    views, n, noise, seed,
    rig: { mode: rig.params.mode, name: rig.params.mode === 'plane' ? 'one plane' : '3D rig', markers: rig.tags.length,
           faces: rig.planes.map((p) => p.name), ids: [rig.tags[0].id, rig.tags[rig.tags.length - 1].id], params: rig.params },
    camera_true: { ...cam, fov_deg: fov(Kt, cam.W, cam.H) },
    calibration: { K: [Kd.slice(0, 3), Kd.slice(3, 6), Kd.slice(6, 9)], dist: Dd, rms_px: +rms.toFixed(4),
                   planar_views: labels.length, corners: nPts, reach: +reach.toFixed(2), notes, per_view: perView,
                   fov_deg: fov(Kd, cam.W, cam.H) },
    comparison: {
      fx_error_pct: +((Kd[0] - cam.fx) / cam.fx * 100).toFixed(3),
      fy_error_pct: +((Kd[4] - cam.fy) / cam.fy * 100).toFixed(3),
      principal_point_error_px: +Math.hypot(Kd[2] - cam.cx, Kd[5] - cam.cy).toFixed(2),
      k1: { true: cam.k1, estimated: +Dd[0].toFixed(4) }, k2: { true: cam.k2, estimated: +Dd[1].toFixed(4) },
      position_error_mm: posed.length ? { mean: +(posed.reduce((s, r) => s + r.position_error_mm, 0) / posed.length).toFixed(3), max: Math.max(...posed.map((r) => r.position_error_mm)) } : null,
      rotation_error_deg: posed.length ? { max: Math.max(...posed.map((r) => r.rotation_error_deg)) } : null,
      detected: { markers: results.reduce((s, r) => s + r.detected, 0), visible: results.reduce((s, r) => s + r.visible, 0) },
    },
    shots: results,
    timing,
  };
}
