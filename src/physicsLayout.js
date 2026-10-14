// Force-directed / Coulomb-repulsion layout solver.
//
// Pseudocode of record: documentation/todo/implement-physics-maximal-spacing.md
//
// The pseudocode's hyperparameters (kRepulsion = 1.0, kWall = 1.0,
// `IF forceMag > 1.0: normalize`) are tuned for a UNIT-square domain
// (distances of order 1). We therefore simulate in normalized [0, 1]²
// coordinates so the constants behave identically for any canvasSize,
// and convert back to canvas pixels only in the returned points.
//
// Determinism: point positions are seeded from a per-markerId hash + N,
// so the same (N, tagSize, L) always produces the same layout — no
// jitter when unrelated UI state changes.

/**
 * FNV-1a hash of a numeric id — small, stable, good enough for seeding.
 * @param {number} n
 * @returns {number} 32-bit unsigned integer
 */
function hash(n) {
  let h = 0x811c9dc5 ^ (n >>> 0);
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ ((n >>> (8 * i)) & 0xff), 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic 32-bit PRNG (mulberry32).
 * @param {number} seed
 * @returns {() => number} uniform float in [0, 1)
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t >>> 0) & 0xffffffff) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Core solver — mirrors the pseudocode step-for-step.
 * All coordinates are in the unit square [0, 1]².
 *
 * @param {number} N number of points
 * @param {number} tagUnit fraction of one side the tag occupies (tagSize / L)
 * @param {number} iterations max simulation iterations
 * @param {() => number} rng deterministic source of initial positions
 * @returns {{x: number, y: number}[]} unit-square points (centers)
 */
function optimizePhysicsUnit(N, tagUnit, iterations, rng) {
  const L = 1.0;
  const halfW = tagUnit / 2;
  const minBound = halfW;
  const maxBound = L - halfW;

  // 1. Initialization: seed N points randomly within the allowed boundary
  const points = new Array(N);
  for (let i = 0; i < N; i++) {
    points[i] = {
      x: minBound + rng() * (maxBound - minBound),
      y: minBound + rng() * (maxBound - minBound),
    };
  }

  // Hyperparameters (unit-scale, per the pseudocode)
  const kRepulsion = 1.0; // Pairwise Coulomb force constant
  const kWall = 1.0; // Wall repulsion constant
  const initialStep = L * 0.1; // Maximum displacement per step
  const epsilon = 1e-4; // Safeguard against division by zero

  // 2. Main simulation loop (iterative force relaxation)
  for (let iter = 0; iter < iterations; iter++) {
    // Annealing schedule: step size decreases as the simulation cools
    const temperature = 1.0 - iter / iterations;
    const currentStep = initialStep * temperature;

    // Net force per point
    const fx = new Float64Array(N);
    const fy = new Float64Array(N);

    // --- STEP A: Inter-particle repulsion, O(N^2) ---
    for (let i = 0; i < N; i++) {
      const pi = points[i];
      for (let j = i + 1; j < N; j++) {
        const pj = points[j];
        const dx = pi.x - pj.x;
        const dy = pi.y - pj.y;

        const distSq = dx * dx + dy * dy + epsilon;
        const dist = Math.sqrt(distSq);

        // Inverse-square magnitude (F = k / d²) along (dx, dy)/d
        const f = kRepulsion / distSq / dist;
        const fxi = dx * f;
        const fyi = dy * f;

        // Newton's third law
        fx[i] += fxi;
        fy[i] += fyi;
        fx[j] -= fxi;
        fy[j] -= fyi;
      }
    }

    // --- STEP B: Boundary wall repulsion, O(N) ---
    for (let i = 0; i < N; i++) {
      const p = points[i];
      const dLeft = Math.max(0.001, p.x - minBound);
      const dRight = Math.max(0.001, maxBound - p.x);
      const dBottom = Math.max(0.001, p.y - minBound);
      const dTop = Math.max(0.001, maxBound - p.y);

      fx[i] += kWall / (dLeft * dLeft);
      fx[i] -= kWall / (dRight * dRight);
      fy[i] += kWall / (dBottom * dBottom);
      fy[i] -= kWall / (dTop * dTop);
    }

    // --- STEP C: Integration with displacement normalization ---
    let maxDisplacement = 0;
    for (let i = 0; i < N; i++) {
      const forceMag = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i]) + epsilon;
      if (forceMag > 1.0) {
        fx[i] /= forceMag;
        fy[i] /= forceMag;
      }

      const dx = fx[i] * currentStep;
      const dy = fy[i] * currentStep;
      points[i].x = clamp(points[i].x + dx, minBound, maxBound);
      points[i].y = clamp(points[i].y + dy, minBound, maxBound);

      maxDisplacement = Math.max(
        maxDisplacement,
        Math.sqrt(dx * dx + dy * dy)
      );
    }

    // --- STEP D: Convergence check ---
    if (maxDisplacement < epsilon) break;
  }

  return points;
}

