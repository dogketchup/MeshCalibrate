"""End-to-end check of the downloadable calibrate.py, for the 3D rig and the one-plane plate.

    node tests/rig.test.mjs OUT                      # rig.json + STLs in OUT and OUT/plane
    node tests/make_calibrate_script.mjs OUT OUT/plane   # calibrate.py with the rig embedded
    python tests/check_calibrate_script.py OUT OUT/plane

For each directory: photos of the printed GEOMETRY (the two STLs) are rendered through a known
camera with lens distortion, from several viewpoints; the generated calibrate.py is run on them
from an empty folder (so only its embedded rig is available); the K, distortion and every photo's
camera position it reports must match the truth. Then it is run again with --intrinsics (pose only).
Needs numpy and opencv.
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

W, H = 1280, 960
K_TRUE = np.array([[1100.0, 0, 645.0], [0, 1100.0, 478.0], [0, 0, 1]])
D_TRUE = np.array([-0.08, 0.02, 0.0, 0.0, 0.0])


def look_from(eye, target):
    f = np.asarray(target, float) - eye
    f /= np.linalg.norm(f)
    up = np.array([0, 0, 1.0]) if abs(f[2]) < 0.99 else np.array([0, 1.0, 0])
    r = np.cross(f, up)
    r /= np.linalg.norm(r)
    d = np.cross(f, r)
    R = np.stack([r, d, f])          # rig -> camera rows (mm)
    return R, -R @ eye


def render(white, black, R, t):
    tris = np.concatenate([white, black])
    cols = np.array([235] * len(white) + [15] * len(black))
    cam = tris @ R.T + t
    nrm = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    eye = -R.T @ t
    keep = np.einsum('ij,ij->i', nrm, eye - tris[:, 0]) > 0
    cam, cols = cam[keep], cols[keep]
    uv = cam[..., :2] / cam[..., 2:3] * [K_TRUE[0, 0], K_TRUE[1, 1]] + [K_TRUE[0, 2], K_TRUE[1, 2]]
    img = rasterize(uv, 1.0 / cam[..., 2], cols, H, W, bg=128)
    # add lens distortion: each output (distorted) pixel samples the pinhole image where its ray lands
    xs, ys = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    pts = np.stack([xs.ravel(), ys.ravel()], 1).reshape(-1, 1, 2)
    und = cv2.undistortPoints(pts, K_TRUE, D_TRUE, P=K_TRUE).reshape(H, W, 2)
    return cv2.remap(img, und[..., 0], und[..., 1], cv2.INTER_LINEAR, borderValue=128)


def viewpoints(rig):
    centre = np.mean([t['center'] for t in rig['tags']], axis=0)
    rng = np.random.default_rng(5)
    eyes = []
    plane = rig['print'].get('mode') == 'plane'
    for k in range(10 if plane else 7):   # a flat plate needs more photos (README says 10)
        if rig['print'].get('mode') == 'plane':      # all around, tilted 35-70 deg
            az, el = rng.uniform(0, 2 * np.pi), np.radians(rng.uniform(35, 70))
        else:                                        # from the open side of the corner
            az, el = np.radians(rng.uniform(20, 70)), np.radians(rng.uniform(25, 55))
        r = rng.uniform(330, 470)
        eyes.append(centre + r * np.array([np.cos(az) * np.cos(el), np.sin(az) * np.cos(el), np.sin(el)]))
    # aim past the rig in most photos so it lands towards the image edges, as it should in a real
    # session (distortion is only measurable there)
    aims = [centre + (rng.uniform(-110, 110, 3) * [1, 1, 0.6] if k % 4 else 0) for k in range(len(eyes))]
    return aims, eyes


def main(d):
    d = Path(d).resolve()
    rig = json.loads((d / 'rig.json').read_text())
    print(f"--- {d.name}: {rig['name']} ({rig['print'].get('mode')})")
    white, black = load_stl(d / 'rig_white.stl'), load_stl(d / 'rig_black.stl')
    photos = d / 'calib_photos'
    photos.mkdir(exist_ok=True)
    aims, eyes = viewpoints(rig)
    truth = {}
    for i, (eye, aim) in enumerate(zip(eyes, aims)):
        R, t = look_from(eye, aim)
        name = f'photo_{i}.png'
        cv2.imwrite(str(photos / name), render(white, black, R, t))
        truth[name] = eye
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:          # no rig.json anywhere near the script
        script = Path(tmp) / 'calibrate.py'
        script.write_text((d / 'calibrate.py').read_text())
        run = subprocess.run([sys.executable, str(script), str(photos), '--out', 'calibration.json',
                              '--yaml', 'calibration.yaml', '--annotate', str(d / 'calib_annotated')],
                             cwd=tmp, capture_output=True, text=True)
        if run.returncode:
            print(run.stdout, run.stderr)
            return 1
        cal = json.loads((Path(tmp) / 'calibration.json').read_text())
        yaml_text = (Path(tmp) / 'calibration.yaml').read_text()
        yaml_ok = 'camera_matrix' in yaml_text and 'distortion_coefficients' in yaml_text
        K, dist = np.array(cal['K']), np.array(cal['dist'])
        f_err = abs(K[0, 0] - K_TRUE[0, 0]) / K_TRUE[0, 0] * 100
        pp_err = float(np.hypot(K[0, 2] - K_TRUE[0, 2], K[1, 2] - K_TRUE[1, 2]))
        pos = [np.linalg.norm(np.array(p['camera_in_rig_mm']) - truth[Path(p['file']).name])
               for p in cal['photos'] if p['matched']]
        # A 100 mm target at 33-47 cm: focal length comes out to ~0.5 %, the principal point - always
        # the least determined parameter with a small target - to ~1 % of the width, camera
        # positions to a few mm. The flat plate is the weaker target, hence its looser position limit.
        pos_lim = 5.0 if rig['print'].get('mode') == 'plane' else 3.0
        ok = f_err < 1.0 and pp_err < 15 and cal['rms_px'] < 0.5 and len(pos) == len(eyes) and max(pos) < pos_lim and yaml_ok
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} calibrate: fx {K[0, 0]:.2f} fy {K[1, 1]:.2f} (true 1100, {f_err:.3f} %), "
              f"principal point off by {pp_err:.2f} px, k1 {dist[0]:.4f} k2 {dist[1]:.4f} (true -0.08 0.02), "
              f"rms {cal['rms_px']} px over {cal['n_views']} views; camera positions within {max(pos):.2f} mm "
              f"in {len(pos)}/{len(eyes)} photos; yaml {'ok' if yaml_ok else 'MISSING'}")
        # pose only, with the camera now known
        (Path(tmp) / 'known.json').write_text(json.dumps({'K': K_TRUE.tolist(), 'dist': D_TRUE.tolist(), 'image_size': [W, H]}))
        run = subprocess.run([sys.executable, str(script), str(photos / 'photo_0.png'), '--intrinsics', 'known.json',
                              '--out', 'pose.json'], cwd=tmp, capture_output=True, text=True)
        p = json.loads((Path(tmp) / 'pose.json').read_text())['photos'][0] if not run.returncode else None
        e = np.linalg.norm(np.array(p['camera_in_rig_mm']) - truth['photo_0.png']) if p and p['matched'] else 1e9
        ok = e < 1.5
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} pose only (--intrinsics): camera position error {e:.3f} mm, rms {p and p.get('rms_px')} px")
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(max(main(d) for d in sys.argv[1:]))
