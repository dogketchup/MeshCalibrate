import cv2
import numpy as np
import csv


def show_debug_step(title, image, math_explanation=""):
    """Utility to cleanly display intermediate visual steps and pause for narration.

    Press any key (or Spacebar) to move to the next slide.
    """
    print(f"\n==================================================")
    print(f" DISPLAYING: {title}")
    if math_explanation:
        print(f" MATH INSIGHT:\n {math_explanation}")
    print(f"==================================================")
    print("--> [PRESS ANY KEY ON THE IMAGE WINDOW TO CONTINUE] <--\n")

    # Display image in a normalized, recording-friendly window size
    cv2.namedWindow(title, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(title, 960, 720)
    cv2.imshow(title, image)
    cv2.waitKey(0)  # BREAKPOINT: Pauses execution until keypress
    cv2.destroyWindow(title)


def load_rig_config(csv_path):
    """
    Loads 3D tag center points from CSV and builds exact 3D corner coordinates
    aligned clockwise (0 -> 1 -> 2 -> 3) with OpenCV ArUco detections.
    """
    rig_data = {}
    
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            row_clean = {k.strip().lower(): v.strip() for k, v in row.items() if k}
            
            def get_col(possible_names):
                for name in possible_names:
                    for k in row_clean:
                        if name == k or name in k:
                            return row_clean[k]
                return None

            tag_id_str = get_col(["tag_id", "tag", "id"])
            if tag_id_str is None:
                continue
            tag_id = int(tag_id_str)

            cx = float(get_col(["x_center", "center_x", "pos_x", "x_m", "x"]))
            cy = float(get_col(["y_center", "center_y", "pos_y", "y_m", "y"]))
            cz = float(get_col(["z_center", "center_z", "pos_z", "z_m", "z"]))

            tag_size_str = get_col(["size", "tag_size", "length"])
            tag_size = float(tag_size_str) if tag_size_str else 0.05
            half = tag_size / 2.0

            plane_str = get_col(["plane", "plane_id", "surface"])
            plane = plane_str.lower() if plane_str else ""

            # 1. FLOOR PLANE (XY plane, Z constant)
            if "plane_1" in plane or "xy" in plane or "floor" in plane or tag_id in (0, 1, 2, 3):
                if tag_id in (2, 3):
                    # Front floor tags (180 deg rotated: Corner 0 is Front-Right -> Front-Left -> Back-Left -> Back-Right)
                    corners = [
                        [cx - half, cy + half, cz],  # 0: Front-Right
                        [cx + half, cy + half, cz],  # 1: Front-Left
                        [cx + half, cy - half, cz],  # 2: Back-Left
                        [cx - half, cy - half, cz],  # 3: Back-Right
                    ]
                else:
                    # Back floor tags (Corner 0 is Back-Left -> Back-Right -> Front-Right -> Front-Left)
                    corners = [
                        [cx + half, cy - half, cz],  # 0: Back-Left
                        [cx - half, cy - half, cz],  # 1: Back-Right
                        [cx - half, cy + half, cz],  # 2: Front-Right
                        [cx + half, cy + half, cz],  # 3: Front-Left
                    ]

            # 2. LEFT WALL (XZ plane, Y constant)
            elif "plane_2" in plane or "xz" in plane or "left" in plane or tag_id in (52, 53, 54, 55):
                corners = [
                    [cx + half, cy, cz + half],  # 0: Top-Left
                    [cx - half, cy, cz + half],  # 1: Top-Right
                    [cx - half, cy, cz - half],  # 2: Bottom-Right
                    [cx + half, cy, cz - half],  # 3: Bottom-Left
                ]

            # 3. RIGHT WALL (YZ plane, X constant)
            elif "plane_3" in plane or "yz" in plane or "right" in plane or tag_id in (100, 101, 102, 103):
                corners = [
                    [cx, cy - half, cz + half],  # 0: Top-Left
                    [cx, cy + half, cz + half],  # 1: Top-Right
                    [cx, cy + half, cz - half],  # 2: Bottom-Right
                    [cx, cy - half, cz - half],  # 3: Bottom-Left
                ]
            else:
                continue

            rig_data[tag_id] = np.array(corners, dtype=np.float32)

    return rig_data


def detect_2d_corners(image_path, dictionary_type=cv2.aruco.DICT_ARUCO_ORIGINAL):
    """Loads image, converts to gray, detects ArUco tags, and returns 2D pixel coordinates."""
    image = cv2.imread(image_path)
    if image is None:
        raise FileNotFoundError(f"Could not open or find image: {image_path}")

    # BREAKPOINT 1: Raw Photo Input
    show_debug_step(
        "Step 1: Input Photograph",
        image,
        "Raw RGB image matrix representing discrete 2D pixel spatial coordinates.",
    )

    # Convert to Grayscale
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # BREAKPOINT 2: Color Space Reduction
    show_debug_step(
        "Step 2: Grayscale Conversion (cv2.cvtColor)",
        gray,
        "Reduces 3D color channels (BGR) to 1D intensity luminance values using: "
        "Y = 0.299R + 0.587G + 0.114B",
    )

    dictionary = cv2.aruco.getPredefinedDictionary(dictionary_type)
    params = cv2.aruco.DetectorParameters()

    try:
        detector = cv2.aruco.ArucoDetector(dictionary, params)
        corners, ids, _ = detector.detectMarkers(gray)
    except AttributeError:
        corners, ids, _ = cv2.aruco.detectMarkers(gray, dictionary)

    detected_tags = {}
    if ids is not None:
        for i, tag_id in enumerate(ids.flatten()):
            detected_tags[tag_id] = corners[i][0]

    # BREAKPOINT 3: Subpixel Corner Detection & Orientation
    debug_img = image.copy()
    if ids is not None:
        cv2.aruco.drawDetectedMarkers(debug_img, corners, ids)
        # Highlight Corner 0 (Red Circle) for every detected tag
        for tag_corners in corners:
            c0 = tuple(tag_corners[0][0].astype(int))
            cv2.circle(debug_img, c0, 7, (0, 0, 255), -1)

    show_debug_step(
        "Step 3: ArUco Quadrilateral & Corner 0 Detection",
        debug_img,
        "Detects quad borders, applies subpixel corner refinement, and assigns "
        "Corner 0 (marked in RED) to establish strict clockwise orientation (0->1->2->3).",
    )

    return detected_tags, image.shape, image


def calibrate_camera(obj_points, img_points, image_size):
    """Solves for intrinsic matrix K, distortion coefficients D, and camera pose extrinsics."""
    all_obj_pts = np.vstack(obj_points).astype(np.float32)
    all_img_pts = np.vstack(img_points).astype(np.float32)

    width, height = image_size

    # 1. Construct initial intrinsic matrix guess K0
    focal_guess = float(width)
    cx_guess = width / 2.0
    cy_guess = height / 2.0

    initial_K = np.array(
        [[focal_guess, 0.0, cx_guess], [0.0, focal_guess, cy_guess], [0.0, 0.0, 1.0]],
        dtype=np.float32,
    )

    print(
        f"\nInitial Guess Matrix K0:\n{initial_K}\n"
        f"Assumes focal length fx = fy = {focal_guess:.1f} px and principal point at center ({cx_guess:.1f}, {cy_guess:.1f})."
    )

    # 2. Pass initial_K into Non-Linear Optimization Solver
    ret, camera_matrix, dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
        [all_obj_pts],
        [all_img_pts],
        image_size,
        initial_K,
        None,
        flags=cv2.CALIB_USE_INTRINSIC_GUESS,
    )

    return ret, camera_matrix, dist_coeffs, rvecs[0], tvecs[0]