/**
 * Maximize spacing between tags with a Coulomb-repulsion layout.
 *
 * Runs a deterministic force-relaxation simulation: each pair of tags
 * repels with F = k / d², and each tag is pushed away from the canvas
 * boundary (so a tag can never sit half-off the edge). Step size
 * anneals linearly to zero over `iterations`; early exit when the
 * maximum point displacement drops below the epsilon threshold.
 *
 * Coordinates returned are canvas-pixel (y-down), matching the
 * canvas-based tag layout in threejsscene.js.
 *
 * NOTE: if `tagSize` is too large to fit N non-overlapping tags in an
 * L×L canvas, the physics cannot produce a perfect solution — the
 * caller is responsible for choosing a tagSize that satisfies
 * `tagSize ≤ L * 1 / sqrt(N)` (see documentation/arCuoTag.puml).
 *
 * @param {number} N number of tags
 * @param {number} canvasSize square canvas side length (pixels); the
 *   usable region is canvasSize² (centered square)
 * @param {number} tagWidth tag side length (pixels); a tag must fit
 *   entirely within the canvas, so points stay ≥ tagWidth/2 from each edge
 * @param {number} [iterations=300] max simulation iterations
 * @param {number} [seed] deterministic seed (default derived from N)
 * @returns {{x: number, y: number}[]} N points, canvas-pixel coordinates
 */
export function optimizePhysics(N, canvasSize, tagWidth, iterations = 300, seed) {
  if (!Number.isInteger(N) || N <= 0) {
    throw new Error(`optimizePhysics: N must be a positive integer, got ${N}`);
  }
  const L = Math.max(1, Math.round(canvasSize));
  const w = Math.max(1, Math.round(tagWidth));
  if (w > L) {
    throw new Error(`optimizePhysics: tagWidth ${w}px > canvas ${L}px`);
  }
  const iters = Number.isInteger(iterations) && iterations > 0 ? iterations : 300;
  const rng = mulberry32(seed === undefined ? (hash(N) ^ 0x9e3779b9) >>> 0 : seed >>> 0);

  // Oversized case: tags cannot physically fit without overlap.
  // Fall back to a deterministic uniform grid (best-case minimal spacing).
  const cols = Math.ceil(Math.sqrt(N));
  const rows = Math.ceil(N / cols);
  const cellX = L / cols;
  const cellY = L / rows;
  const points = new Array(N);
  for (let i = 0; i < N; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    points[i] = {
      x: (col + 0.5) * cellX,
      y: (row + 0.5) * cellY,
    };
  }
  if (w * Math.sqrt(N) > L * 2) {
    // Clamp into the canvas so tags at least stay on-screen.
    for (const p of points) {
      p.x = clamp(p.x, w / 2, L - w / 2);
      p.y = clamp(p.y, w / 2, L - w / 2);
    }
    return points;
  }

  const unitPoints = optimizePhysicsUnit(N, w / L, iters, rng);
  return unitPoints.map((p) => ({ x: p.x * L, y: p.y * L }));
}
