import { arucoToSVGString } from 'aruco-marker';
import { optimizePhysics } from './physicsLayout.js'; // Adjust path if needed
import ArUcoTag, { tagArray } from "./aruCoSchema.js"

const range = document.getElementById('generate_tag_code');
const sliderX = document.getElementById('build_plate_x');
const sliderY = document.getElementById('build_plate_y');
const tagCount = document.getElementById('tag_count');
const img = document.querySelector('#aruco-marker');
const canvas = document.getElementById('plane_1_texture');
const ctx = canvas.getContext('2d');

let countTags = 4; // default marker count

function syncCountTags() {
  let n = Math.round(Number(tagCount.value));
  // Physics solver supports any count N >= 1 (odd or even)
  countTags = Math.max(1, isNaN(n) ? 1 : n);
}

const PPM = 40; // canvas pixels per 1cm of build plate

let markerId = Number(range.value);
const markerRasters = []; // one offscreen Image per tag (markerId + index)
let rasterLoadsTotal = 0;
let rasterLoadsPending = 0;

// Keep hidden texture canvas out of document layout
canvas.style.display = 'none';

// --- Canvas sizing (follows build-plate sliders) --------------------------
function sizeCanvas() {
  canvas.width = Math.max(1, Number(sliderX.value)) * PPM;
  canvas.height = Math.max(1, Number(sliderY.value)) * PPM;
}

function markerPixelSize() {
  const minDimension = Math.min(canvas.width, canvas.height);
  // Scale tag size proportionally to 1/sqrt(N) so tags fit neatly without crowding
  return Math.max(16, Math.round((minDimension * 0.7) / Math.sqrt(countTags)));
}

// --- Marker rasters: (re)load one SVG per tag at target pixel size -------
function loadAllMarkers(gen) {
  const px = markerPixelSize();
  markerRasters.length = 0;
  rasterLoadsTotal = countTags;
  rasterLoadsPending = countTags;

  for (let i = 0; i < countTags; i++) {
    const im = new Image();
    markerRasters[i] = im;
    im.onload = () => {
      if (gen !== refreshGen) return; // superseded by a newer slider tick
      rasterLoadsPending--;
      if (rasterLoadsPending === 0) onAllMarkersLoaded();
    };
    im.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(arucoToSVGString(markerId + i, px));
  }

  if (rasterLoadsTotal === 0) onAllMarkersLoaded(); // defensive: N >= 1 in practice
}

function onAllMarkersLoaded() {
  img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(arucoToSVGString(markerId, 250)); // preview shows base id
  draw();
  changed();
}


// --- Canvas Draw Function --------------------------------------------------
function draw() {
  if (!ctx || !canvas) return;

  // 1. Clear canvas background
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 2. Validate tag count (all per-tag rasters must be decoded before we get here)
  const N = countTags;
  if (!Number.isInteger(N) || N <= 0) return;

  // 3. Compute tag pixel size and optimal physics layout
  const size = markerPixelSize();
  const points = optimizePhysics(N, canvas.width, size);

  // 4. Draw each marker (id = markerId + i) and mirror it into tagArray for export
  for (let i = 0; i < points.length; i++) {
    const raster = markerRasters[i];
    if (!raster || raster.naturalWidth === 0) continue;
    const p = points[i];

    // Convert center coordinates (p.x, p.y) to top-left canvas origins
    const drawX = p.x - size / 2;
    const drawY = p.y - size / 2;

    ctx.drawImage(
      raster,
      0, 0, raster.naturalWidth, raster.naturalHeight,
      drawX, drawY, size, size
    );

    let tag = tagArray[i];
    if (!tag) {
      tag = new ArUcoTag(markerId + i);
      tagArray.push(tag);
    }
    tag.id = markerId + i; // each tag id increases by one
    tag.centroidX = p.x;
    tag.centroidY = p.y;
    tag.widthX = size;
    tag.heightY = size;
  }

  // Shrink tagArray if the tag-count slider was lowered since the last draw
  while (tagArray.length > N) tagArray.pop();
}

// --- Notify Three.js scene to re-upload canvas texture -------------------
function changed() {
  window.dispatchEvent(new CustomEvent('aruco:changed'));
}

// --- Refresh pipeline (debounced async update) ---------------------------
let refreshGen = 0;

function refresh() {
  markerId = Number(range.value);
  syncCountTags();
  const gen = ++refreshGen;

  sizeCanvas(); // Resizing canvas clears previous drawing; must precede markerPixelSize()
  loadAllMarkers(gen); // draw() fires only when all per-tag SVGs are decoded
}

// Coalesce rapid slider input ticks into single animation frames
let pendingFrame = 0;

function scheduleRefresh() {
  if (pendingFrame) cancelAnimationFrame(pendingFrame);
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    refresh();
  });
}

// --- Event Listeners ------------------------------------------------------
range.addEventListener('input', scheduleRefresh);
sliderX.addEventListener('input', scheduleRefresh);
sliderY.addEventListener('input', scheduleRefresh);
tagCount.addEventListener('input', scheduleRefresh);

// --- Initial Paint --------------------------------------------------------
refresh();
