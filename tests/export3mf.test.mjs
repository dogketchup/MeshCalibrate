// node tests/export3mf.test.mjs [outdir]
// Exports the default 3D rig and the default one-plane plate through the same three.js Group + three-3mf-exporter
// path the page uses, then opens the 3MF and checks its structure: one build
// item, one object made of two mesh parts, each part on its own filament.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { exportTo3MF } from 'three-3mf-exporter';
import { buildRig } from '../src/rig/rigModel.js';
import { buildRigMesh, meshVolume } from '../src/rig/rigMesh.js';
import { makeRigGroup } from '../src/rig/rigGroup.js';

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };

const outdir = process.argv[2];
for (const mode of ['rig', 'plane']) {
console.log(`--- mode ${mode}`);
const rig = buildRig({ mode });
const meshes = buildRigMesh(rig);
const { group, setMeshes } = makeRigGroup();
setMeshes(meshes);
const blob = await exportTo3MF(group);
const bytes = Buffer.from(await blob.arrayBuffer());
const zip = await JSZip.loadAsync(bytes);
const model = await zip.file('3D/3dmodel.model').async('string');
const settings = await zip.file('Metadata/model_settings.config').async('string');
const project = JSON.parse(await zip.file('Metadata/project_settings.config').async('string'));

const items = [...model.matchAll(/<item objectid="(\d+)"/g)].map((m) => m[1]);
check(items.length === 1, `one build item (got ${items.length})`);
const assembly = model.match(new RegExp(`<object id="${items[0]}"[^>]*><components>(.*?)</components>`));
const parts = assembly ? [...assembly[1].matchAll(/objectid="(\d+)"/g)].map((m) => m[1]) : [];
check(parts.length === 2, `the build item is one object with two component parts (got ${parts.length})`);
const names = parts.map((id) => (model.match(new RegExp(`<object id="${id}" type="model" name="([^"]+)"><mesh>`)) || [])[1]);
check(names.join(',') === 'rig_white,rig_black', `parts are rig_white, rig_black (got ${names.join(',')})`);
const extruders = [...settings.matchAll(/<part id="(\d+)"[^>]*>\s*<metadata key="name" value="([^"]+)"\/>\s*<metadata key="extruder" value="(\d+)"/g)].map((m) => `${m[2]}=${m[3]}`);
check(extruders.join(',') === 'rig_white=1,rig_black=2', `Bambu part extruders: ${extruders.join(', ')}`);
check(JSON.stringify(project.filament_colour) === '["#ffffff","#000000"]', `filament colours ${JSON.stringify(project.filament_colour)}`);
check(project.enable_support === '0', 'supports off in the project settings');

if (outdir) {
  const dir = join(outdir, mode === 'plane' ? 'plane' : '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rig.3mf'), bytes);
  writeFileSync(join(dir, 'expected_volumes.json'), JSON.stringify({ rig_white: meshVolume(meshes.white), rig_black: meshVolume(meshes.black) }));
  console.log(`     wrote rig.3mf (${bytes.length} bytes) to ${dir}`);
}
}
console.log(failed ? `${failed} check(s) FAILED` : 'all 3MF checks passed');
process.exit(failed ? 1 : 0);
