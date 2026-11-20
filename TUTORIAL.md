# MeshCalibrate tutorial: how the program and the maths work

MeshCalibrate designs a printable ArUco calibration target, either a 3D corner rig or a single plate.
It exports the target for printing and for calibration code, and it can simulate a calibration with
it. This page walks through the program first, then the maths behind each step.

```
 parameters ──► rig model ──► printable meshes ──► 3MF / STL / GLB          (print it)
 (page)        (rigModel.js)   (rigMesh.js)    └──► rig.json / CSV           (describe it)
                                                └──► calibrate.py, stereo_calibrate.py (use it)
                                                └──► /simulate: render ► detect ► calibrate ► compare
```

## 1. The program, file by file

| file | what it does |
|---|---|
| `src/main.js` | The page: the 3D rig / one plane toggle, the parameter fields, the face previews and the export buttons. It calls `rebuild()` on every change. |
| `src/rig/rigModel.js` | `buildRig(params)` turns the parameters into a rig: its faces, and every marker's id, face, centre and 4 corners in millimetres. It also writes `rig.json` and the CSV. Pure JS with no DOM, so tests run it under Node. |
| `src/rig/arucoBits.js` | The 7 x 7 cell pattern of each marker id (DICT_ARUCO_ORIGINAL). |
| `src/rig/rigMesh.js` | `buildRigMesh(rig)` builds the printable geometry: two closed meshes, the white body and the black inlays. |
| `src/rig/rigGroup.js`, `src/threejsscene.js` | The three.js preview and the 3MF / GLB writers. |
| `src/rig/calibrate.py`, `src/rig/stereo_calibrate.py` | The calibration scripts. The export buttons embed `rig.json` into them (`calibrateScript.js`). |
| `server/backend.js` | The Node backend, mounted into the Vite server. It serves `/simulate`, `/api/simulate` and `/tutorial`. |
| `src/sim/render.js` | Software renderer: photographs the meshes through a camera with lens distortion. |
| `src/sim/simulate.js` | The simulated calibration, using OpenCV in Node (`opencv.js`, WebAssembly). |
| `tests/` | Mesh checks, 3MF checks, OpenCV cross-checks, and end-to-end runs of the two scripts. |

Everything that computes geometry is DOM-free. The page, the Node backend and the tests all call the
same `buildRig` and `buildRigMesh`. What you preview is what you print, what `rig.json` describes,
and what the simulation photographs.

## 2. ArUco markers

A DICT_ARUCO_ORIGINAL marker is a 7 x 7 grid of square cells. The outer ring is always black, and
the inner 5 x 5 cells are the data bits (white = 1). The dictionary has 1024 codes, ids 0-1023,
chosen to be far apart in Hamming distance in all four rotations. A detector can therefore tell
which way up the marker is, and can survive a misread bit or two.

The detector (`cv.aruco.ArucoDetector`):

1. thresholds the image adaptively, at several window sizes;
2. keeps contours that simplify to convex quadrilaterals;
3. un-warps each quadrilateral to a square and samples the 7 x 7 cells;
4. looks the bits up in all four rotations, and the matching rotation fixes which corner is the
   marker's top-left;
5. refines the corners to sub-pixel accuracy (`CORNER_REFINE_SUBPIX`).

The result for each marker is its **id and its 4 corners, always in the order top-left, top-right,
bottom-right, bottom-left as printed**. Everything after this works only on these corner points.

## 3. The rig and its frame

All three faces of the 3D rig meet at one point, the **origin**: the inner corner where the floor's
top face (z = 0) and the two wall faces (y = 0 and x = 0) meet. +z is up out of the floor, and each
face spans [0, S] on its two axes.

Each face also has marker axes `u` (marker "right") and `v` (marker "down"), as seen when you look at
the printed face. Because you look at a face against its normal n, `u x v = -n`:

| face | normal | u | v |
|---|---|---|---|
| floor | +z | +x | -y |
| wall_xz (y = 0) | +y | -x | -z |
| wall_yz (x = 0) | +x | +y | -z |

A marker of size s centred at c therefore has the corners

```
TL = c - s/2 u - s/2 v     TR = c + s/2 u - s/2 v     BR = c + s/2 u + s/2 v     BL = c - s/2 u + s/2 v
```

These are exactly the corners `rig.json` lists, in the order the detector reports them. Ids count up
from the first id: floor, then wall_xz, then wall_yz. No id repeats, so one photo gives one
unambiguous pose. The old design printed three identical plates with ids 40-43 on each, and that
pose was ambiguous.

## 4. Making it printable

