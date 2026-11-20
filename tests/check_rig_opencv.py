"""Cross-check the printable rig against OpenCV, from the GEOMETRY.

    node tests/rig.test.mjs OUT        # 3D rig in OUT, one-plane plate in OUT/plane
    python tests/check_rig_opencv.py OUT OUT/plane

1. Each face is rendered straight on from the two STLs (not from rig.json's
   bits), the markers are detected with DICT_ARUCO_ORIGINAL, and their ids and
   corners are compared with rig.json's corners projected into the same image.
2. The whole target is rendered through a pinhole camera from two viewpoints,
   detected, and solvePnP is run against rig.json's 3D corners: the pose must
   come back and reproject to ~0. For the 3D rig that only happens if all three
   faces share the one origin rig.json describes.
Needs numpy and opencv (cv2.aruco).
"""
import json
import struct
import sys
from pathlib import Path

import cv2
import numpy as np


def load_stl(path):
    data = Path(path).read_bytes()
    n = struct.unpack_from("<I", data, 80)[0]
    rec = np.frombuffer(data, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]), count=n, offset=84)
    return rec["v"].astype(np.float64)  # (n, 3, 3)


def rasterize(tris2d, inv_depth, colors, h, w, bg=128, ss=4):
    """Z-buffered fill of 2D triangles, supersampled ss x ss and box-filtered
    down so edges land at sub-pixel accuracy. Pixel centres are at integer
    coordinates (OpenCV's convention); depth is interpolated as 1/z, larger =
    closer."""
    if ss > 1:
        hi = rasterize(np.asarray(tris2d) * ss + (ss - 1) / 2, inv_depth, colors, h * ss, w * ss, bg, ss=1)
        return cv2.resize(hi, (w, h), interpolation=cv2.INTER_AREA)
    img = np.full((h, w), bg, np.uint8)
    zbuf = np.full((h, w), -np.inf)
    for t, d, col in zip(tris2d, inv_depth, colors):
        x0, y0 = np.floor(t.min(0)).astype(int)
        x1, y1 = np.ceil(t.max(0)).astype(int)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w - 1), min(y1, h - 1)
        if x0 > x1 or y0 > y1:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        (ax, ay), (bx, by), (cx, cy) = t
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9)
        z = l1 * d[0] + l2 * d[1] + l3 * d[2]
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        win = inside & (z > sub)
        sub[win] = z[win]
        img[y0:y1 + 1, x0:x1 + 1][win] = col
    return img


def detector():
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    return cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_ARUCO_ORIGINAL), params)


def main(outdir):
    out = Path(outdir)
    rig = json.loads((out / "rig.json").read_text())
    print(f"--- {out}: {rig['name']} ({len(rig['tags'])} markers on {', '.join(p['name'] for p in rig['planes'])})")
    white, black = load_stl(out / "rig_white.stl"), load_stl(out / "rig_black.stl")
    S = rig["print"]["face_mm"]
    tags = {t["id"]: t for t in rig["tags"]}
    det = detector()
    failures = 0

    # ---- 1. each face, straight on, from the geometry ---------------------------------
    PX = 8.0  # pixels per mm
    PAD = 20
    for plane in rig["planes"]:
        nrm, u, v = (np.array(plane[k], float) for k in ("normal", "u", "v"))
        # face square [0, S]^2 on the two axes the face spans
        axes = [i for i in range(3) if nrm[i] == 0]
        corners = []
        for a in (0, S):
            for b in (0, S):
                p = np.zeros(3)
                p[axes[0]], p[axes[1]] = a, b
                corners.append(p)
        umin = min(c @ u for c in corners)
        vmin = min(c @ v for c in corners)

        def to_px(p):
            return np.stack([(p @ u - umin) * PX + PAD, (p @ v - vmin) * PX + PAD], -1)

        def on_face(tris):
            n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
            n /= np.linalg.norm(n, axis=1, keepdims=True)
            keep = (n @ nrm > 0.999) & np.all(np.abs(tris @ nrm) < 1e-4, axis=1)
            return tris[keep]

        fw, fb = on_face(white), on_face(black)
        tris = np.concatenate([fw, fb])
        cols = [255] * len(fw) + [0] * len(fb)
        size = int(S * PX + 2 * PAD)
        img = rasterize(to_px(tris), np.zeros((len(tris), 3)), cols, size, size)
        cv2.imwrite(str(out / f"face_{plane['name']}.png"), img)
        cs, ids, _ = det.detectMarkers(img)
        got = sorted(int(i) for i in ids.flatten()) if ids is not None else []
        want = sorted(t["id"] for t in rig["tags"] if t["plane"] == plane["name"])
        worst = 0.0
        for c, i in zip(cs if ids is not None else [], got if ids is None else ids.flatten()):
            exp = to_px(np.array(tags[int(i)]["corners"], float))
            worst = max(worst, float(np.abs(c[0] - exp).max()))
        ok = got == want and worst < 0.5
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} face {plane['name']:8s}: {len(fw)} white + {len(fb)} black face triangles; "
              f"detected {got} (want {want}); worst corner error {worst:.3f} px at {PX:g} px/mm")

    # ---- 2. the whole rig through a camera, then solvePnP against rig.json -----------------
    K = np.array([[1400.0, 0, 800], [0, 1400.0, 600], [0, 0, 1]])
    W, H = 1600, 1200
    all_tris = np.concatenate([white, black])
    all_cols = [235] * len(white) + [15] * len(black)
    for eye in ([330.0, 260.0, 300.0], [260.0, 340.0, 230.0]):
        eye = np.array(eye)
        target = np.mean([t["center"] for t in rig["tags"]], axis=0)
        f = target - eye
        f /= np.linalg.norm(f)
        r = np.cross(f, [0, 0, 1.0])
        r /= np.linalg.norm(r)
        d = np.cross(f, r)  # image down
        R = np.stack([r, d, f])  # world -> camera rows
        t = -R @ eye
        cam = all_tris @ R.T + t  # (n, 3, 3) camera coords
        nrm = np.cross(all_tris[:, 1] - all_tris[:, 0], all_tris[:, 2] - all_tris[:, 0])
        facing = np.einsum("ij,ij->i", nrm, eye - all_tris[:, 0]) > 0  # back-face cull
        cam, cols = cam[facing], np.array(all_cols)[facing]
        uv = (cam[..., :2] / cam[..., 2:3]) * [K[0, 0], K[1, 1]] + [K[0, 2], K[1, 2]]
        img = rasterize(uv, 1.0 / cam[..., 2], cols, H, W, bg=128)
        cv2.imwrite(str(out / f"view_{int(eye[0])}_{int(eye[1])}.png"), img)
        cs, ids, _ = det.detectMarkers(img)
        found = sorted(int(i) for i in ids.flatten()) if ids is not None else []
        obj = np.concatenate([np.array(tags[int(i)]["corners"], float) for i in ids.flatten()])
        imgp = np.concatenate([c[0] for c in cs]).astype(np.float64)
        ok_pnp, rvec, tvec = cv2.solvePnP(obj, imgp, K, None, flags=cv2.SOLVEPNP_ITERATIVE)
        proj, _ = cv2.projectPoints(obj, rvec, tvec, K, None)
        rms = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - imgp) ** 2, 1))))
        R_est, _ = cv2.Rodrigues(rvec)
        rot_err = float(np.degrees(np.arccos(np.clip((np.trace(R_est.T @ R) - 1) / 2, -1, 1))))
        pos_err = float(np.linalg.norm((-R_est.T @ tvec.ravel()) - eye))
        planes_seen = sorted({tags[i]["plane"] for i in found})
        ok = ok_pnp and len(found) == len(tags) and len(planes_seen) == len(rig["planes"]) and rms < 0.3 and rot_err < 0.1 and pos_err < 1.0
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} 3D view from {eye.tolist()}: {len(found)} markers on {planes_seen}; "
              f"solvePnP reprojection RMS {rms:.3f} px, rotation error {rot_err:.4f} deg, camera position error {pos_err:.3f} mm")

    print("all OpenCV checks passed" if not failures else f"{failures} OpenCV check(s) FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(max(main(d) for d in (sys.argv[1:] or ["."])))
