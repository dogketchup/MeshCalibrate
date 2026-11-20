// node tests/rig.test.mjs [outdir]
// Builds the default corner rig, checks the two meshes are closed, consistently
// oriented and non-overlapping, and (with outdir) writes rig.json, rig.csv and
// the two STLs for tests/check_rig_opencv.py.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigToJson, rigJsonText, rigToCsv } from '../src/rig/rigModel.js';
import { buildRigMesh, meshVolume, meshToStl } from '../src/rig/rigMesh.js';

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };

const VARIANTS = [
  {},                                                        // defaults (written to outdir)
  { tagsPerPlane: 1, tagSizeMm: 60 },
  { tagsPerPlane: 3, tagSizeMm: 28, thicknessMm: 3, inlayDepthMm: 0.6 },
  { tagsPerPlane: 9, tagSizeMm: 21, faceMm: 120, baseId: 100 },
  { tagsPerPlane: 4, tagSizeMm: 35, layout: 'physics' },
  { tagsPerPlane: 4, tagSizeMm: 33.3, faceMm: 97.5, thicknessMm: 4.2, inlayDepthMm: 0.8 },
];
const outdir = process.argv[2];
for (const [vi, params] of VARIANTS.entries()) {
console.log(`--- variant ${vi}: ${JSON.stringify(params)}`);
const rig = buildRig(params);
const mesh = buildRigMesh(rig);
const { faceMm: S, thicknessMm: T, inlayDepthMm: D } = rig.params;

// ---- ids --------------------------------------------------------------------
const ids = rig.tags.map((t) => t.id);
check(new Set(ids).size === ids.length, `ids unique across the rig: ${ids.join(' ')}`);
for (const plane of ['floor', 'wall_xz', 'wall_yz']) {
  check(rig.tags.filter((t) => t.plane === plane).length === rig.params.tagsPerPlane, `${plane} carries ${rig.params.tagsPerPlane} markers`);
}

// ---- closedness ------------------------------------------------------------------
function edgeReport({ indices: I }) {
  const directed = new Map();
  const undirected = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (let t = 0; t < I.length; t += 3) {
    for (const [a, b] of [[I[t], I[t + 1]], [I[t + 1], I[t + 2]], [I[t + 2], I[t]]]) {
      bump(directed, `${a},${b}`);
      bump(undirected, a < b ? `${a},${b}` : `${b},${a}`);
    }
  }
  let unbalanced = 0;
  for (const [k, c] of directed) {
    const [a, b] = k.split(',');
    if ((directed.get(`${b},${a}`) || 0) !== c) unbalanced++;
  }
  const uses = {};
  for (const c of undirected.values()) uses[c] = (uses[c] || 0) + 1;
  return { unbalanced, uses };
}
function bbox({ positions: P }) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[i + a]); hi[a] = Math.max(hi[a], P[i + a]); }
  return { lo, hi };
}
for (const name of ['white', 'black']) {
  const m = mesh[name];
  const r = edgeReport(m);
  const b = bbox(m);
  console.log(`     ${name}: ${m.indices.length / 3} triangles, ${m.positions.length / 3} vertices, bbox [${b.lo.join(', ')}] .. [${b.hi.join(', ')}], edge use counts ${JSON.stringify(r.uses)}`);
  check(r.unbalanced === 0, `${name}: every directed edge has its reverse (closed, consistently oriented)`);
  check(Object.keys(r.uses).every((c) => Number(c) % 2 === 0), `${name}: every edge is used by an even number of triangles`);
}

// ---- volumes: white + black fill exactly the solid, black is exactly the inlay ----
const vSolid = (S + T) * (S + T) * T + (S + T) * T * S + T * S * S;
const blackCellsPerTag = rig.tags.reduce((n, t) => n + t.cells.flat().filter(Boolean).length, 0);
const vBlackExpected = blackCellsPerTag * rig.cellMm * rig.cellMm * D;
const vWhite = meshVolume(mesh.white), vBlack = meshVolume(mesh.black);
console.log(`     volumes mm^3: white ${vWhite.toFixed(3)}  black ${vBlack.toFixed(3)} (expected ${vBlackExpected.toFixed(3)})  sum ${(vWhite + vBlack).toFixed(3)}  solid ${vSolid.toFixed(3)}`);
check(Math.abs(vWhite + vBlack - vSolid) < 1e-6 * vSolid, 'white + black volume == solid volume');
check(Math.abs(vBlack - vBlackExpected) < 1e-6 * vBlackExpected + 1e-3, 'black volume == black cells x cell area x inlay depth');
check(vWhite > 0 && vBlack > 0, 'both volumes positive (outward normals)');