The solid is the union of three slabs:

- floor: x, y in [-T, S], z in [-T, 0]
- wall_xz: x in [-T, S], y in [-T, 0], z in [0, S]
- wall_yz: x in [-T, 0], y in [0, S], z in [0, S]

Every black cell of every marker becomes an inlay, a cell-sized box D deep into its face. The white
body is everything else.

`rigMesh.js` builds the two meshes without any boolean (CSG) operations:

1. **Lattice.** Collect every coordinate where something changes along x, y and z: the slab faces,
   every cell edge and the inlay depth. That gives a rectilinear grid of boxes.
2. **Material.** Give each box a material: empty, white or black, from its centre point.
3. **Boundary extraction.** Emit a face wherever two neighbouring boxes differ in material: into the
   white mesh for its white side, and into the black mesh for its black side, oriented outward.

The grid is shared, so the two meshes meet edge to edge with no T-junctions. Both are closed, and
together they fill the solid exactly with no overlap; the tests check volumes against the analytic
solid. Where two black cells touch only diagonally, the shared edge is used by four triangles. Slicers
accept that.

**Why no supports.** The rig prints floor-down: the walls rise vertically from the floor, and every
black inlay sits inside a white body that is printed in the same layers. Nothing overhangs and nothing
floats. The 3MF holds both meshes as two parts of one object (extruder 1 white, extruder 2 black), so a
multi-colour printer prints the markers in place.

## 5. The camera model

A camera maps a 3D point to a pixel. In the camera's frame (OpenCV: +x right, +y down, +z forward):

```
x' = X / Z,  y' = Y / Z                                   perspective division
r^2 = x'^2 + y'^2
x'' = x' (1 + k1 r^2 + k2 r^4 + k3 r^6) + 2 p1 x'y' + p2 (r^2 + 2 x'^2)       lens distortion
y'' = y' (1 + k1 r^2 + k2 r^4 + k3 r^6) + p1 (r^2 + 2 y'^2) + 2 p2 x'y'
u = fx x'' + cx,   v = fy y'' + cy                         K: focal length, principal point (pixels)
```

K = `[[fx, 0, cx], [0, fy, cy], [0, 0, 1]]` and dist = `(k1, k2, p1, p2, k3)` are the
**intrinsics**. A point in the rig frame first goes through the camera pose,
`X_cam = R X_rig + t` (the **extrinsics**). The horizontal field of view follows from fx:
`HFOV = 2 atan(W / (2 fx))`.

## 6. Alignment: from corners to correspondences

Calibration needs pairs of the form "this pixel is that 3D point". A detected marker with id 44 gives
4 pixels, and `rig.json`'s marker 44 gives the same 4 corners in millimetres, in the same order.
That is 4 correspondences per marker.

The scripts do not trust ids blindly. Each (detection, rig marker with that id) proposes a pose. The
pose that explains the most detections wins, meaning other markers project within about a third of a
marker of where they were detected, and face the camera. It is then refined with all of them. With
unique ids this is plain PnP with outlier rejection. With repeated ids, as on the old plates, it is
what tells two markers with the same id apart.

## 7. Pose: solvePnP

Given K, dist and N >= 4 correspondences, Perspective-n-Point finds the R, t that minimise the
reprojection error:

```
E(R, t) = sum_i || detected_i - project(K, dist, R X_i + t) ||^2
```

- **IPPE** solves the planar case in closed form. It returns two solutions, because a small marker
  seen nearly head-on looks almost the same tilted either way. Many markers on several faces settle it.
- **Levenberg-Marquardt** (`SOLVEPNP_ITERATIVE`) refines the pose using every corner.
- The **reprojection error**, the rms distance between detected corners and the rig projected back,
  measures how well everything fits. Below about 0.5 px is good.

The camera's position in the rig frame is `-R^T t`, and its orientation is `R^T`.

## 8. Intrinsic calibration: Zhang's method

