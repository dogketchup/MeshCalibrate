// Printable meshes for the corner rig or the single plate. DOM-free (runs under node).
//
// The target is cut into a rectilinear grid whose lines are every plate edge, the
// inlay depth and every marker-cell edge on every face. Each grid cell is
// empty, white or black, and a face is emitted only where the material changes
// across a cell wall. Because all faces live on one global lattice the result
// is two closed, conforming meshes (no T-junctions) that share their contact
// faces exactly and never overlap:
//   white - the body, with a pocket under every black cell
//   black - the inlay that fills those pockets, flush with the face
// Every black island sits in a pocket of the white body, so nothing floats, and
// the walls rise straight off the floor, so nothing needs supports.
// Two black cells that touch only along an edge (a diagonal in the bit
// pattern) share that edge between four faces; slicers accept that.
import { PLANES } from './rigModel.js';

/** Is the cell centred at (x, y, z) inside the solid, and which plate is it part of? */
function plateAt(mode, S, T, x, y, z) {
  const inside = (v, lo, hi) => v > lo && v < hi;
  if (mode === 'plane') return inside(x, 0, S) && inside(y, 0, S) && inside(z, -T, 0) ? 'floor' : null;
  if (inside(x, -T, S) && inside(y, -T, S) && inside(z, -T, 0)) return 'floor';
  if (inside(x, -T, S) && inside(y, -T, 0) && inside(z, 0, S)) return 'wall_xz';
  if (inside(x, -T, 0) && inside(y, 0, S) && inside(z, 0, S)) return 'wall_yz';
  return null;
}

const EMPTY = 0, WHITE = 1, BLACK = 2;
const EPS = 1e-7;

