#!/usr/bin/env python3
"""calibrate.py - camera calibration with a MeshCalibrate ArUco rig (3D corner rig or one plane).

Downloaded from MeshCalibrate, this file carries the rig it was made for (RIG_JSON below),
so nothing else is needed:

    python calibrate.py photo1.jpg photo2.jpg ...      calibrate from photos (files, folders, globs)
    python calibrate.py --webcam 0                     take the photos live: SPACE keeps a frame, Q ends
    python calibrate.py --intrinsics calibration.json photo.jpg
                                                       known camera: only solve where it is (pose)
    python calibrate.py --rig rig.json ...             use another rig.json instead of the embedded one

Options: --method planes|rig3d   --hfov DEG (starting guess, default 60)   --out calibration.json
         --yaml calibration.yaml (OpenCV FileStorage)   --annotate DIR (draw what was found)
Needs:   python3, numpy, opencv-python >= 4.7 (anything with cv2.aruco)

How it works
  1. Detection. OpenCV's ArUco detector finds each marker: its id and its 4 corners, always in
     the order top-left, top-right, bottom-right, bottom-left as printed (sub-pixel refined).
  2. Alignment. The rig file lists the same 4 corners of every marker in millimetres in the rig
     frame (origin = the inner corner where the faces meet, +z up out of the floor). Each detected
     marker therefore gives 4 pairs "this pixel is that 3D point". If ids repeat on a rig, pose
     hypotheses decide which marker is which (the one that explains most detections wins).
  3. Intrinsics. Method 'planes' (default) treats every face of the rig in every photo as its own
     flat target (Zhang's method, cv2.calibrateCamera): the 3D rig gives three tilted planes in one
     photo; the one-plane plate needs 3+ photos from different angles. Method 'rig3d' uses the whole
     3D rig as one non-planar target per photo. Distortion terms are freed only when there are
     enough corners to pin them down.
  4. Pose. With K and distortion known, solvePnP gives each photo's camera pose: where the camera
     was, in millimetres from the rig origin, and how it was turned. The reprojection error (rms
     pixel distance between detected corners and the rig projected back) says how well it all fits;
     below ~0.5 px is good.

Output: calibration.json - K, distortion (k1 k2 p1 p2 k3), rms, field of view, and for every photo
the camera pose in the rig frame (T_rig_cam: p_rig = T_rig_cam p_cam, metres) and its error.
"""
import argparse
import glob
import json
import math
import os
import sys

import numpy as np

try:
    import cv2
    cv2.aruco.DICT_ARUCO_ORIGINAL
except (ImportError, AttributeError):
    sys.exit('calibrate.py needs OpenCV with ArUco: pip install opencv-python numpy')

# ==== begin library: MeshCalibrate's stereo_calibrate.py download includes from here to 'end library' ====
# The rig this file was downloaded for (MeshCalibrate rig.json, millimetres). None in the
# repository copy: pass --rig rig.json there.
RIG_JSON = None  # @@RIG_JSON@@


# ---------------------------------------------------------------------------------------------
# rig
# ---------------------------------------------------------------------------------------------
class Rig:
    def __init__(self, data):
        self.name = data.get('name', 'rig')
        self.dictionary = data.get('dictionary', 'DICT_ARUCO_ORIGINAL')
        self.planes = {}
        for p in data['planes']:
            self.planes[p['name']] = {k: np.asarray(p[k], float) for k in ('normal', 'u', 'v')}
            self.planes[p['name']]['origin'] = np.asarray(p.get('origin', [0, 0, 0]), float) / 1000.0
        self.tags = []
        for t in data['tags']:
            if t.get('corners') is None:
                continue
            self.tags.append({'id': int(t['id']), 'plane': t['plane'], 'size_mm': float(t['size_mm']),
                              'corners': np.asarray(t['corners'], float).reshape(4, 3) / 1000.0})
        if not self.tags:
            raise ValueError('the rig has no markers with corners')
        self.by_id = {}
        for i, t in enumerate(self.tags):
            self.by_id.setdefault(t['id'], []).append(i)
        self.repeated = sorted(i for i, v in self.by_id.items() if len(v) > 1)

    def plane_local(self, t):
        """Corners in the marker's own face, 2D (z = 0), metres: all that planar calibration needs."""
        p = self.planes[t['plane']]
        c = t['corners'] - p['origin']
        return np.stack([c @ p['u'], c @ -p['v'], np.zeros(4)], axis=1)


