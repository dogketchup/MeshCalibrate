// Software renderer for the simulation: photographs the printable geometry (the same two meshes the
// STL/3MF exports contain) through a camera with lens distortion. Pure JS, no OpenCV.
//
//  1. every triangle is moved into the camera frame, back faces are culled, and it is rasterised
//     into a supersampled z-buffer (1/z interpolated in screen space) as white or black;
//  2. the supersampled image is box-filtered down, so edges land at sub-pixel accuracy (pixel
//     centres at integer coordinates, OpenCV's convention);
//  3. lens distortion: every output pixel is a DISTORTED image point; undistorting it (OpenCV's
//     k1 k2 p1 p2 k3 model, fixed-point iteration) says where its ray hits the pinhole image, which is
//     sampled bilinearly;
//  4. optional sensor noise (Gaussian, grey levels).

/** A camera at `eye` looking at `aim` (rig mm), image-up roughly along rig +z. R: rig -> camera rows. */
export function lookFrom(eye, aim) {
  const f = norm(sub(aim, eye));
  const up = Math.abs(f[2]) < 0.99 ? [0, 0, 1] : [0, 1, 0];
  const r = norm(cross(f, up));
  const d = cross(f, r);
  const R = [r, d, f];
  return { R, t: R.map((row) => -dot(row, eye)) };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderView(meshes, cam, R, t, { ss = 2, noise = 0, rng = Math.random, white = 235, black = 15, bg = 128 } = {}) {
  const { W, H, fx, fy, cx, cy } = cam;
  const HW = W * ss, HH = H * ss;
  const hi = new Uint8Array(HW * HH).fill(bg);
  const zb = new Float32Array(HW * HH); // 1/z, 0 = empty
  const eye = [0, 1, 2].map((i) => -(R[0][i] * t[0] + R[1][i] * t[1] + R[2][i] * t[2]));
  const off = (ss - 1) / 2;
  for (const [mesh, val] of [[meshes.white, white], [meshes.black, black]]) {
    const P = mesh.positions, I = mesh.indices;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      const A = [P[a], P[a + 1], P[a + 2]], B = [P[b], P[b + 1], P[b + 2]], Cc = [P[c], P[c + 1], P[c + 2]];
      if (dot(cross(sub(B, A), sub(Cc, A)), sub(eye, A)) <= 0) continue;          // back face
      const v = [A, B, Cc].map((p) => [0, 1, 2].map((i) => dot(R[i], p) + t[i]));
      if (v[0][2] < 1 || v[1][2] < 1 || v[2][2] < 1) continue;                     // behind / too near
      const px = v.map((q) => [(fx * q[0] / q[2] + cx) * ss + off, (fy * q[1] / q[2] + cy) * ss + off, 1 / q[2]]);
      fill(px, val, hi, zb, HW, HH);
    }
  }
  // box filter down
  const pin = new Float32Array(W * H);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += hi[(y * ss + j) * HW + x * ss + i];
    pin[y * W + x] = s * inv;
  }
  // distortion + noise
  const { k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0 } = cam;
  const out = new Uint8Array(W * H);
  const gauss = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xd = (x - cx) / fx, yd = (y - cy) / fy;
    let xu = xd, yu = yd;
    for (let it = 0; it < 10; it++) {
      const r2 = xu * xu + yu * yu;
      const rad = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
      const dx = 2 * p1 * xu * yu + p2 * (r2 + 2 * xu * xu);
      const dy = p1 * (r2 + 2 * yu * yu) + 2 * p2 * xu * yu;
      xu = (xd - dx) / rad;
      yu = (yd - dy) / rad;
    }
    let v = sample(pin, W, H, fx * xu + cx, fy * yu + cy, bg);
    if (noise > 0) v += noise * gauss();
    out[y * W + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

function sample(img, W, H, x, y, bg) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) return bg;
  const fx = x - x0, fy = y - y0, i = y0 * W + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + W] * (1 - fx) + img[i + W + 1] * fx) * fy;
}

function fill(p, val, img, zb, W, H) {
  const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = p;
  const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(den) < 1e-12) return;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const z = l1 * az + l2 * bz + l3 * cz;
      const i = y * W + x;
      if (z > zb[i]) { zb[i] = z; img[i] = val; }
    }
  }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };
