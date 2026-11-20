// The downloadable calibration scripts, built from the Python templates in this folder:
//   calibrate.py         one camera; this rig's rig.json embedded
//   stereo_calibrate.py  a stereo pair; calibrate.py's library part (with the rig) pasted in
// so each download is one self-contained file. DOM-free so node tests build exactly what the page does.
export const RIG_MARKER = 'RIG_JSON = None  # @@RIG_JSON@@';
export const LIB_MARKER = '# @@CALIBRATE_LIB@@';
const LIB_BEGIN = '# ==== begin library';
const LIB_END = '# ==== end library ====';

export function calibrateScript(template, rigJsonText) {
  if (!template.includes(RIG_MARKER)) throw new Error('calibrate.py template: rig marker not found');
  if (rigJsonText.includes("'''") || rigJsonText.includes('\\')) throw new Error('rig.json cannot be embedded verbatim');
  JSON.parse(rigJsonText); // refuse to embed anything that is not valid JSON
  const embedded = "RIG_JSON = r'''\n" + rigJsonText.trimEnd() + "\n'''  # embedded by MeshCalibrate";
  return template.replace(RIG_MARKER, () => embedded);
}

export function stereoScript(calibrateTemplate, stereoTemplate, rigJsonText) {
  const cal = calibrateScript(calibrateTemplate, rigJsonText);
  const a = cal.indexOf(LIB_BEGIN);
  const b = cal.indexOf(LIB_END);
  if (a < 0 || b < a) throw new Error('calibrate.py template: library markers not found');
  if (!stereoTemplate.includes(LIB_MARKER)) throw new Error('stereo_calibrate.py template: library marker not found');
  const lib = cal.slice(a, b + LIB_END.length);
  return stereoTemplate.replace(LIB_MARKER, () => lib);
}
