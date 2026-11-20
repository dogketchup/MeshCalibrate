// The calibration target, in one of two modes. DOM-free (runs under node).
//
//   'rig'   - the corner rig: three faces (floor + two walls) that meet at ONE
//             origin, with every marker id unique across the whole rig.
//   'plane' - one flat plate: just the floor face, same markers and inlays.
//
// Rig frame, millimetres:
//   origin = the inner corner where the floor's top face (z = 0), the wall face
//   y = 0 and the wall face x = 0 meet. +x and +y run along the floor, +z is up.
//   Each face's usable area is [0, S] x [0, S].
//
// Solid (prints floor-down, walls vertical, nothing overhangs):
//   floor    x in [-T, S], y in [-T, S], z in [-T, 0]
//   wall_xz  x in [-T, S], y in [-T, 0], z in [0, S]
//   wall_yz  x in [-T, 0], y in [0, S],  z in [0, S]
// In 'plane' mode the solid is the plate alone, x, y in [0, S], z in [-T, 0]:
// origin at the corner of its top (marker) face, the same frame as the rig's floor.
//
// Marker axes per face: u = the marker's "right", v = its "down", as seen when
// looking at the printed face (u x v = -normal, the same handedness as an
// OpenCV image whose camera looks at the face).
import { optimizePhysics } from '../physicsLayout.js';
import { DICTIONARY, MAX_ID, MARKER_CELLS, markerCells } from './arucoBits.js';

export const FORMAT = 'meshcalibrate-rig/1';

export const PLANES = [
  { name: 'floor',   normal: [0, 0, 1], u: [1, 0, 0],  v: [0, -1, 0] },
  { name: 'wall_xz', normal: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, -1] },
  { name: 'wall_yz', normal: [1, 0, 0], u: [0, 1, 0],  v: [0, 0, -1] },
];

export const MODES = {
  rig: { label: '3D rig', planes: PLANES, name: 'meshcalibrate corner rig',
         frame: 'origin = inner corner where the floor top face (z=0) and the wall faces y=0 and x=0 meet; +x,+y along the floor, +z up; faces span [0,S] on each axis' },
  plane: { label: 'one plane', planes: PLANES.slice(0, 1), name: 'meshcalibrate single plate',
           frame: 'origin = corner of the plate top face (z=0, the marker face); +x,+y along the plate, +z up out of the markers; the face spans [0,S] x [0,S]' },
};

/** The faces a mode prints: all three for 'rig', the floor alone for 'plane'. */
export const planesFor = (mode) => MODES[mode].planes;

export const DEFAULTS = {
  faceMm: 100,        // S: side of each square face
  thicknessMm: 5,     // T: plate thickness
  inlayDepthMm: 1.0,  // D: how deep the black cells go into the face
  tagSizeMm: 35,      // outer black square of each marker
  tagsPerPlane: 4,
  baseId: 40,         // floor gets baseId.., wall_xz the next block, wall_yz the next
  layout: 'grid',     // 'grid' | 'physics'
  mode: 'rig',        // 'rig' (floor + two walls) | 'plane' (the floor plate alone)
};

// The 3D point that sits at the face's top-left corner as seen from the front,
// i.e. where (u, v) = (0, 0) in face coordinates.
function faceTopLeft(name, S) {
  switch (name) {
    case 'floor':   return [0, S, 0];
    case 'wall_xz': return [S, 0, S];
    case 'wall_yz': return [0, 0, S];
    default: throw new Error(`unknown plane ${name}`);
  }
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const round = (x, d = 6) => {
  const k = 10 ** d;
  const r = Math.round(x * k) / k;
  return Object.is(r, -0) ? 0 : r;
};
const roundVec = (a, d) => a.map((x) => round(x, d));

function checkParams(p) {
  const errors = [];
  const num = (k, lo, hi) => {
    if (!Number.isFinite(p[k]) || p[k] < lo || p[k] > hi) errors.push(`${k} must be in [${lo}, ${hi}], got ${p[k]}`);
  };
  num('faceMm', 20, 400);
  num('thicknessMm', 1, 50);
  num('inlayDepthMm', 0.2, 10);
  num('tagSizeMm', 7, 400);
  if (!Number.isInteger(p.tagsPerPlane) || p.tagsPerPlane < 1 || p.tagsPerPlane > 64) {
    errors.push(`tagsPerPlane must be an integer 1..64, got ${p.tagsPerPlane}`);
  }
  if (!Number.isInteger(p.baseId) || p.baseId < 0) errors.push(`baseId must be an integer >= 0, got ${p.baseId}`);
  if (p.inlayDepthMm >= p.thicknessMm) errors.push('inlayDepthMm must be less than thicknessMm');
  if (p.layout !== 'grid' && p.layout !== 'physics') errors.push(`layout must be 'grid' or 'physics', got ${p.layout}`);
  if (!(p.mode in MODES)) errors.push(`mode must be 'rig' or 'plane', got ${p.mode}`);
  const last = p.baseId + (p.mode in MODES ? planesFor(p.mode).length : 1) * p.tagsPerPlane - 1;
  if (last > MAX_ID) errors.push(`ids ${p.baseId}..${last} run past ${MAX_ID}, the last id in ${DICTIONARY}`);
  if (errors.length) throw new Error(errors.join('; '));
}

/**
 * Tag centres on one face in face coordinates (a along u, b along v, mm, the
 * face's top-left at (0, 0)), in reading order as printed (left to right, top
 * to bottom), so ids count up the way you read the face.
 *
 * 'grid' (default): rows of ceil(sqrt(N)) markers, each row spread evenly over
 * the face. 'physics': the repo's Coulomb-repulsion layout (physicsLayout.js).
 * Either way every marker must keep one cell of white quiet zone to the face
 * edge and to its neighbours, or OpenCV will not find it - checked below.
 */
function layoutFace(p, cell) {
  const S = p.faceMm, s = p.tagSizeMm, N = p.tagsPerPlane;
  let pts;
  if (p.layout === 'physics') {
    const k = 100; // solve in 0.01 mm units: optimizePhysics rounds its inputs to integers
    pts = optimizePhysics(N, S * k, s * k, 0).map((q) => [round(q.x / k, 2), round(q.y / k, 2)]);
    pts.sort((A, B) => (Math.abs(A[1] - B[1]) > s / 2 ? A[1] - B[1] : A[0] - B[0]));
  } else {
    const cols = Math.ceil(Math.sqrt(N)), rows = Math.ceil(N / cols);
    pts = [];
    for (let r = 0; r < rows; r++) {
      const count = Math.min(cols, N - r * cols);
      for (let c = 0; c < count; c++) pts.push([round((S * (2 * c + 1)) / (2 * count), 4), round((S * (2 * r + 1)) / (2 * rows), 4)]);
    }
  }
  const lo = s / 2 + cell - 1e-9, hi = S - s / 2 - cell + 1e-9;
  for (const [a, b] of pts) {
    if (a < lo || a > hi || b < lo || b > hi) {
      throw new Error(`${N} markers of ${s} mm do not fit on a ${S} mm face with a one-cell (${round(cell, 3)} mm) white border - use fewer or smaller markers, or a bigger face`);
    }
  }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const gap = Math.max(Math.abs(pts[i][0] - pts[j][0]), Math.abs(pts[i][1] - pts[j][1])) - s;
      if (gap < cell - 1e-9) {
        throw new Error(`markers ${i} and ${j} on a face are only ${round(gap, 2)} mm apart; they need at least one cell (${round(cell, 3)} mm) of white between them - use fewer or smaller markers, or a bigger face`);
      }
    }
  }
  return pts;
}