// ---- no point is inside both bodies (ray parity along +x) ------------------------------
function insideX(m, p) {
  const P = m.positions, I = m.indices;
  let hits = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    if (P[a] !== P[b] || P[a] !== P[c]) continue;   // only faces perpendicular to x can be crossed
    if (P[a] <= p[0]) continue;
    // 2D point-in-triangle in (y, z)
    const [y, z] = [p[1], p[2]];
    const d1 = (y - P[b + 1]) * (P[a + 2] - P[b + 2]) - (P[a + 1] - P[b + 1]) * (z - P[b + 2]);
    const d2 = (y - P[c + 1]) * (P[b + 2] - P[c + 2]) - (P[b + 1] - P[c + 1]) * (z - P[c + 2]);
    const d3 = (y - P[a + 1]) * (P[c + 2] - P[a + 2]) - (P[c + 1] - P[a + 1]) * (z - P[a + 2]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) hits++;
  }
  return hits % 2 === 1;
}
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let both = 0, inW = 0, inB = 0, agree = 0;
const SAMPLES = 1500;
for (let s = 0; s < SAMPLES; s++) {
  // half the samples in the thin inlay layers where black and white meet
  const p = s % 2
    ? [-T + rnd() * (S + T), -T + rnd() * (S + T), -T + rnd() * (S + T)]
    : [[rnd() * S, rnd() * S, -D * rnd()], [rnd() * S, -D * rnd(), rnd() * S], [-D * rnd(), rnd() * S, rnd() * S]][s % 3];
  const w = insideX(mesh.white, p), b = insideX(mesh.black, p);
  if (w && b) both++;
  if (w) inW++;
  if (b) inB++;
  const x = p[0], y = p[1], z = p[2];
  const solid = (x > -T && x < S && y > -T && y < S && z > -T && z < 0) || (x > -T && x < S && y > -T && y < 0 && z > 0 && z < S) || (x > -T && x < 0 && y > 0 && y < S && z > 0 && z < S);
  if (solid === (w || b)) agree++;
}
console.log(`     ${SAMPLES} sample points: ${inW} in white, ${inB} in black, ${both} in both, ${agree} agree with the analytic solid`);
check(both === 0, 'no sample point is inside both bodies');
check(agree === SAMPLES, 'white + black occupancy matches the analytic solid at every sample');

// ---- corners: TL->TR is +u, TL->BL is +v, centre in the middle ------------------------
let cornerOk = true;
for (const t of rig.tags) {
  const pl = rig.planes.find((p) => p.name === t.plane);
  const [tl, tr, br, bl] = t.corners;
  const du = tr.map((x, i) => x - tl[i]), dv = bl.map((x, i) => x - tl[i]);
  const exp = (vec) => vec.map((x) => x * t.sizeMm);
  const close = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
  if (!close(du, exp(pl.u)) || !close(dv, exp(pl.v)) || !close(br, tl.map((x, i) => x + du[i] + dv[i]))) cornerOk = false;
  // every corner lies on its face plane and inside [0, S]
  for (const c of t.corners) {
    if (Math.abs(c.reduce((acc, x, i) => acc + x * pl.normal[i], 0)) > 1e-9) cornerOk = false;
    if (c.some((x) => x < -1e-9 || x > S + 1e-9)) cornerOk = false;
  }
}
check(cornerOk, 'every marker: corners follow (u, v), lie on their face at the shared origin, inside [0, S]');

if (outdir && vi === 0) {
  mkdirSync(outdir, { recursive: true });
  writeFileSync(join(outdir, 'rig.json'), rigJsonText(rig));
  writeFileSync(join(outdir, 'rig.csv'), rigToCsv(rig));
  writeFileSync(join(outdir, 'rig_white.stl'), Buffer.from(meshToStl(mesh.white, 'rig_white')));
  writeFileSync(join(outdir, 'rig_black.stl'), Buffer.from(meshToStl(mesh.black, 'rig_black')));
  console.log(`     wrote rig.json, rig.csv, rig_white.stl, rig_black.stl to ${outdir}`);
}
}

// ---- impossible layouts are refused with a reason, not drawn overlapping -------------
for (const bad of [{ tagsPerPlane: 9, tagSizeMm: 35 }, { inlayDepthMm: 6 }, { baseId: 1020 }]) {
  let msg = null;
  try { buildRig(bad); } catch (e) { msg = e.message; }
  check(msg !== null, `refused ${JSON.stringify(bad)}: ${msg}`);
}
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
