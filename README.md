#Overview
In class I was wondering if I could make a web app that exported calibration arUco tags I can 3d print. This project is a mix of handwritten code and qwen3.8 4bit quantized running locally on a GPU.
While definitely not perfect with a 20k token context, it was impressive how much it could do for a non frontier model. Surprisingly it implemented a psuedo-code algorithm from gemeni better than gemeni wrote javascript for it.
However for the physics space maximization problem tuning the hyper parameters by hand ended up being the best method.
I found it was exceptional at debugging, and worked best when it referenced my handwritten code serving as a scaffold. 

The toggle at the top of the page picks what to make:

- **3D rig** (default) - a complete corner rig: a floor and two walls whose inner faces meet at one
  origin point, each face carrying its own ArUco markers. Every marker id on the rig is unique, so
  a single camera image of the rig gives a single pose. (Printing the old single plate three times
  put the same ids 40-43 on every face, which made the faces indistinguishable to a camera.)
- **one plane** - a single flat plate with N markers starting at the first id: the original
  MeshCalibrate use case, built the same printable way.

Every export follows the toggle. `?mode=plane` in the URL opens straight into one-plane mode.

#running the project
root directory run
```
npm install
npm run dev
```
open http://localhost:5713, pick **3D rig** or **one plane**, and set the face (plate) size, marker
size, markers per face, first marker id, plate thickness and inlay depth. The preview shows the rig
or plate with the origin axes (x red, y green, z blue) at its origin; the small squares show each
face as printed with its ids.

## Simulated calibration (`/simulate`) and the tutorial (`/tutorial`)

`npm run dev` (and `npm run preview`) also run a small **Node backend** on the same port
(`server/backend.js`, a Vite plugin):

- **http://localhost:5713/simulate** - photographs the rig you designed through a known camera
  (with lens distortion and sensor noise), then calibrates it with **OpenCV running in Node**
  (`opencv.js`, OpenCV compiled to WebAssembly): ArUco detection, Zhang calibration with every face
  of every photo as a planar view, and `solvePnP` per photo. Every estimate is compared with the
  truth, and every photo is shown with its detections, the reprojected rig corners and the rig axes.
  The **single view / multi-view** toggle picks one photo or N photos from around the rig; the
  **3D rig / one plane** toggle picks the target. The generator's "simulate calibration" link opens
  it with the current rig. API: `POST /api/simulate` with
  `{"views": "single"|"multi", "nViews", "noise", "seed", "rig": {...generator params}, "camera": {"W","H","fx","fy","cx","cy","k1","k2"}}`.
- **http://localhost:5713/tutorial** - [TUTORIAL.md](TUTORIAL.md) rendered: how the program is put
  together and the maths of every step (ArUco, the rig frame, the printable meshes, the camera model,
  PnP, Zhang, epipolar geometry, the simulation).

What to expect, with the defaults (1280 x 960, fx 1100, k1 -0.08):

| | focal length | principal point | camera positions |
|---|---|---|---|
| 3D rig, multi-view (8) | 0.1 % | 1.5 px | 0.4 mm mean |
| 3D rig, single view | 0.3 % | 10 px | 1.6 mm |
| one plane, multi-view (10) | 1.5 % | 13 px | 5 mm mean |
| one plane, single view | 0.2 % (principal point held at the centre) | - | 1.6 mm |

The backend needs the Node server: a static `npm run build` deploys the generator only.

## The rig

All numbers are millimetres in the **rig frame**:

- origin = the inner corner where the floor's top face (z = 0) and the two wall faces (y = 0 and
  x = 0) meet; +x and +y run along the floor, +z is up;
- each face's usable area is [0, S] x [0, S] (S = face size); the plates are T thick and sit behind
  the faces (floor at z in [-T, 0], wall_xz at y in [-T, 0], wall_yz at x in [-T, 0]);
- ids count up face by face: floor first, then wall_xz (the wall in the y = 0 plane), then wall_yz,
  in reading order on each face. Defaults: floor 40-43, wall_xz 44-47, wall_yz 48-51;
- markers are `DICT_ARUCO_ORIGINAL` (5x5 bits inside a black border, ids 0-1023), and every marker
  keeps at least one cell of white around it - the page refuses a layout that would break that.

**One plane** uses the same frame with only the floor: the plate is x, y in [0, S], z in [-T, 0],
the origin is the corner of its marker face (z = 0), and its ids run from the first id up
(default 40-43). Its rig.json has the same format with `planes` holding only `floor`.

## Printing (no supports)

Print it **floor down** (a plate: marker face up), as exported: the walls rise straight up from the
floor, so nothing overhangs and no supports are needed. The black cells are **inlays**: the white body has a pocket
under every black cell and the black part fills it flush with the face (`inlay depth`, default
1 mm). Every black island sits in its pocket, so nothing floats.

- **3MF (print)** - one object with two parts, `rig_white` and `rig_black`, already assigned to
  filament 1 (white) and filament 2 (black) with supports off. Open it in Bambu Studio / Orca and
  check that filament 2 is your black. The file carries the exporter's Bambu Lab A1 printer
  preset; switch printer if yours differs.
- **STL white / STL black** - the same two parts as plain STLs. Select both and open them together;
  answer *yes* to "load as a single object with multiple parts", then give the black part your black
  filament.