/** Build the rig description: every marker with its id, plane, centre, corners and cells. */
export function buildRig(params = {}) {
  const p = { ...DEFAULTS, ...params };
  for (const k of ['faceMm', 'thicknessMm', 'inlayDepthMm', 'tagSizeMm']) p[k] = Number(p[k]);
  p.tagsPerPlane = Number(p.tagsPerPlane);
  p.baseId = Number(p.baseId);
  checkParams(p);

  const S = p.faceMm, s = p.tagSizeMm, h = s / 2;
  const cell = s / MARKER_CELLS;
  const face = layoutFace(p, cell);
  const tags = [];
  const planes = planesFor(p.mode);
  planes.forEach((plane, pi) => {
    const tl = faceTopLeft(plane.name, S);
    face.forEach(([a, b], i) => {
      const id = p.baseId + pi * p.tagsPerPlane + i;
      const center = add(tl, add(scale(plane.u, a), scale(plane.v, b)));
      const at = (du, dv) => add(center, add(scale(plane.u, du), scale(plane.v, dv)));
      tags.push({
        id,
        plane: plane.name,
        sizeMm: s,
        center: roundVec(center, 6),
        // OpenCV ArUco corner order: top-left, top-right, bottom-right, bottom-left as printed
        corners: [at(-h, -h), at(h, -h), at(h, h), at(-h, h)].map((c) => roundVec(c, 6)),
        cells: markerCells(id),
      });
    });
  });
  return { params: p, cellMm: cell, planes, tags };
}

/** rig.json - the file YamCamCtl and calibrate.py read. */
export function rigToJson(rig, name) {
  const p = rig.params;
  return {
    format: FORMAT,
    name: name || MODES[p.mode].name,
    units: 'mm',
    dictionary: DICTIONARY,
    frame: MODES[p.mode].frame,
    corner_order: 'opencv: TL,TR,BR,BL as printed',
    planes: rig.planes.map((pl) => ({ name: pl.name, normal: pl.normal, u: pl.u, v: pl.v })),
    tags: rig.tags.map((t) => ({
      id: t.id,
      plane: t.plane,
      size_mm: t.sizeMm,
      center: t.center,
      corners: t.corners,
    })),
    print: { mode: p.mode, face_mm: p.faceMm, thickness_mm: p.thicknessMm, inlay_depth_mm: p.inlayDepthMm, layout: p.layout },
  };
}

/** rig.json as text: two-space indent, but number arrays (vectors) kept on one line. */
export function rigJsonText(rig, name) {
  return JSON.stringify(rigToJson(rig, name), null, 2)
    .replace(/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g, (_, inner) => `[${inner.replace(/,\s+/g, ', ')}]`)
    .replace(/\[\s+(\[[^\[\]]*\](?:,\s+\[[^\[\]]*\])*)\s+\]/g, (_, inner) => `[${inner.replace(/\],\s+\[/g, '], [')}]`) + '\n';
}

/** The legacy CSV columns of calibration_rig_config.csv (positions only, no orientation). */
export function rigToCsv(rig) {
  const lines = ['tag_id,center_x_mm,center_y_mm,center_z_mm,size_mm,plane_id'];
  for (const t of rig.tags) {
    lines.push([t.id, ...t.center.map((x) => round(x, 4)), t.sizeMm, t.plane].join(','));
  }
  return lines.join('\n') + '\n';
}