def load_rig(path):
    if path:
        with open(path) as fh:
            return Rig(json.load(fh))
    if RIG_JSON:
        return Rig(json.loads(RIG_JSON))
    sys.exit('no rig: this copy of calibrate.py has no rig built in - pass --rig rig.json '
             '(or download calibrate.py from MeshCalibrate, which embeds it)')


# ---------------------------------------------------------------------------------------------
# detection and matching
# ---------------------------------------------------------------------------------------------
def make_detector(dictionary):
    d = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, dictionary))
    if hasattr(cv2.aruco, 'ArucoDetector'):
        p = cv2.aruco.DetectorParameters()
        p.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
        det = cv2.aruco.ArucoDetector(d, p)
        return lambda g: det.detectMarkers(g)[:2]
    p = cv2.aruco.DetectorParameters_create()
    p.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    return lambda g: cv2.aruco.detectMarkers(g, d, parameters=p)[:2]


def detect(detector, gray):
    corners, ids = detector(gray)
    out = []
    if ids is not None:
        for c, i in zip(corners, ids.flatten()):
            c = c.reshape(4, 2).astype(np.float64)
            out.append({'id': int(i), 'corners': c,
                        'side_px': float(np.mean(np.linalg.norm(c - np.roll(c, 1, axis=0), axis=1)))})
    return out


def rot_angle_deg(R):
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))


def match(dets, rig, K, dist, thr_frac=0.35, min_thr_px=3.0):
    """Which rig marker is each detection, and the rig pose. Each (detection, marker with that id)
    pair proposes a pose (IPPE, 2 solutions); the pose that explains most detections - projected
    marker within ~1/3 of a marker of the detection, facing the camera - is refined with all of
    them. With unique ids this is plain PnP with outlier rejection; with repeated ids it is what
    tells two markers with the same id apart."""
    cand = [rig.by_id.get(d['id'], []) for d in dets]
    if not any(cand):
        return None
    tags = rig.tags
    pts = np.concatenate([t['corners'] for t in tags])
    centres = [t['corners'].mean(axis=0) for t in tags]
    normals = [rig.planes[t['plane']]['normal'] for t in tags]
    thr = [max(min_thr_px, thr_frac * d['side_px']) for d in dets]

    def evaluate(rvec, tvec):
        R = cv2.Rodrigues(rvec)[0]
        proj = cv2.projectPoints(pts, rvec, tvec, K, dist)[0].reshape(-1, 2)
        assign, err = {}, {}
        for j, d in enumerate(dets):
            best = None
            for ti in cand[j]:
                c = R @ centres[ti] + tvec
                if c[2] <= 0 or (R @ normals[ti]) @ (-c) <= 0:
                    continue
                e = float(np.mean(np.linalg.norm(proj[4 * ti:4 * ti + 4] - d['corners'], axis=1)))
                if best is None or e < best[1]:
                    best = (ti, e)
            if best and best[1] < thr[j]:
                assign[j], err[j] = best
        return assign, err

    hyps = []
    for j, d in enumerate(dets):
        for ti in cand[j]:
            n, rvecs, tvecs, _ = cv2.solvePnPGeneric(tags[ti]['corners'], d['corners'], K, dist,
                                                      flags=cv2.SOLVEPNP_IPPE)
            for r, t in zip(rvecs, tvecs):
                r, t = r.reshape(3), t.reshape(3)
                if t[2] > 0:
                    a, e = evaluate(r, t)
                    if a:
                        hyps.append((len(a), -sum(e.values()) / len(e), r, t, a))
    if not hyps:
        return None
    hyps.sort(key=lambda h: (h[0], h[1]), reverse=True)
    finals, seen = [], set()
    for n_in, _, r, t, a in hyps:
        sig = tuple(sorted(a.items()))
        if sig in seen:
            continue
        seen.add(sig)
        if n_in < hyps[0][0] - 1 or len(finals) >= 6:
            break
        try:
            for _ in range(2):
                obj = np.concatenate([tags[ti]['corners'] for ti in a.values()])
                img = np.concatenate([dets[j]['corners'] for j in a])
                _, r, t = cv2.solvePnP(obj, img, K, dist, r.copy(), t.copy(), True, cv2.SOLVEPNP_ITERATIVE)
                r, t = r.reshape(3), t.reshape(3)
                a, _ = evaluate(r, t)
                if not a:
                    break
        except cv2.error:
            continue
        if a:
            obj = np.concatenate([tags[ti]['corners'] for ti in a.values()])
            img = np.concatenate([dets[j]['corners'] for j in a])
            res = np.linalg.norm(cv2.projectPoints(obj, r, t, K, dist)[0].reshape(-1, 2) - img, axis=1)
            finals.append({'assign': a, 'rvec': r, 'tvec': t, 'n': len(a), 'rms': float(np.sqrt(np.mean(res ** 2)))})
    if not finals:
        return None
    finals.sort(key=lambda f: (f['n'], -f['rms']), reverse=True)
    best = finals[0]
    rivals = [f for f in finals[1:] if f['n'] == best['n'] and f['rms'] < 1.5 * best['rms'] + 0.3 and
              rot_angle_deg(cv2.Rodrigues(f['rvec'])[0].T @ cv2.Rodrigues(best['rvec'])[0]) > 10]
    if rivals:   # only a rig with repeated ids can tie: prefer the camera above the floor, rig up = image up
        def plausible(f):
            R = cv2.Rodrigues(f['rvec'])[0]
            return (float(-(R.T @ f['tvec'])[2]) > 0, float(-R[1, 2]))
        best = max([best] + rivals, key=plausible)
    best['ambiguous'] = bool(rivals)
    return best


# ---------------------------------------------------------------------------------------------
# calibration and pose
# ---------------------------------------------------------------------------------------------
def guess_K(w, h, hfov):
    f = (w / 2.0) / math.tan(math.radians(hfov) / 2.0)
    return np.array([[f, 0, w / 2.0], [0, f, h / 2.0], [0, 0, 1]])


def fov_deg(K, size):
    w, h = size
    return {'h': round(math.degrees(2 * math.atan(w / (2 * K[0, 0]))), 2),
            'v': round(math.degrees(2 * math.atan(h / (2 * K[1, 1]))), 2),
            'd': round(math.degrees(2 * math.atan(math.hypot(w / K[0, 0], h / K[1, 1]) / 2)), 2)}


def calibrate(views, rig, size, K0, method):
    """views: [(name, dets, assign)]. Returns the calibration dict."""
    obj_l, img_l, labels = [], [], []
    for name, dets, assign in views:
        if method == 'rig3d':
            if len({rig.tags[ti]['plane'] for ti in assign.values()}) < 2:
                continue
            obj_l.append(np.concatenate([rig.tags[ti]['corners'] for ti in assign.values()]).astype(np.float32))
            img_l.append(np.concatenate([dets[j]['corners'] for j in assign]).astype(np.float32))
            labels.append(name)
            continue
        per = {}
        for j, ti in assign.items():
            per.setdefault(rig.tags[ti]['plane'], []).append((j, ti))
        for plane, items in per.items():
            if len(items) < 2:
                continue
            obj_l.append(np.concatenate([rig.plane_local(rig.tags[ti]) for _, ti in items]).astype(np.float32))
            img_l.append(np.concatenate([dets[j]['corners'] for j, _ in items]).astype(np.float32))
            labels.append(f'{name} [{plane}]')
    if not obj_l:
        sys.exit('nothing to calibrate from: no photo has 2+ matched markers on one face'
                 + (' (rig3d needs 2 faces per photo)' if method == 'rig3d' else ''))
    n_pts = sum(len(o) for o in obj_l)
    # Distortion lives at the image edges: free a term only when there are enough corners AND
    # they reach far enough out. (Corners only near the centre let k2 run away - seen in tests.)
    half_diag = math.hypot(size[0], size[1]) / 2.0
    reach = max(float(np.max(np.hypot(i[:, 0] - size[0] / 2.0, i[:, 1] - size[1] / 2.0)))
                for i in img_l) / half_diag
    # tangential terms (p1, p2) stay 0: webcam lenses have next to none, and freeing them lets the
    # principal point wander (measured: 13 px on synthetic photos)
    flags = cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_K3 | cv2.CALIB_ZERO_TANGENT_DIST
    notes = ['k3 and tangential p1, p2 fixed at 0']
    if n_pts < 120 or reach < 0.6:
        flags |= cv2.CALIB_FIX_K2
        notes.append(f'k2 fixed: {n_pts} corners reaching {reach:.0%} of the way to the '
                     'image corners (freed with 120+ corners reaching 60%: put the rig near the edges in some photos)')
    if reach < 0.3:
        flags |= cv2.CALIB_FIX_K1
        notes.append(f'k1 fixed too: the markers never got further than {reach:.0%} of the way to the corners')
    K = K0.copy()
    if len(obj_l) < 3:
        flags |= cv2.CALIB_FIX_PRINCIPAL_POINT | cv2.CALIB_FIX_ASPECT_RATIO
        K[0, 2], K[1, 2] = size[0] / 2.0, size[1] / 2.0
        notes.append(f'only {len(obj_l)} views: principal point at the image centre, fx = fy '
                     '(more photos from other angles fix this)')
    rms, K, dist, rvecs, tvecs = cv2.calibrateCamera(obj_l, img_l, tuple(size), K, None, flags=flags)
    per_view = []
    for o, i, r, t, lab in zip(obj_l, img_l, rvecs, tvecs, labels):
        e = np.linalg.norm(cv2.projectPoints(o, r, t, K, dist)[0].reshape(-1, 2) - i, axis=1)
        per_view.append({'view': lab, 'rms_px': round(float(np.sqrt(np.mean(e ** 2))), 3), 'points': len(o)})
    return {'K': K, 'dist': dist.reshape(-1), 'rms_px': float(rms), 'method': method, 'n_views': len(obj_l),
            'n_points': n_pts, 'notes': notes, 'per_view': per_view}


