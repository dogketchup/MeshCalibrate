import './style.css';
import { buildRig, rigJsonText, rigToCsv, DEFAULTS, MODES } from './rig/rigModel.js';
import { calibrateScript, stereoScript } from './rig/calibrateScript.js';
import calibrateTemplate from './rig/calibrate.py?raw';
import stereoTemplate from './rig/stereo_calibrate.py?raw';
import { buildRigMesh, meshToStl } from './rig/rigMesh.js';
import { DICTIONARY } from './rig/arucoBits.js';
import { createRigScene } from './threejsscene.js';

const FIELDS = [
  { key: 'faceMm', label: 'face size (mm)', plane: 'plate size (mm)', step: 0.5, min: 20, max: 400 },
  { key: 'tagSizeMm', label: 'marker size (mm)', step: 0.5, min: 7, max: 400 },
  { key: 'tagsPerPlane', label: 'markers per face', plane: 'markers on the plate', step: 1, min: 1, max: 64 },
  { key: 'baseId', label: 'first marker id', step: 1, min: 0, max: 1023 },
  { key: 'thicknessMm', label: 'plate thickness (mm)', step: 0.1, min: 1, max: 50 },
  { key: 'inlayDepthMm', label: 'inlay depth (mm)', step: 0.1, min: 0.2, max: 10 },
];

document.querySelector('#app').innerHTML = `
<aside id="panel">
  <h1>MeshCalibrate</h1>
  <nav id="links"><a id="simlink" href="/simulate" title="render this rig through a known camera and calibrate it with OpenCV">simulate calibration</a>
    <a href="/tutorial">tutorial</a></nav>
  <div id="mode" role="group" aria-label="what to make">
    ${Object.entries(MODES).map(([k, m]) => `<button type="button" data-mode="${k}" aria-pressed="${k === DEFAULTS.mode}">${m.label}</button>`).join('')}
  </div>
  <p class="note" data-for="rig">A three-face ArUco corner rig (floor + two walls). All three faces
  meet at one origin and every marker id is unique, so one camera image of the rig gives one pose.
  Prints floor-down with no supports: the black cells are inlays in the white body.</p>
  <p class="note" data-for="plane">One flat ArUco plate. The origin is the corner of its marker
  face. It prints marker-face up with no supports: the black cells are inlays in the white body.</p>
  <div id="fields">
    ${FIELDS.map((f) => `<label><span data-label="${f.key}">${f.label}</span><input type="number" id="f_${f.key}" value="${DEFAULTS[f.key]}" step="${f.step}" min="${f.min}" max="${f.max}"></label>`).join('')}
    <label>layout<select id="f_layout"><option value="grid">grid</option><option value="physics">physics</option></select></label>
  </div>
  <div id="error"></div>
  <div id="summary"></div>
  <div id="faces"></div>
  <h2>Export</h2>
  <div id="exports">
    <button id="x_3mf" title="one object, two parts: white body + black inlay (filament 1 / 2)">3MF (print)</button>
    <button id="x_stl_white">STL white</button>
    <button id="x_stl_black">STL black</button>
    <button id="x_json" title="every marker's 3D corners in the rig frame - what calibration reads">rig.json</button>
    <button id="x_csv" title="tag centres only, the old calibration_rig_config.csv columns">CSV</button>
    <button id="x_glb" title="for viewers; glTF is Y-up">GLB</button>
    <button id="x_py" title="a standalone Python camera calibration script with this rig built in: python calibrate.py photos/*.jpg">calibrate.py</button>
    <button id="x_stereo" title="calibrate a stereo camera pair with this rig: R, T, essential E, fundamental F, epipolar check, rectification">stereo_calibrate.py</button>
  </div>
</aside>
<main id="view"></main>
`;

const view = createRigScene(document.getElementById('view'));
let current = null; // { rig, meshes }
let mode = DEFAULTS.mode;

function readParams() {
  const p = { mode };
  for (const f of FIELDS) p[f.key] = Number(document.getElementById(`f_${f.key}`).value);
  p.layout = document.getElementById('f_layout').value;
  return p;
}