- 3D rig: expect many colour changes. The wall markers are on vertical faces, so every layer that
  crosses a wall marker prints both colours (about 350 layers at 0.2 mm with the defaults). Use a
  prime tower. A plate only changes colour for its top `inlay depth` (5 layers at 0.2 mm).

## Exports for calibration

- **rig.json** - what calibration code should read. Every marker with its id, face, size, centre
  and its four 3D corners in OpenCV's ArUco order (top-left, top-right, bottom-right, bottom-left as
  printed), all in the rig frame:

  ```json
  {"format": "meshcalibrate-rig/1", "units": "mm", "dictionary": "DICT_ARUCO_ORIGINAL",
   "planes": [{"name": "floor", "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, -1, 0]}, ...],
   "tags": [{"id": 40, "plane": "floor", "size_mm": 35, "center": [25, 75, 0],
             "corners": [[7.5, 92.5, 0], [42.5, 92.5, 0], [42.5, 57.5, 0], [7.5, 57.5, 0]]}, ...],
   "print": {"mode": "rig", "face_mm": 100, "thickness_mm": 5, "inlay_depth_mm": 1, "layout": "grid"}}
  ```

  `u` and `v` are each face's marker "right" and "down" as seen looking at the printed face.
- **CSV** - the old `calibration_rig_config.csv` columns (tag centres only). It has no corner
  order, so prefer rig.json.
- **GLB** - for viewers (glTF is Y-up, units mm).

`calibrate.py` reads either file: `python calibrate.py rig.json photo.png` (the CSV path still works
as before).

## Calibrating cameras with the printed rig

Two more export buttons give standalone Python scripts with **this rig built in** (its rig.json is
embedded, so the one file is all you need; works for the 3D rig and for one plane). Needs
`pip install opencv-python numpy`.

- **calibrate.py** - one camera.
  ```
  python calibrate.py photos/            # or photo1.jpg photo2.jpg ..., or --webcam 0 (SPACE keeps a frame)
  python calibrate.py --intrinsics calibration.json photo.jpg    # known camera: only where it is
  ```
  Detects the markers, matches them to the rig (pose hypotheses, so even repeated ids work),
  calibrates K and distortion and solves every photo's camera pose. Writes `calibration.json`
  (`--yaml` for OpenCV FileStorage, `--annotate DIR` to see what it found). By default every face
  of the rig in every photo is its own planar view (Zhang's method); `--method rig3d` uses the
  whole 3D rig per photo. Distortion terms are only freed when the markers reach far enough into
  the image corners to measure them - put the rig near the edges in some photos.
  The repository copy is `src/rig/calibrate.py` (`--rig rig.json` there).
- **stereo_calibrate.py** - a stereo pair.
  ```
  python stereo_calibrate.py --left 'left/*.png' --right 'right/*.png'    # or --webcam 0 1
  ```
  Calibrates both cameras, then `cv2.stereoCalibrate` on the markers both saw in each pair: R, T
  (camera 2 relative to camera 1), essential E = [T]x R, fundamental F = K2^-T E K1^-1, the epipolar
  (Sampson) error of every shared corner, the pair-to-pair spread, and rectification (R1, R2, P1,
  P2, Q, plus the remaining row error) for a stereo matcher. `--annotate` draws epipolar lines and
  rectified pairs. Give `--intrinsics1/2` (calibrate.py output) to keep each camera's own calibration.

Measured on synthetic photos rendered from the printed geometry (a 1280x960 camera with lens
distortion, rig 33-47 cm away; `tests/check_calibrate_script.py`, `tests/check_stereo_script.py`):

| | 3D rig (7 photos) | one plane (10 photos) |
|---|---|---|
| focal length | 0.002 % | 0.7 % |
| principal point | 9 px | 12 px |
| camera positions | within 2.1 mm | within 3.8 mm |
| stereo, cameras calibrated by the script | T 1.8 mm, R 0.41 deg, Sampson 0.17 px | T 0.8 mm, R 0.25 deg, Sampson 0.04 px |
| stereo, intrinsics given | T 0.43 mm, R 0.05 deg | T 0.03 mm, R 0.014 deg |

The principal point is what a small target pins down least; calibrate each camera with more
photos that fill the frame, then pass `--intrinsics1/2`, for the best stereo result.

## Tests

```
npm test                                   # geometry, 3MF structure, and the /simulate backend end to end
node tests/rig.test.mjs OUT && python tests/check_rig_opencv.py OUT OUT/plane
node tests/make_calibrate_script.mjs OUT OUT/plane     # the two scripts exactly as the buttons build them
python tests/check_calibrate_script.py OUT OUT/plane   # calibrate.py end to end on rendered photos
python tests/check_stereo_script.py OUT OUT/plane      # stereo_calibrate.py end to end on rendered pairs
```

`npm test` also runs `tests/simulate.test.mjs`: the /simulate backend end to end (render, opencv.js
detection and calibration, comparison with the truth) for single view and multi-view, 3D rig and
one plane.

Both modes are covered. The second line renders every face, and the whole rig or plate through a
pinhole camera, from the exported STL geometry (3D rig in OUT, one plane in OUT/plane). It then checks with OpenCV that the detected ids and corners match rig.json, and that
`solvePnP` against rig.json recovers the camera.