function sortedUnique(values) {
  const v = [...values].sort((a, b) => a - b);
  const out = [];
  for (const x of v) if (!out.length || x - out[out.length - 1] > EPS) out.push(x);
  return out;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const axisOf = (vec) => vec.findIndex((c) => c !== 0);

/** Which cell of which marker (if any) covers point p on a face, and is it black. */
function blackOnFace(tags, plane, cellMm, p) {
  for (const t of tags) {
    const a = dot([p[0] - t.center[0], p[1] - t.center[1], p[2] - t.center[2]], plane.u) + t.sizeMm / 2;
    const b = dot([p[0] - t.center[0], p[1] - t.center[1], p[2] - t.center[2]], plane.v) + t.sizeMm / 2;
    if (a <= 0 || b <= 0 || a >= t.sizeMm || b >= t.sizeMm) continue;
    const col = Math.floor(a / cellMm), row = Math.floor(b / cellMm);
    return t.cells[row][col];
  }
  return false;
}

/**
 * @returns {{white: {positions: Float32Array, indices: Uint32Array},
 *            black: {positions: Float32Array, indices: Uint32Array},
 *            lattice: number[], cells: {white: number, black: number}}}
 */
export function buildRigMesh(rig) {
  const { faceMm: S, thicknessMm: T, inlayDepthMm: D } = rig.params;
  const cell = rig.cellMm;
  const mode = rig.params.mode;
  const byPlane = Object.fromEntries(PLANES.map((pl) => [pl.name, rig.tags.filter((t) => t.plane === pl.name)]));

  // ---- lattice: plate edges, inlay depth, and every marker-cell edge --------
  const lines = [new Set([-T, -D, 0, S]), new Set([-T, -D, 0, S]), new Set([-T, -D, 0, S])];
  for (const plane of rig.planes) {
    const au = axisOf(plane.u), av = axisOf(plane.v);
    for (const t of byPlane[plane.name]) {
      for (let k = 0; k <= 7; k++) {
        const off = -t.sizeMm / 2 + k * cell;
        lines[au].add(t.center[au] + plane.u[au] * off);
        lines[av].add(t.center[av] + plane.v[av] * off);
      }
    }
  }
  const L = lines.map(sortedUnique);
  const n = L.map((l) => l.length - 1);

  // ---- material of every grid cell -----------------------------------------
  const inside = (x, lo, hi) => x > lo && x < hi;
  const mat = new Uint8Array(n[0] * n[1] * n[2]);
  const idx = (i, j, k) => i + n[0] * (j + n[1] * k);
  const [floor, wallXZ, wallYZ] = PLANES;
  let whiteCells = 0, blackCells = 0;
  for (let k = 0; k < n[2]; k++) {
    const z = (L[2][k] + L[2][k + 1]) / 2;
    for (let j = 0; j < n[1]; j++) {
      const y = (L[1][j] + L[1][j + 1]) / 2;
      for (let i = 0; i < n[0]; i++) {
        const x = (L[0][i] + L[0][i + 1]) / 2;
        const p = [x, y, z];
        const plate = plateAt(mode, S, T, x, y, z);
        let m = EMPTY;
        if (plate) {
          m = WHITE;
          if (plate === 'floor' && z > -D && inside(x, 0, S) && inside(y, 0, S) && blackOnFace(byPlane.floor, floor, cell, p)) m = BLACK;
          else if (plate === 'wall_xz' && y > -D && inside(x, 0, S) && blackOnFace(byPlane.wall_xz, wallXZ, cell, p)) m = BLACK;
          else if (plate === 'wall_yz' && x > -D && blackOnFace(byPlane.wall_yz, wallYZ, cell, p)) m = BLACK;
        }
        mat[idx(i, j, k)] = m;
        if (m === WHITE) whiteCells++;
        else if (m === BLACK) blackCells++;
      }
    }
  }
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= n[0] || j >= n[1] || k >= n[2]) ? EMPTY : mat[idx(i, j, k)];

  // ---- boundary faces ---------------------------------------------------------
  const out = { [WHITE]: { verts: new Map(), pos: [], tri: [] }, [BLACK]: { verts: new Map(), pos: [], tri: [] } };
  const vkey = (i, j, k) => i + (n[0] + 1) * (j + (n[1] + 1) * k);
  const vertex = (m, g) => {
    const o = out[m];
    const key = vkey(g[0], g[1], g[2]);
    let id = o.verts.get(key);
    if (id === undefined) {
      id = o.pos.length / 3;
      o.verts.set(key, id);
      o.pos.push(L[0][g[0]], L[1][g[1]], L[2][g[2]]);
    }
    return id;
  };
  // quad on the plane axis[a] = lattice index c, spanning cell (jb, kc) of the other two axes
  const quad = (m, a, c, jb, kc, positive) => {
    const b = (a + 1) % 3, d = (a + 2) % 3;
    const g = (ub, ud) => { const v = [0, 0, 0]; v[a] = c; v[b] = jb + ub; v[d] = kc + ud; return v; };
    const v0 = vertex(m, g(0, 0)), v1 = vertex(m, g(1, 0)), v2 = vertex(m, g(1, 1)), v3 = vertex(m, g(0, 1));
    // (e_b, e_d) is a cyclic pair after e_a, so v0 -> v1 -> v2 winds about +e_a
    if (positive) out[m].tri.push(v0, v1, v2, v0, v2, v3);
    else out[m].tri.push(v0, v2, v1, v0, v3, v2);
  };
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, d = (a + 2) % 3;
    for (let c = 0; c <= n[a]; c++) {           // cell wall between cell c-1 and cell c along axis a
      for (let jb = 0; jb < n[b]; jb++) {
        for (let kc = 0; kc < n[d]; kc++) {
          const lo = [0, 0, 0], hi = [0, 0, 0];
          lo[a] = c - 1; hi[a] = c; lo[b] = hi[b] = jb; lo[d] = hi[d] = kc;
          const mLo = at(lo[0], lo[1], lo[2]), mHi = at(hi[0], hi[1], hi[2]);
          if (mLo === mHi) continue;
          if (mLo !== EMPTY) quad(mLo, a, c, jb, kc, true);   // outward from the low cell: +axis
          if (mHi !== EMPTY) quad(mHi, a, c, jb, kc, false);  // outward from the high cell: -axis
        }
      }
    }
  }
  const pack = (m) => ({ positions: new Float32Array(out[m].pos), indices: new Uint32Array(out[m].tri) });
  return { white: pack(WHITE), black: pack(BLACK), lattice: L, cells: { white: whiteCells, black: blackCells } };
}

/** Closed solid volume from the divergence theorem (mm^3). */
export function meshVolume({ positions: P, indices: I }) {
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
       - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
       + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

/** Binary STL of one mesh (ArrayBuffer). Units are mm, as slicers assume. */
export function meshToStl({ positions: P, indices: I }, name = 'mesh') {
  const triCount = I.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  const header = `MeshCalibrate ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let o = 84;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const val of [nx, ny, nz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]) {
      dv.setFloat32(o, val, true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