def rpy_deg(R):
    return [math.degrees(math.atan2(R[2, 1], R[2, 2])), math.degrees(math.asin(max(-1, min(1, -R[2, 0])))),
            math.degrees(math.atan2(R[1, 0], R[0, 0]))]


def draw(img, dets, m, rig, K, dist, path):
    vis = img.copy() if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if dets:
        cv2.aruco.drawDetectedMarkers(vis, [d['corners'].reshape(1, 4, 2).astype(np.float32) for d in dets],
                                      np.array([[d['id']] for d in dets]))
    if m:
        pts = np.concatenate([rig.tags[ti]['corners'] for ti in m['assign'].values()])
        for p in cv2.projectPoints(pts, m['rvec'], m['tvec'], K, dist)[0].reshape(-1, 2):
            cv2.circle(vis, (int(round(p[0])), int(round(p[1]))), 3, (255, 0, 255), -1)
        cv2.drawFrameAxes(vis, K, dist, m['rvec'], m['tvec'], 0.05, 2)
    cv2.imwrite(path, vis)


# ---------------------------------------------------------------------------------------------
# input
# ---------------------------------------------------------------------------------------------
def expand(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            out += sorted(f for f in glob.glob(os.path.join(p, '*'))
                          if f.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff')))
        else:
            out += sorted(glob.glob(p)) or [p]
    return out


def webcam(index, size, outdir, detector):
    os.makedirs(outdir, exist_ok=True)
    cap = cv2.VideoCapture(index)
    if size:
        w, h = size
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
    if not cap.isOpened():
        sys.exit(f'cannot open camera {index}')
    kept = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        dets = detect(detector, cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        vis = frame.copy()
        if dets:
            cv2.aruco.drawDetectedMarkers(vis, [d['corners'].reshape(1, 4, 2).astype(np.float32) for d in dets],
                                          np.array([[d['id']] for d in dets]))
        cv2.putText(vis, f'{len(dets)} markers  SPACE keep ({len(kept)} kept)  Q done', (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
        cv2.imshow('calibrate.py', vis)
        k = cv2.waitKey(1) & 0xFF
        if k == 32:
            path = os.path.join(outdir, f'frame_{len(kept):03d}.png')
            cv2.imwrite(path, frame)
            kept.append(path)
        elif k in (ord('q'), 27):
            break
    cap.release()
    cv2.destroyAllWindows()
    return kept


# ==== end library ====


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__[__doc__.index('Options:'):])
    ap.add_argument('images', nargs='*', help='photos of the rig: files, folders or globs')
    ap.add_argument('--rig', help='rig.json to use instead of the one built into this file')
    ap.add_argument('--method', choices=['planes', 'rig3d'], default='planes')
    ap.add_argument('--hfov', type=float, default=60.0, help='starting guess for the horizontal FOV, degrees')
    ap.add_argument('--intrinsics', help='calibration.json of a known camera: skip calibration, only solve poses')
    ap.add_argument('--webcam', type=int, help='take the photos from this camera index first')
    ap.add_argument('--size', help='webcam frame size, e.g. 1280x720')
    ap.add_argument('--out', default='calibration.json')
    ap.add_argument('--yaml', help='also write OpenCV FileStorage YAML here')
    ap.add_argument('--annotate', help='folder for copies of the photos with markers, reprojection and axes drawn')
    a = ap.parse_args(argv)

    rig = load_rig(a.rig)
    detector = make_detector(rig.dictionary)
    print(f'rig: {rig.name} - {len(rig.tags)} markers on {", ".join(sorted({t["plane"] for t in rig.tags}))}'
          + (f' (ids {rig.repeated} repeat)' if rig.repeated else ''))
    files = expand(a.images)
    if a.webcam is not None:
        files += webcam(a.webcam, tuple(int(v) for v in a.size.lower().split('x')) if a.size else None,
                        'calibrate_frames', detector)
    if not files:
        ap.error('no photos (give image files/folders, or --webcam N)')

    photos, sizes = [], {}
    for f in files:
        img = cv2.imread(f)
        if img is None:
            print(f'  skip {f}: not an image')
            continue
        size = (img.shape[1], img.shape[0])
        dets = detect(detector, cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
        photos.append((f, img, size, dets))
        sizes[size] = sizes.get(size, 0) + 1
    size = max(sizes, key=sizes.get)
    for f, _, s, _ in photos:
        if s != size:
            print(f'  skip {f}: {s[0]}x{s[1]}, the others are {size[0]}x{size[1]}')
    photos = [p for p in photos if p[2] == size]

    if a.intrinsics:
        with open(a.intrinsics) as fh:
            known = json.load(fh)
        known = known.get('intrinsics', known)
        K, dist = np.array(known['K'], float), np.array(known['dist'], float)
        if list(known.get('image_size', size)) != list(size):
            sys.exit(f"{a.intrinsics} is for {known['image_size']}, the photos are {list(size)}")
        cal = {'K': K, 'dist': dist, 'rms_px': known.get('rms_px'), 'method': 'given (' + a.intrinsics + ')',
               'n_views': known.get('n_views'), 'n_points': known.get('n_points'), 'notes': [], 'per_view': []}
    else:
        K0 = guess_K(size[0], size[1], a.hfov)
        views = []
        for f, _, _, dets in photos:
            m = match(dets, rig, K0, np.zeros(5)) if dets else None
            print(f'  {os.path.basename(f)}: {len(dets)} markers, {m["n"] if m else 0} matched')
            if m:
                views.append((os.path.basename(f), dets, m['assign']))
        cal = calibrate(views, rig, size, K0, a.method)
        K, dist = cal['K'], cal['dist']

    results = []
    for f, img, _, dets in photos:
        m = match(dets, rig, K, dist) if dets else None
        r = {'file': f, 'markers': len(dets), 'matched': m['n'] if m else 0}
        if m:
            R = cv2.Rodrigues(m['rvec'])[0]
            T_rig_cam = np.eye(4)
            T_rig_cam[:3, :3], T_rig_cam[:3, 3] = R.T, -R.T @ m['tvec']
            r.update({'faces': sorted({rig.tags[ti]['plane'] for ti in m['assign'].values()}),
                      'rms_px': round(m['rms'], 3), 'ambiguous': m['ambiguous'],
                      'camera_in_rig_mm': [round(v * 1000, 2) for v in T_rig_cam[:3, 3]],
                      'camera_rpy_deg': [round(v, 3) for v in rpy_deg(T_rig_cam[:3, :3])],
                      'T_rig_cam': T_rig_cam.round(7).tolist()})
        results.append(r)
        if a.annotate:
            os.makedirs(a.annotate, exist_ok=True)
            draw(img, dets, m, rig, K, dist, os.path.join(a.annotate, os.path.basename(f)))

    out = {'format': 'meshcalibrate-calibration/1', 'rig': rig.name, 'image_size': list(size),
           'K': np.asarray(K).round(6).tolist(), 'dist': [round(float(v), 7) for v in dist],
           'rms_px': None if cal['rms_px'] is None else round(float(cal['rms_px']), 4),
           'fov_deg': fov_deg(np.asarray(K), size), 'method': cal['method'], 'n_views': cal['n_views'],
           'n_points': cal['n_points'], 'notes': cal['notes'], 'per_view': cal['per_view'], 'photos': results,
           'conventions': {'K': 'pixels, [[fx,0,cx],[0,fy,cy],[0,0,1]]', 'dist': 'OpenCV k1 k2 p1 p2 k3',
                           'T_rig_cam': 'camera pose in the rig frame, p_rig = T p_cam, metres',
                           'camera': 'OpenCV: +x right, +y down, +z forward'}}
    with open(a.out, 'w') as fh:
        json.dump(out, fh, indent=1)
    if a.yaml:
        fs = cv2.FileStorage(a.yaml, cv2.FILE_STORAGE_WRITE)
        fs.write('image_width', size[0])
        fs.write('image_height', size[1])
        fs.write('camera_matrix', np.asarray(K, float))
        fs.write('distortion_coefficients', np.asarray(dist, float).reshape(1, -1))
        if cal['rms_px'] is not None:
            fs.write('rms_px', float(cal['rms_px']))
        fs.release()

    Kp = np.asarray(K)
    print(f'\ncamera: {size[0]}x{size[1]}, method {cal["method"]}'
          + (f', rms {cal["rms_px"]:.3f} px over {cal["n_views"]} views / {cal["n_points"]} corners' if cal['rms_px'] is not None else ''))
    print(f'  fx {Kp[0, 0]:.2f}  fy {Kp[1, 1]:.2f}  cx {Kp[0, 2]:.2f}  cy {Kp[1, 2]:.2f}   FOV {out["fov_deg"]}')
    print('  dist k1 k2 p1 p2 k3: ' + ' '.join(f'{v:.5f}' for v in dist))
    for n in cal['notes']:
        print('  note: ' + n)
    for r in results:
        if r['matched']:
            print(f"  {os.path.basename(r['file'])}: camera at {r['camera_in_rig_mm']} mm from the rig origin, "
                  f"rms {r['rms_px']} px, faces {r['faces']}" + ('  (repeated ids: ambiguous)' if r['ambiguous'] else ''))
        else:
            print(f"  {os.path.basename(r['file'])}: rig not found")
    print(f'wrote {a.out}' + (f' and {a.yaml}' if a.yaml else ''))


if __name__ == '__main__':
    main()
