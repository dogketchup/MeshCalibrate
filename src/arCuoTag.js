import { arucoToSVGString } from 'aruco-marker';
import { optimizePhysics } from './physicsLayout.js'; // Adjust path if needed

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
const markerImg = new Image(); // offscreen raster of current marker SVG

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

// --- Marker raster: (re)load SVG at target drawing pixel size -------------
function loadMarker(id, px) {
  markerImg.onload = null; // reset handler to prevent duplicate triggers
  markerImg.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(arucoToSVGString(id, px));
}

// --- Canvas Draw Function --------------------------------------------------
function draw() {
  if (!ctx || !canvas) return;

  // 1. Clear canvas background
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 2. Validate tag count & loaded marker image
  const N = countTags;
  if (!Number.isInteger(N) || N <= 0) return;
  if (!markerImg || markerImg.naturalWidth === 0) return;

  // 3. Compute tag pixel size and optimal physics layout
  const size = markerPixelSize();
  const points = optimizePhysics(N, canvas.width, size);

  // 4. Draw markers at computed center points
  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    // Convert center coordinates (p.x, p.y) to top-left canvas origins
    const drawX = p.x - size / 2;
    const drawY = p.y - size / 2;

    ctx.drawImage(
      markerImg,
      0, 0, markerImg.naturalWidth, markerImg.naturalHeight,
      drawX, drawY, size, size
    );
  }
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

  sizeCanvas(); // Resizing canvas clears previous drawing
  loadMarker(markerId, markerPixelSize());

  markerImg.onload = () => {
    if (gen !== refreshGen) return; // Superseded by a newer slider tick
    img.src = markerImg.src;
    draw();
    changed();
  };
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
