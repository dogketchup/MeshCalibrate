#!/usr/bin/env python3
"""stereo_calibrate.py - calibrate a STEREO PAIR of cameras with a MeshCalibrate ArUco rig (3D corner
rig or one plane) and check it with epipolar geometry.

Downloaded from MeshCalibrate, this file carries the rig (and calibrate.py's detection, matching
and single-camera calibration), so nothing else is needed:

    python stereo_calibrate.py --left 'left/*.png' --right 'right/*.png'
                                    photo pairs, both cameras at the same moment; paired in sorted order
    python stereo_calibrate.py --webcam 0 1
                                    take the pairs live: SPACE keeps a pair, Q ends
    python stereo_calibrate.py --left L --right R --intrinsics1 cam1.json --intrinsics2 cam2.json
                                    keep each camera's own calibration (calibrate.py output), solve the pair only

Options: --rig rig.json  --method planes|rig3d  --hfov DEG  --alpha A (rectification crop, 0..1)
         --out stereo.json  --yaml stereo.yaml  --annotate DIR (epipolar lines + rectified pairs)
Needs:   python3, numpy, opencv-python >= 4.7

How it works
  1. Each photo is detected and matched to the rig exactly as calibrate.py does (marker id + 4
     corners -> 4 known 3D rig points).
  2. Each camera is calibrated on its own photos (K, distortion), unless --intrinsics1/2 are given.
  3. In every pair, the markers seen by BOTH cameras give the same 3D points in two images.
     cv2.stereoCalibrate (intrinsics held fixed) finds the pose of camera 2 relative to camera 1:
         x2 = R x1 + T        (a point in camera-1 coordinates, in camera-2 coordinates; metres)
  4. Epipolar geometry. E = [T]x R relates the two cameras' viewing rays, F = K2^-T E K1^-1 their
     pixels: a corner seen at p1 in camera 1 must lie on the line l2 = F p1 in camera 2
     (p2^T F p1 = 0). The Sampson distance of every shared corner from its epipolar line is the
     check: about 0.3 px or less is a good calibration. The pair-to-pair spread of the relative pose
     is a second check that needs no model at all.
  5. Rectification (both cameras at the same resolution): cv2.stereoRectify gives R1, R2, P1, P2
     and Q so that a point lands on the SAME ROW in both rectified images - what a stereo matcher
     such as cv2.StereoSGBM needs - and Q turns its disparity into depth. The leftover row
     difference of the shared corners is reported.
Output: stereo.json (cameras, R, T, E, F, baseline, errors, rectification), optional OpenCV YAML.
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
    sys.exit('stereo_calibrate.py needs OpenCV with ArUco: pip install opencv-python numpy')

# @@CALIBRATE_LIB@@
if 'Rig' not in globals():      # running from the MeshCalibrate repository: use calibrate.py beside this file
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from calibrate import (Rig, load_rig, make_detector, detect, match, guess_K, fov_deg,  # noqa: F401
                           calibrate, rot_angle_deg, expand)


def skew(t):
    return np.array([[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]], float)


def sampson(F, p1, p2):
    x1 = np.hstack([p1, np.ones((len(p1), 1))])
    x2 = np.hstack([p2, np.ones((len(p2), 1))])
    Fx1, Ftx2 = x1 @ F.T, x2 @ F
    num = np.sum(x2 * Fx1, axis=1) ** 2
    den = Fx1[:, 0] ** 2 + Fx1[:, 1] ** 2 + Ftx2[:, 0] ** 2 + Ftx2[:, 1] ** 2
    return np.sqrt(num / np.maximum(den, 1e-18))


def load_photos(files, detector):
    out, sizes = [], {}
    for f in files:
        img = cv2.imread(f)
        if img is None:
            sys.exit(f'{f}: not an image')
        out.append({'file': f, 'img': img, 'size': (img.shape[1], img.shape[0]),
                    'dets': detect(detector, cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))})
        sizes[out[-1]['size']] = 1
    if len(sizes) > 1:
        sys.exit(f'photos of one camera must all be the same size, got {sorted(sizes)}')
    return out


def intrinsics_for(name, photos, rig, method, hfov, given):
    size = photos[0]['size']
    if given:
        with open(given) as fh:
            k = json.load(fh)
        k = k.get('intrinsics', k)
        if list(k.get('image_size', size)) != list(size):
            sys.exit(f"{given} is for {k['image_size']}, the {name} photos are {list(size)}")
        return {'K': np.array(k['K'], float), 'dist': np.array(k['dist'], float), 'size': size,
                'rms_px': k.get('rms_px'), 'source': given, 'notes': []}
    K0 = guess_K(size[0], size[1], hfov)
    views = []
    for p in photos:
        m = match(p['dets'], rig, K0, np.zeros(5)) if p['dets'] else None
        if m:
            views.append((os.path.basename(p['file']), p['dets'], m['assign']))
    c = calibrate(views, rig, size, K0, method)
    return {'K': c['K'], 'dist': c['dist'], 'size': size, 'rms_px': c['rms_px'], 'source': f'calibrated here ({method})',
            'n_views': c['n_views'], 'notes': c['notes']}


def webcam_pairs(i1, i2, size, outdir, detector):
    os.makedirs(outdir, exist_ok=True)
    caps = [cv2.VideoCapture(i) for i in (i1, i2)]
    for c in caps:
        if size:
            c.set(cv2.CAP_PROP_FRAME_WIDTH, size[0])
            c.set(cv2.CAP_PROP_FRAME_HEIGHT, size[1])
        if not c.isOpened():
            sys.exit('cannot open both cameras')
    left, right = [], []
    while True:
        frames = [c.read() for c in caps]
        if not all(ok for ok, _ in frames):
            break
        f1, f2 = frames[0][1], frames[1][1]
        vis = []
        for f in (f1, f2):
            v = f.copy()
            d = detect(detector, cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
            if d:
                cv2.aruco.drawDetectedMarkers(v, [x['corners'].reshape(1, 4, 2).astype(np.float32) for x in d],
                                              np.array([[x['id']] for x in d]))
            vis.append(cv2.resize(v, (640, int(640 * v.shape[0] / v.shape[1]))))
        h = min(v.shape[0] for v in vis)
        both = np.hstack([v[:h] for v in vis])
        cv2.putText(both, f'SPACE keep pair ({len(left)} kept)  Q done', (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
        cv2.imshow('stereo_calibrate.py', both)
        k = cv2.waitKey(1) & 0xFF
        if k == 32:
            n = len(left)
            for f, lst, side in ((f1, left, 'left'), (f2, right, 'right')):
                p = os.path.join(outdir, f'{side}_{n:03d}.png')
                cv2.imwrite(p, f)
                lst.append(p)
        elif k in (ord('q'), 27):
            break
    for c in caps:
        c.release()
    cv2.destroyAllWindows()
    return left, right


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__[__doc__.index('Options:'):])
    ap.add_argument('--left', nargs='+', default=[], help='camera 1 photos (files, folders, globs)')
    ap.add_argument('--right', nargs='+', default=[], help='camera 2 photos, same count and order')
    ap.add_argument('--webcam', nargs=2, type=int, metavar=('CAM1', 'CAM2'), help='take the pairs live first')
    ap.add_argument('--size', help='webcam frame size, e.g. 1280x720')
    ap.add_argument('--rig', help='rig.json to use instead of the one built into this file')
    ap.add_argument('--method', choices=['planes', 'rig3d'], default='planes')
    ap.add_argument('--hfov', type=float, default=60.0, help='starting guess for the horizontal FOV, degrees')
    ap.add_argument('--intrinsics1', help='calibration.json of camera 1 (skip calibrating it)')
    ap.add_argument('--intrinsics2', help='calibration.json of camera 2 (skip calibrating it)')
    ap.add_argument('--alpha', type=float, default=0.0, help='rectification: 0 = crop to valid pixels, 1 = keep all')
    ap.add_argument('--fix-intrinsics', action='store_true', help='solve only R, T even when the cameras were calibrated here')
    ap.add_argument('--out', default='stereo.json')
    ap.add_argument('--yaml', help='also write OpenCV FileStorage YAML here')
    ap.add_argument('--annotate', help='folder for epipolar-line and rectified images')
    a = ap.parse_args(argv)

    rig = load_rig(a.rig)
    detector = make_detector(rig.dictionary)
    print(f'rig: {rig.name} - {len(rig.tags)} markers on {", ".join(sorted({t["plane"] for t in rig.tags}))}')
    left, right = expand(a.left), expand(a.right)
    if a.webcam:
        l2, r2 = webcam_pairs(a.webcam[0], a.webcam[1], tuple(int(v) for v in a.size.lower().split('x')) if a.size else None,
                              'stereo_frames', detector)
        left, right = left + l2, right + r2
    if not left or len(left) != len(right):
        ap.error(f'need the same number of camera-1 and camera-2 photos (got {len(left)} and {len(right)})')
    P1, P2 = load_photos(left, detector), load_photos(right, detector)

    cam1 = intrinsics_for('camera 1', P1, rig, a.method, a.hfov, a.intrinsics1)
    cam2 = intrinsics_for('camera 2', P2, rig, a.method, a.hfov, a.intrinsics2)
    K1, D1, K2, D2 = cam1['K'], cam1['dist'], cam2['K'], cam2['dist']

    # markers both cameras saw, pair by pair
    obj_l, img1_l, img2_l, pairs = [], [], [], []
    for p1, p2 in zip(P1, P2):
        m1 = match(p1['dets'], rig, K1, D1) if p1['dets'] else None
        m2 = match(p2['dets'], rig, K2, D2) if p2['dets'] else None
        entry = {'left': p1['file'], 'right': p2['file'], 'shared_markers': 0}
        if m1 and m2:
            inv2 = {ti: j for j, ti in m2['assign'].items()}
            common = [(j1, ti, inv2[ti]) for j1, ti in m1['assign'].items() if ti in inv2]
            entry['shared_markers'] = len(common)
            if len(common) >= 2:
                obj_l.append(np.concatenate([rig.tags[ti]['corners'] for _, ti, _ in common]).astype(np.float32))
                img1_l.append(np.concatenate([p1['dets'][j]['corners'] for j, _, _ in common]).astype(np.float32))
                img2_l.append(np.concatenate([p2['dets'][j]['corners'] for _, _, j in common]).astype(np.float32))
                T1, T2 = np.eye(4), np.eye(4)
                T1[:3, :3], T1[:3, 3] = cv2.Rodrigues(m1['rvec'])[0], m1['tvec']
                T2[:3, :3], T2[:3, 3] = cv2.Rodrigues(m2['rvec'])[0], m2['tvec']
                entry['_T21'] = T2 @ np.linalg.inv(T1)
                entry['_idx'] = len(obj_l) - 1
        pairs.append(entry)
        print(f"  {os.path.basename(p1['file'])} + {os.path.basename(p2['file'])}: "
              f"{len(p1['dets'])} / {len(p2['dets'])} markers, {entry['shared_markers']} seen by both")
    if not obj_l:
        sys.exit('no pair has 2+ markers seen by both cameras - point both at the rig at the same time')

    # Intrinsics you GIVE are held fixed. Intrinsics calibrated here are refined together with R, T:
    # a small rig leaves each camera's principal point ~10 px uncertain, which the rotation would
    # otherwise absorb (measured on synthetic pairs: 0.9 deg -> 0.3 deg rotation error).
    refine = not (a.intrinsics1 and a.intrinsics2) and not a.fix_intrinsics
    flags = (cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_K3 | cv2.CALIB_ZERO_TANGENT_DIST) if refine else cv2.CALIB_FIX_INTRINSIC
    rms, K1, D1, K2, D2, R, T, E, F = cv2.stereoCalibrate(obj_l, img1_l, img2_l, K1, D1, K2, D2, cam1['size'],
                                                          flags=flags)
    T = T.reshape(3)
    E = skew(T) @ R                                   # same as OpenCV's, normalised the textbook way
    F = np.linalg.inv(K2).T @ E @ np.linalg.inv(K1)
    F = F / F[2, 2] if abs(F[2, 2]) > 1e-12 else F

    # epipolar check on undistorted pixels, per pair; consistency of the per-pair relative poses
    errs = []
    for e in pairs:
        if '_idx' not in e:
            continue
        i = e['_idx']
        u1 = cv2.undistortPoints(img1_l[i].reshape(-1, 1, 2).astype(np.float64), K1, D1, P=K1).reshape(-1, 2)
        u2 = cv2.undistortPoints(img2_l[i].reshape(-1, 1, 2).astype(np.float64), K2, D2, P=K2).reshape(-1, 2)
        s = sampson(F, u1, u2)
        errs.append(s)
        e['sampson_px'] = round(float(np.mean(s)), 4)
        e['pair_pose_vs_solution'] = {'mm': round(float(np.linalg.norm(e['_T21'][:3, 3] - T)) * 1000, 2),
                                      'deg': round(rot_angle_deg(e['_T21'][:3, :3].T @ R), 3)}
    allerr = np.concatenate(errs)

    rect = None
    if tuple(cam1['size']) == tuple(cam2['size']):
        size = tuple(cam1['size'])
        R1, R2, Pr1, Pr2, Q, roi1, roi2 = cv2.stereoRectify(K1, D1, K2, D2, size, R, T.reshape(3, 1), alpha=a.alpha)
        rows = []
        for i in range(len(obj_l)):
            r1 = cv2.undistortPoints(img1_l[i].reshape(-1, 1, 2).astype(np.float64), K1, D1, R=R1, P=Pr1).reshape(-1, 2)
            r2 = cv2.undistortPoints(img2_l[i].reshape(-1, 1, 2).astype(np.float64), K2, D2, R=R2, P=Pr2).reshape(-1, 2)
            rows.append(np.abs(r1[:, 1] - r2[:, 1]))
        rows = np.concatenate(rows)
        rect = {'R1': R1, 'R2': R2, 'P1': Pr1, 'P2': Pr2, 'Q': Q, 'roi1': list(roi1), 'roi2': list(roi2),
                'row_error_px': {'mean': round(float(rows.mean()), 4), 'max': round(float(rows.max()), 4)},
                'vertical' if abs(Pr2[1, 3]) > abs(Pr2[0, 3]) else 'horizontal': True}

    if a.annotate:
        os.makedirs(a.annotate, exist_ok=True)
        for e in pairs:
            if '_idx' not in e:
                continue
            i = e['_idx']
            p1 = next(p for p in P1 if p['file'] == e['left'])
            p2 = next(p for p in P2 if p['file'] == e['right'])
            und2 = cv2.undistort(p2['img'], K2, D2)
            u1 = cv2.undistortPoints(img1_l[i].reshape(-1, 1, 2).astype(np.float64), K1, D1, P=K1)
            u2 = cv2.undistortPoints(img2_l[i].reshape(-1, 1, 2).astype(np.float64), K2, D2, P=K2).reshape(-1, 2)
            lines = cv2.computeCorrespondEpilines(u1, 1, F).reshape(-1, 3)
            w = und2.shape[1]
            for (la, lb, lc), q in zip(lines[::4], u2[::4]):       # one line per marker (its corner 0)
                if abs(lb) > 1e-9:
                    cv2.line(und2, (0, int(round(-lc / lb))), (w, int(round(-(lc + la * w) / lb))), (0, 200, 255), 1)
                cv2.circle(und2, (int(round(q[0])), int(round(q[1]))), 4, (255, 0, 255), -1)
            name = os.path.splitext(os.path.basename(e['right']))[0]
            cv2.imwrite(os.path.join(a.annotate, f'epilines_{name}.png'), und2)
            if rect:
                m1x, m1y = cv2.initUndistortRectifyMap(K1, D1, rect['R1'], rect['P1'], tuple(cam1['size']), cv2.CV_32FC1)
                m2x, m2y = cv2.initUndistortRectifyMap(K2, D2, rect['R2'], rect['P2'], tuple(cam2['size']), cv2.CV_32FC1)
                both = np.hstack([cv2.remap(p1['img'], m1x, m1y, cv2.INTER_LINEAR),
                                  cv2.remap(p2['img'], m2x, m2y, cv2.INTER_LINEAR)])
                for y in range(0, both.shape[0], 40):
                    cv2.line(both, (0, y), (both.shape[1], y), (0, 255, 0), 1)
                cv2.imwrite(os.path.join(a.annotate, f'rectified_{name}.png'), both)

    spread = [(e['pair_pose_vs_solution']['mm'], e['pair_pose_vs_solution']['deg']) for e in pairs if 'pair_pose_vs_solution' in e]
    out = {'format': 'meshcalibrate-stereo/1', 'rig': rig.name,
           'camera1': {'image_size': list(cam1['size']), 'K': K1.round(6).tolist(), 'dist': [round(float(v), 7) for v in D1],
                       'rms_px': cam1['rms_px'], 'source': cam1['source'], 'fov_deg': fov_deg(K1, cam1['size']),
                       'notes': cam1['notes']},
           'camera2': {'image_size': list(cam2['size']), 'K': K2.round(6).tolist(), 'dist': [round(float(v), 7) for v in D2],
                       'rms_px': cam2['rms_px'], 'source': cam2['source'], 'fov_deg': fov_deg(K2, cam2['size']),
                       'notes': cam2['notes']},
           'intrinsics': 'refined jointly with the pair' if refine else 'held fixed',
           'R': R.round(8).tolist(), 'T_m': [round(float(v), 7) for v in T],
           'baseline_mm': round(float(np.linalg.norm(T)) * 1000, 3), 'rotation_deg': round(rot_angle_deg(R), 4),
           'E': E.tolist(), 'F': F.tolist(), 'stereo_rms_px': round(float(rms), 4),
           'epipolar_sampson_px': {'mean': round(float(allerr.mean()), 4), 'max': round(float(allerr.max()), 4),
                                   'points': int(len(allerr))},
           'pair_spread': {'mm_max': max(s[0] for s in spread), 'deg_max': max(s[1] for s in spread)},
           'pairs': [{k: v for k, v in e.items() if not k.startswith('_')} for e in pairs],
           'rectification': None if rect is None else {k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in rect.items()},
           'conventions': {'R_T': 'x2 = R x1 + T: camera-1 coordinates to camera-2 coordinates, metres',
                           'E_F': 'E = [T]x R; F = K2^-T E K1^-1; x2^T F x1 = 0 for undistorted pixels',
                           'rectification': 'cv2.stereoRectify outputs; Q maps (x, y, disparity, 1) to 3D'}}
    with open(a.out, 'w') as fh:
        json.dump(out, fh, indent=1)
    if a.yaml:
        fs = cv2.FileStorage(a.yaml, cv2.FILE_STORAGE_WRITE)
        for k, v in (('K1', K1), ('D1', D1.reshape(1, -1)), ('K2', K2), ('D2', D2.reshape(1, -1)), ('R', R),
                     ('T', T.reshape(3, 1)), ('E', E), ('F', F)):
            fs.write(k, np.asarray(v, float))
        fs.write('image_width', int(cam1['size'][0]))
        fs.write('image_height', int(cam1['size'][1]))
        if rect:
            for k in ('R1', 'R2', 'P1', 'P2', 'Q'):
                fs.write(k, rect[k])
        fs.release()

    print(f"\ncamera 1: fx {K1[0, 0]:.2f} fy {K1[1, 1]:.2f} cx {K1[0, 2]:.2f} cy {K1[1, 2]:.2f}  ({cam1['source']})")
    print(f"camera 2: fx {K2[0, 0]:.2f} fy {K2[1, 1]:.2f} cx {K2[0, 2]:.2f} cy {K2[1, 2]:.2f}  ({cam2['source']})")
    print('intrinsics ' + ('refined jointly with the pair' if refine else 'held fixed'))
    print(f"camera 2 relative to camera 1: baseline {out['baseline_mm']} mm, rotation {out['rotation_deg']} deg, "
          f"T {' '.join(f'{v * 1000:.2f}' for v in T)} mm")
    print(f"stereo reprojection rms {out['stereo_rms_px']} px; epipolar (Sampson) mean {out['epipolar_sampson_px']['mean']} px, "
          f"max {out['epipolar_sampson_px']['max']} px over {out['epipolar_sampson_px']['points']} corners; "
          f"pairs agree to {out['pair_spread']['mm_max']} mm / {out['pair_spread']['deg_max']} deg")
    if rect:
        print(f"rectified: rows differ by {rect['row_error_px']['mean']} px on average (max {rect['row_error_px']['max']})")
    print(f'wrote {a.out}' + (f' and {a.yaml}' if a.yaml else ''))


if __name__ == '__main__':
    main()
