// node tests/simulate.test.mjs - the /simulate backend end to end: render the rig, detect with
// opencv.js, calibrate, compare with the truth - single view and multi-view, 3D rig and one plane.
import { loadCv } from '../src/sim/cvLoader.js';
import { simulate } from '../src/sim/simulate.js';

const { cv, loadMs } = await loadCv();
console.log(`opencv.js loaded in ${loadMs} ms`);
let failures = 0;
// limits: what each case can honestly deliver (see TUTORIAL.md section 10)
const cases = [
  { rig: 'rig', views: 'single', fx: 1.0, pos: 3, all: true },
  { rig: 'rig', views: 'multi', fx: 0.5, pos: 1.0, pp: 4, k1: 0.01, all: true },
  { rig: 'plane', views: 'single', fx: 1.0, pos: 3, all: true },
  { rig: 'plane', views: 'multi', fx: 2.5, pos: 8, pp: 20, k1: 0.02, all: true },
];
for (const c of cases) {
  const r = simulate(cv, { rig: { mode: c.rig }, views: c.views, nViews: c.rig === 'plane' ? 10 : 8 });
  const k = r.comparison;
  const checks = [
    ['ran', r.ok],
    ['every visible marker detected', !c.all || k.detected.markers === k.detected.visible],
    [`fx within ${c.fx} %`, Math.abs(k.fx_error_pct) < c.fx],
    [`camera positions within ${c.pos} mm`, k.position_error_mm && k.position_error_mm.max < c.pos],
    ['reprojection < 0.5 px', r.calibration.rms_px < 0.5],
    ...(c.pp ? [[`principal point within ${c.pp} px`, k.principal_point_error_px < c.pp]] : []),
    ...(c.k1 ? [[`k1 within ${c.k1}`, Math.abs(k.k1.estimated - k.k1.true) < c.k1]] : []),
    ['images encoded', r.shots.every((s) => s.png && s.png.length > 1000)],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  failures += bad.length > 0;
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${c.rig} ${c.views}: fx ${k.fx_error_pct} %, pp ${k.principal_point_error_px} px, k1 ${k.k1.estimated}, `
    + `positions ${k.position_error_mm?.mean}/${k.position_error_mm?.max} mm, rms ${r.calibration.rms_px} px, `
    + `${k.detected.markers}/${k.detected.visible} markers, ${r.timing.total_ms} ms${bad.length ? '  <- ' + bad.join(', ') : ''}`);
}
console.log(failures ? `${failures} simulation case(s) FAILED` : 'all simulation checks passed');
process.exit(failures ? 1 : 0);