For points on one plane (Z = 0 in that plane's own frame), projection is a homography H:

```
s [u v 1]^T = K [r1 r2 t] [X Y 1]^T = H [X Y 1]^T
r1 . r2 = 0 and |r1| = |r2|   =>   h1^T w h2 = 0,   h1^T w h1 = h2^T w h2,   with w = K^-T K^-1
```

Each plane view gives 2 equations in the 5 unknowns of K, so **3 differently tilted planes** fix K in
closed form. `calibrateCamera` then refines K, the distortion and every view's pose together, by
minimising the total reprojection error (a small bundle adjustment).

**Why the corner rig helps.** Its three faces are three tilted planes in a single photo. Both the
scripts and the simulation treat each face of each photo as a separate planar view, using only where
the markers sit within that face. A slightly imperfect assembly of the faces therefore cannot bias K.

**Which terms are solved.** Distortion is visible only away from the image centre. The code frees a
term only when the data can carry it:

- k3, p1 and p2 are held at 0. Webcam lenses have next to no tangential distortion, and freeing it
  lets the principal point wander.
- k2 is freed only with 120 or more corners that reach 60 % of the way to the image corners.
- k1 is fixed as well if the markers never get past 30 % of that way.
- With fewer than 3 planar views, the principal point stays at the image centre and fx = fy.

A flat plate in one photo is one plane, so only the focal length can be solved. That is why the plate
needs several photos from different angles, while one photo of the 3D rig already gives fx, fy, cx
and cy.

## 9. Two cameras: epipolar geometry

If both cameras see the rig, the markers seen by both give the same 3D points in two images.
`stereoCalibrate` then finds the pose of camera 2 relative to camera 1:

```
x2 = R x1 + T
E = [T]x R               essential matrix: relates the two cameras' viewing rays
F = K2^-T E K1^-1        fundamental matrix: relates pixels.  p2^T F p1 = 0
```

A corner p1 in camera 1 must lie on the line `l2 = F p1` in camera 2. The **Sampson distance** of
each shared corner from its epipolar line is the check, and a few tenths of a pixel is good.
**Rectification** (`stereoRectify`) rotates both images so that matching points land on the same row.
That is what a stereo matcher needs, and its Q matrix turns disparity into depth.

## 10. The simulation (`/simulate`)

The backend photographs the rig you designed and calibrates it, so you can see what to expect before
you print.

1. **Viewpoints.** *Single view*: one photo from a typical angle. *Multi-view*: N photos around the
   rig, 33-47 cm away, mostly aimed past it, so the markers reach the image edges where distortion is
   measurable.
2. **Rendering** (`render.js`). Every triangle of the white and black meshes is transformed into the
   camera frame, back-face culled and rasterised into a 2 x supersampled z-buffer (1/z interpolated in
   screen space). The image is then box-filtered down, so edges land at sub-pixel accuracy.
3. **Lens distortion.** Each output pixel is a *distorted* image point. Undistorting it (the model
   above, solved by fixed-point iteration) says where its ray hits the pinhole image, which is sampled
   bilinearly. Gaussian sensor noise is added.
4. **OpenCV in Node.** `opencv.js` (OpenCV compiled to WebAssembly) detects the markers, calibrates
   with every face of every photo as a planar view, and runs `solvePnP` for each photo.
5. **Comparison.** Every estimate is checked against the truth: focal length, principal point,
   distortion, each camera position and rotation, and markers detected versus markers visible.

Typical results with the defaults (1280 x 960, fx 1100, k1 -0.08, noise 2 grey levels):

| | focal length | principal point | camera positions |
|---|---|---|---|
| 3D rig, multi-view (8) | 0.1 % | 1.5 px | 0.4 mm mean |
| 3D rig, single view | 0.3 % | 10 px | 1.6 mm |
| one plane, multi-view (10) | 1.5 % | 13 px | 5 mm mean |
| one plane, single view | 0.2 % (pp held at centre) | - | 1.6 mm |

Two traps when using `opencv.js` from Node, both handled in `src/sim`:

- **The module is a "thenable".** Its `then()` hands back the module itself, so `await`ing it, or
  resolving a Promise with it, loops forever. `cvLoader.js` polls for readiness and returns it
  wrapped as `{ cv }`.
- **The calibration flag names are wrong.** It exports the *fisheye* module's constants under the
  `cv.CALIB_*` names. There, `CALIB_FIX_K1` is 16, which `calibrateCamera` reads as
  `CALIB_FIX_FOCAL_LENGTH`. `simulate.js` uses calib3d's real values.

## 11. Practical tips

- **Print.** Print the 3D rig floor-down, with black filament on the inlay part and no supports. Check
  that the walls are square: the calibration only needs each face to be flat, but poses are reported
  in the rig frame.
- **Photograph.** Take 5-10 photos. Tilt the camera differently each time, put the rig near the
  image edges in some, and keep it sharp and well lit.
- **Calibrate one camera.** Run `python calibrate.py photos/`, then check the rms (< 0.5 px) and the
  notes, which say which terms it could solve.
- **Calibrate a stereo pair.** Calibrate each camera well first, then run
  `python stereo_calibrate.py --left ... --right ... --intrinsics1 a.json --intrinsics2 b.json`.
