// ArUco marker generator.
//
// Watches the #generate_tag_code slider (marker id) and the build-plate
// sliders (canvas size). Paints the selected marker into the hidden
// #plane_1_texture canvas and mirrors it into the visible #aruco-marker
// <img>. Every repaint dispatches an "aruco:changed" window event so
// threejsscene.js can re-upload the texture without the two modules
// importing each other.
//
// Rapid slider input is coalesced: at most one refresh per animation
// frame, and superseded async SVG loads are dropped. Without this, each
// slider tick during a drag would queue a full repaint + full GPU texture
// re-upload, which lags the machine.
import { arucoToSVGString } from 'aruco-marker';

const range = document.getElementById('generate_tag_code');
const sliderX = document.getElementById('build_plate_x');
const sliderY = document.getElementById('build_plate_y');
const img = document.querySelector('#aruco-marker');
const canvas = document.getElementById('plane_1_texture');
const ctx = canvas.getContext('2d');
var countTags = 4;

const PPM = 40; // canvas pixels per 1cm of build plate
const MARKER_FRACTION = 1; // marker fills 85% of the smaller canvas side
const MARGIN = 5;

let markerId = Number(range.value);
const markerImg = new Image(); // offscreen raster of the current marker SVG

// The canvas only feeds a three.js texture; keep it out of the layout.
canvas.style.display = 'none';

// --- canvas sizing: follows the build-plate sliders ------------------------
function sizeCanvas() {
  canvas.width = Math.max(1, Number(sliderX.value)) * PPM;
  canvas.height = Math.max(1, Number(sliderY.value)) * PPM;
}

function markerPixelSize() {
  return Math.max(16, Math.round(Math.min(canvas.width, canvas.height) * MARKER_FRACTION/countTags));
}

// --- marker raster: (re)load the SVG at the pixel size it will be drawn in -
function loadMarker(id, px) {
  markerImg.onload = null; // a duplicate src would not fire load again
  markerImg.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(arucoToSVGString(id, px));
}

function draw() {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Use a local: mutating the module-level countTags here used to halve
  // it on every repaint (4 → 2 → 1 → 0.5 → ...), so the loop bound below
  // silently shrank and the layout degraded on every slider touch.
  const tags = countTags;
  for(var i = 0; i < tags; i+=2)
  {
    if (markerImg.naturalWidth > 0) {
      const size = markerPixelSize();
      const x = (canvas.width - size) / 2;
      const y = (canvas.height - size) / 2;

      var hoppingFactorX = canvas.width/countTags;//
      var hoppingFactorY = canvas.height/countTags;

      //draw odd
      ctx.drawImage(
        markerImg, 0, 0, markerImg.naturalWidth, markerImg.naturalHeight,
        MARGIN*i, MARGIN*i*hoppingFactorY, size, size
      );
      //draw even
      ctx.drawImage(
        markerImg,0,0, markerImg.naturalWidth,markerImg.naturalHeight,
        (2* MARGIN+hoppingFactorX),MARGIN*i*hoppingFactorY,size,size
      )
    }
  }

}

// --- notify the three.js side so it re-uploads the texture -----------------
function changed() {
  window.dispatchEvent(new CustomEvent('aruco:changed'));
}

// One full refresh: (re)size the canvas, load the marker SVG for the
// current slider values, then repaint + notify once the image is ready.
//
// Marker id / plate sliders both land here. A generation counter makes
// stale loads harmless: when the user keeps dragging, the newest refresh
// bumps refreshGen, so onloads from older loads see gen !== refreshGen and
// skip the repaint + texture re-upload instead of all firing one by one.
let refreshGen = 0;

function refresh() {
  markerId = Number(range.value);
  const gen = ++refreshGen;
  sizeCanvas(); // a canvas resize clears it; the marker is redrawn at the new size
  loadMarker(markerId, markerPixelSize());
  markerImg.onload = () => {
    if (gen !== refreshGen) return; // superseded by a newer slider position
    img.src = markerImg.src;
    draw();
    changed();
  };
}

// Coalesce rapid input ticks: schedule at most one refresh per animation
// frame, so a fast drag produces ~one repaint+upload per frame instead of
// one per slider tick.
let pendingFrame = 0;

function scheduleRefresh() {
  if (pendingFrame) cancelAnimationFrame(pendingFrame);
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    refresh();
  });
}

range.addEventListener('input', scheduleRefresh);
sliderX.addEventListener('input', scheduleRefresh);
sliderY.addEventListener('input', scheduleRefresh);

// --- first paint -------------------------------------------------------------
refresh();
