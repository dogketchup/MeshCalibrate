// All length fields are in mm — same unit as the 3MF export (threejsscene
// scales the cm geometry ×10). Any pixel-space value (physicsLayout points,
// arCuoTag canvas coords) must be converted with pxToMm() before assignment.
class ArUcoTag {
  constructor(id) {
    this.id = id;
  }
  centroidX = 0; // mm
  centroidY = 0; // mm
  widthX = 0; // mm
  heightY = 0; // mm
}

// Canvas is fixed at 40 px/cm (arCuoTag PPM) → 1 px = 10 mm / 40 px = 0.25 mm.
const PX_TO_MM = 0.25;
function pxToMm(px) {
  return px * PX_TO_MM;
}

const tagArray = [];

const baseId = Number(document.getElementById("generate_tag_code").value);
const tagCountSlider = document.getElementById("tag_count");

// Same clamp as arCuoTag.js so canvas and exported counts always match:
// any count ≥ 1 (the physics layout handles odd counts; the old
// odd→even clamp was removed together with the 2-column grid).
function tagCountFor(n) {
  return Math.max(1, Math.floor(Number(n)));
}

function syncTagArray(count) {
  count = tagCountFor(count);
  while (tagArray.length < count) {
    tagArray.push(new ArUcoTag(baseId + tagArray.length));
  }
  while (tagArray.length > count) {
    tagArray.pop();
  }
}

function onChangeTagCount(event) {
  syncTagArray(Number(event.target.value));
  console.log(tagArray.length);
}

syncTagArray(Number(tagCountSlider.value));
tagCountSlider.addEventListener("input", onChangeTagCount);

function exportTags() {
  const payload = {
    baseId,
    units: "mm",
    count: tagArray.length,
    tags: tagArray.map((t) => ({
      id: t.id,
      centroidX: t.centroidX,
      centroidY: t.centroidY,
      widthX: t.widthX,
      heightY: t.heightY,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "aruco-tags.json";
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("export_tags").addEventListener("click", exportTags);

// CSV variant for spreadsheet tools. Plate dimensions are read from the
// cm sliders and converted to mm (×10) so every number in the file is mm.
function exportTagsCsv() {
  const plateXmm = Number(document.getElementById("build_plate_x").value) * 10;
  const plateYmm = Number(document.getElementById("build_plate_y").value) * 10;
  const lines = [
    `# plate, ${plateXmm} x ${plateYmm} mm (all values in mm)`,
    "id,centroidX,centroidY,widthX,heightY",
    ...tagArray.map(
      (t) =>
        `${t.id},${t.centroidX},${t.centroidY},${t.widthX},${t.heightY}`
    ),
  ];
  const blob = new Blob([lines.join("\n") + "\n"], {
    type: "text/csv",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "aruco-tags.csv";
  a.click();
  URL.revokeObjectURL(url);
}

document
  .getElementById("export_tags_csv")
  .addEventListener("click", exportTagsCsv);

export { tagArray, pxToMm };
export default ArUcoTag;
