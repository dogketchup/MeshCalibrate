// node tests/make_calibrate_script.mjs DIR [DIR...]
// Writes DIR/calibrate.py and DIR/stereo_calibrate.py from DIR/rig.json exactly as the page's
// "calibrate.py" and "stereo_calibrate.py" buttons do.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrateScript, stereoScript } from '../src/rig/calibrateScript.js';

const here = dirname(fileURLToPath(import.meta.url));
const calT = readFileSync(join(here, '../src/rig/calibrate.py'), 'utf8');
const stereoT = readFileSync(join(here, '../src/rig/stereo_calibrate.py'), 'utf8');
for (const dir of process.argv.slice(2)) {
  const rig = readFileSync(join(dir, 'rig.json'), 'utf8');
  writeFileSync(join(dir, 'calibrate.py'), calibrateScript(calT, rig));
  writeFileSync(join(dir, 'stereo_calibrate.py'), stereoScript(calT, stereoT, rig));
  console.log(`wrote ${dir}/calibrate.py and stereo_calibrate.py`);
}