if __name__ == "__main__":
    # 1. Load 3D physical coordinates from CSV
    try:
        rig_data = load_rig_config("calibration_rig_config.csv")
        print(f"Loaded {len(rig_data)} tags from CSV config.")
    except FileNotFoundError:
        print("Error: 'calibration_rig_config.csv' not found.")
        rig_data = {}

    # 2. Detect 2D pixel coordinates from photo with visual waitKeys
    photo_filename = "rig_photo.png"
    try:
        detected_tags, img_shape, raw_image = detect_2d_corners(photo_filename)
        image_size = (img_shape[1], img_shape[0])
    except FileNotFoundError:
        print(f"Error: '{photo_filename}' not found.")
        detected_tags = {}

    # 3. Match 3D physical points to 2D image detections
    obj_points = []
    img_points = []

    match_vis_img = raw_image.copy()

    for tag_id, pixel_corners in detected_tags.items():
        if tag_id in rig_data:
            obj_points.append(rig_data[tag_id])
            img_points.append(pixel_corners)

            # Draw visual text connection on matched tags
            for idx, (x, y) in enumerate(pixel_corners):
                world_pt = rig_data[tag_id][idx]
                cv2.circle(match_vis_img, (int(x), int(y)), 4, (0, 255, 0), -1)

    # BREAKPOINT 4: 2D-to-3D Point Association
    show_debug_step(
        "Step 4: 2D Pixel to 3D World Point Matching",
        match_vis_img,
        f"Successfully paired {len(obj_points)} detected ArUco tags. Each 2D pixel point (u,v) "
        f"is now explicitly linked to a known 3D spatial coordinate (X,Y,Z) from the CSV.",
    )

    # 4. Run Camera Calibration Solver
    if len(obj_points) > 0:
        rms_error, K, D, rvec, tvec = calibrate_camera(
            obj_points, img_points, image_size
        )

        print("\n=== CALIBRATION RESULTS ===")
        print(f"RMS Reprojection Error: {rms_error:.4f} pixels")
        print("\nOptimized Intrinsic Matrix (K):")
        print(K)
        print(f"  - Focal Length (fx, fy): ({K[0,0]:.2f}, {K[1,1]:.2f}) px")
        print(f"  - Principal Point (cx, cy): ({K[0,2]:.2f}, {K[1,2]:.2f}) px")

        print("\nDistortion Coefficients (D):")
        print(D.ravel())
        print("  - Parameters: [k1, k2, p1, p2, k3]")

        # BREAKPOINT 5: Reprojection Verification
        # Project the 3D CSV points back onto the 2D image plane using solved K, D, rvec, tvec
        all_obj = np.vstack(obj_points).astype(np.float32)
        all_img = np.vstack(img_points).astype(np.float32)

        reprojected_pts, _ = cv2.projectPoints(all_obj, rvec, tvec, K, D)
        reprojected_pts = reprojected_pts.reshape(-1, 2)

        reproject_vis = raw_image.copy()

        for i in range(len(all_img)):
            # Measured 2D detected point (GREEN)
            pt_detected = tuple(all_img[i].astype(int))
            cv2.circle(reproject_vis, pt_detected, 5, (0, 255, 0), -1)

            # Mathematically reprojected point (RED)
            pt_projected = tuple(reprojected_pts[i].astype(int))
            cv2.circle(reproject_vis, pt_projected, 3, (0, 0, 255), -1)

        show_debug_step(
            "Step 5: Visual Reprojection Error Verification",
            reproject_vis,
            f"Overlaying detected 2D corners (GREEN) against reprojected 3D points (RED).\n"
            f"Equation: s * [u, v, 1]^T = K * [R | t] * [X, Y, Z, 1]^T.\n"
            f"Mean distance error across all points = {rms_error:.4f} pixels.",
        )

    else:
        print("Calibration aborted: No matched tags between CSV and image.")