// The mode decides the whole page: which note and labels show, what the
// preview draws and what every export contains.
function setMode(next) {
  mode = next;
  document.body.dataset.mode = mode;
  document.querySelectorAll('#mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  for (const f of FIELDS) document.querySelector(`[data-label="${f.key}"]`).textContent = (mode === 'plane' && f.plane) || f.label;
  document.getElementById('x_3mf').title = `one object, two parts: white body + black inlay (filament 1 / 2) - ${MODES[mode].label}`;
  schedule();
}

function drawFace(canvas, rig, planeName) {
  const S = rig.params.faceMm;
  const px = canvas.width / S;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const plane = rig.planes.find((p) => p.name === planeName);
  // face coordinates of a 3D point: (u, v) from the face's top-left as printed
  const tl = { floor: [0, S, 0], wall_xz: [S, 0, S], wall_yz: [0, 0, S] }[planeName];
  const uv = (p) => {
    const d = [p[0] - tl[0], p[1] - tl[1], p[2] - tl[2]];
    return [d[0] * plane.u[0] + d[1] * plane.u[1] + d[2] * plane.u[2], d[0] * plane.v[0] + d[1] * plane.v[1] + d[2] * plane.v[2]];
  };
  ctx.fillStyle = '#000';
  ctx.font = `${Math.max(9, Math.round(canvas.width / 18))}px monospace`;
  for (const t of rig.tags.filter((x) => x.plane === planeName)) {
    const [a, b] = uv(t.corners[0]); // TL corner
    const cell = t.sizeMm / 7;
    t.cells.forEach((row, r) => row.forEach((isBlack, c) => {
      if (isBlack) ctx.fillRect((a + c * cell) * px, (b + r * cell) * px, Math.ceil(cell * px), Math.ceil(cell * px));
    }));
    ctx.fillStyle = '#c00';
    ctx.fillText(String(t.id), a * px, (b - 0.6) * px);
    ctx.fillStyle = '#000';
  }
}

function rebuild() {
  const err = document.getElementById('error');
  let rig, meshes;
  try {
    rig = buildRig(readParams());
    meshes = buildRigMesh(rig);
  } catch (e) {
    err.textContent = e.message;
    document.querySelectorAll('#exports button').forEach((b) => (b.disabled = true));
    return;
  }
  err.textContent = '';
  document.querySelectorAll('#exports button').forEach((b) => (b.disabled = false));
  current = { rig, meshes };
  const sp = rig.params;  // the simulation uses exactly this rig
  document.getElementById('simlink').href = '/simulate?' + new URLSearchParams({ mode: sp.mode, faceMm: sp.faceMm,
    tagSizeMm: sp.tagSizeMm, tagsPerPlane: sp.tagsPerPlane, baseId: sp.baseId, thicknessMm: sp.thicknessMm,
    inlayDepthMm: sp.inlayDepthMm, layout: sp.layout });
  view.setRig(meshes, rig.params);

  const p = rig.params;
  const ids = (name) => rig.tags.filter((t) => t.plane === name).map((t) => t.id);
  const tris = (m) => m.indices.length / 3;
  const W = p.faceMm + p.thicknessMm;
  const faceRows = p.mode === 'plane'
    ? `<tr><td>plate (z=0)</td><td>${ids('floor').join(' ')}</td></tr>`
    : `<tr><td>floor (z=0)</td><td>${ids('floor').join(' ')}</td></tr>
       <tr><td>wall_xz (y=0)</td><td>${ids('wall_xz').join(' ')}</td></tr>
       <tr><td>wall_yz (x=0)</td><td>${ids('wall_yz').join(' ')}</td></tr>`;
  document.getElementById('summary').innerHTML = `
    <table>
      <tr><td>making</td><td><b>${MODES[p.mode].label}</b></td></tr>
      <tr><td>dictionary</td><td>${DICTIONARY}</td></tr>
      <tr><td>cell</td><td>${(p.tagSizeMm / 7).toFixed(3)} mm (white quiet zone &ge; 1 cell)</td></tr>
      ${faceRows}
      <tr><td>footprint</td><td>${p.mode === 'plane' ? `${p.faceMm} x ${p.faceMm} x ${p.thicknessMm}` : `${W} x ${W} x ${W}`} mm</td></tr>
      <tr><td>triangles</td><td>white ${tris(meshes.white)}, black ${tris(meshes.black)}</td></tr>
    </table>`;
  const faces = document.getElementById('faces');
  const caption = (name) => (p.mode === 'plane' ? 'plate as printed' : `${name} as printed`);
  faces.innerHTML = rig.planes.map((pl) => `<figure><canvas id="c_${pl.name}" width="180" height="180"></canvas><figcaption>${caption(pl.name)}</figcaption></figure>`).join('');
  for (const pl of rig.planes) drawFace(document.getElementById(`c_${pl.name}`), rig, pl.name);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// file names say which mode made them: corner_rig_40-51.3mf vs plate_40-43.3mf
const base = () => `${current.rig.params.mode === 'plane' ? 'plate' : 'corner_rig'}_${current.rig.params.baseId}-${current.rig.tags[current.rig.tags.length - 1].id}`;
document.getElementById('x_3mf').addEventListener('click', async () => download(await view.export3MF(), `${base()}.3mf`));
document.getElementById('x_stl_white').addEventListener('click', () => download(new Blob([meshToStl(current.meshes.white, 'rig_white')], { type: 'model/stl' }), `${base()}_white.stl`));
document.getElementById('x_stl_black').addEventListener('click', () => download(new Blob([meshToStl(current.meshes.black, 'rig_black')], { type: 'model/stl' }), `${base()}_black.stl`));
document.getElementById('x_json').addEventListener('click', () => download(new Blob([rigJsonText(current.rig)], { type: 'application/json' }), 'rig.json'));
document.getElementById('x_csv').addEventListener('click', () => download(new Blob([rigToCsv(current.rig)], { type: 'text/csv' }), 'calibration_rig_config.csv'));
document.getElementById('x_glb').addEventListener('click', async () => download(await view.exportGLB(), `${base()}.glb`));
document.getElementById('x_stereo').addEventListener('click', () => download(new Blob([stereoScript(calibrateTemplate, stereoTemplate, rigJsonText(current.rig))], { type: 'text/x-python' }), 'stereo_calibrate.py'));
document.getElementById('x_py').addEventListener('click', () => download(new Blob([calibrateScript(calibrateTemplate, rigJsonText(current.rig))], { type: 'text/x-python' }), 'calibrate.py'));

let pending = 0;
const schedule = () => {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(rebuild);
};
document.querySelectorAll('#fields input, #fields select').forEach((el) => el.addEventListener('input', schedule));
document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
// ?mode=plane opens straight into one-plane mode (default: the 3D rig)
const asked = new URLSearchParams(location.search).get('mode');
setMode(asked in MODES ? asked : DEFAULTS.mode);
