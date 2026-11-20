"""End-to-end check of the downloadable stereo_calibrate.py, for the 3D rig and the one-plane plate.

    node tests/rig.test.mjs OUT
    node tests/make_calibrate_script.mjs OUT OUT/plane
    python tests/check_stereo_script.py OUT OUT/plane

A simulated stereo head - two DIFFERENT cameras (focal length, principal point, distortion), camera 2
120 mm to the right of camera 1 and toed in 4 deg - is moved around the printed geometry (the two
STLs) and photo pairs are rendered. The generated stereo_calibrate.py runs on them from an empty
folder; the baseline, rotation, epipolar error and rectification must match the truth. It is run
twice: calibrating both cameras itself, and with the true intrinsics given (--intrinsics1/2).
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from check_rig_opencv import load_stl, rasterize  # noqa: E402
from check_calibrate_script import look_from, viewpoints  # noqa: E402

W, H = 1280, 960
K1 = np.array([[1100.0, 0, 645.0], [0, 1100.0, 478.0], [0, 0, 1]])
D1 = np.array([-0.08, 0.02, 0.0, 0.0, 0.0])
K2 = np.array([[1000.0, 0, 630.0], [0, 1000.0, 490.0], [0, 0, 1]])
D2 = np.array([-0.05, 0.01, 0.0, 0.0, 0.0])
TOE = np.radians(-4.0)
R21 = np.array([[np.cos(TOE), 0, np.sin(TOE)], [0, 1, 0], [-np.sin(TOE), 0, np.cos(TOE)]])   # cam1 -> cam2
C2 = np.array([120.0, 0, 0])                         # camera 2 centre in camera-1 coordinates, mm
T21 = -R21 @ C2                                      # x2 = R21 x1 + T21 (mm)


def render(white, black, R, t, K, D):
    tris = np.concatenate([white, black])
    cols = np.array([235] * len(white) + [15] * len(black))
    cam = tris @ R.T + t
    nrm = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    eye = -R.T @ t
    keep = np.einsum('ij,ij->i', nrm, eye - tris[:, 0]) > 0
    cam, cols = cam[keep], cols[keep]
    uv = cam[..., :2] / cam[..., 2:3] * [K[0, 0], K[1, 1]] + [K[0, 2], K[1, 2]]
    img = rasterize(uv, 1.0 / cam[..., 2], cols, H, W, bg=128)
    xs, ys = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    und = cv2.undistortPoints(np.stack([xs.ravel(), ys.ravel()], 1).reshape(-1, 1, 2), K, D, P=K).reshape(H, W, 2)
    return cv2.remap(img, und[..., 0], und[..., 1], cv2.INTER_LINEAR, borderValue=128)


def main(d):
    d = Path(d).resolve()
    rig = json.loads((d / 'rig.json').read_text())
    print(f"--- {d.name}: {rig['name']} ({rig['print'].get('mode')}) - stereo")
    white, black = load_stl(d / 'rig_white.stl'), load_stl(d / 'rig_black.stl')
    L, R_ = d / 'stereo_left', d / 'stereo_right'
    L.mkdir(exist_ok=True)
    R_.mkdir(exist_ok=True)
    aims, eyes = viewpoints(rig)
    for i, (eye, aim) in enumerate(zip(eyes, aims)):
        Rc1, tc1 = look_from(eye, aim)
        cv2.imwrite(str(L / f'pair_{i}.png'), render(white, black, Rc1, tc1, K1, D1))
        cv2.imwrite(str(R_ / f'pair_{i}.png'), render(white, black, R21 @ Rc1, R21 @ tc1 + T21, K2, D2))
    failures = 0
    true_angle = np.degrees(abs(TOE))
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / 'stereo_calibrate.py'
        script.write_text((d / 'stereo_calibrate.py').read_text())
        (Path(tmp) / 'k1.json').write_text(json.dumps({'K': K1.tolist(), 'dist': D1.tolist(), 'image_size': [W, H]}))
        (Path(tmp) / 'k2.json').write_text(json.dumps({'K': K2.tolist(), 'dist': D2.tolist(), 'image_size': [W, H]}))
        for label, extra, lim_mm, lim_deg in (('self-calibrated', [], 3.0, 0.6),
                                              ('true intrinsics', ['--intrinsics1', 'k1.json', '--intrinsics2', 'k2.json'], 0.5, 0.05)):
            run = subprocess.run([sys.executable, str(script), '--left', str(L), '--right', str(R_), '--out', 'stereo.json',
                                  '--yaml', 'stereo.yaml', '--annotate', str(d / 'stereo_annotated')] + extra,
                                 cwd=tmp, capture_output=True, text=True)
            if run.returncode:
                print(run.stdout[-2000:], run.stderr[-2000:])
                failures += 1
                continue
            s = json.loads((Path(tmp) / 'stereo.json').read_text())
            T = np.array(s['T_m']) * 1000
            Rm = np.array(s['R'])
            t_err = float(np.linalg.norm(T - T21))
            r_err = float(np.degrees(np.arccos(np.clip((np.trace(Rm.T @ R21) - 1) / 2, -1, 1))))
            samp = s['epipolar_sampson_px']['mean']
            row = (s['rectification'] or {}).get('row_error_px', {}).get('mean', 99)
            yaml_ok = 'stereo' in str((Path(tmp) / 'stereo.yaml').read_text()[:0]) or 'Q' in (Path(tmp) / 'stereo.yaml').read_text()
            ok = t_err < lim_mm and r_err < lim_deg and samp < 0.3 and row < 0.5 and yaml_ok
            failures += not ok
            print(f"{'ok  ' if ok else 'FAIL'} {label}: baseline {s['baseline_mm']} mm (true 120), T error {t_err:.3f} mm, "
                  f"rotation {s['rotation_deg']} deg (true {true_angle:.1f}), error {r_err:.4f} deg; Sampson mean "
                  f"{samp} px over {s['epipolar_sampson_px']['points']} corners; rectified row error {row} px; "
                  f"pairs agree to {s['pair_spread']['mm_max']} mm")
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(max(main(d) for d in sys.argv[1:]))
