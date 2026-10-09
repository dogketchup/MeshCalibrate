// ArUco marker generator.
//
// Watches the #generate_tag_code slider (marker id) and the build-plate
// sliders (canvas size). Paints the selected marker into the hidden
// #plane_1_texture canvas and mirrors it into the visible #aruco-marker
// <img>. Every repaint dispatches an "aruco:changed" window event so
// threejsscene.js can re-upload the texture without the two modules
// importing each other.
import { arucoToSVGString } from 'aruco-marker';

const range = document.getElementById('generate_tag_code');
const sliderX = document.getElementById('build_plate_x');
const sliderY = document.getElementById('build_plate_y');
const img = document.querySelector('#aruco-marker');
const canvas = document.getElementById('plane_1_texture');
const ctx = canvas.getContext('2d');

const PPM = 40; // canvas pixels per 1cm of build plate
const MARKER_FRACTION = 0.85; // marker fills 85% of the smaller canvas side

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
  return Math.max(16, Math.round(Math.min(canvas.width, canvas.height) * MARKER_FRACTION));
}

// --- marker raster: (re)load the SVG at the pixel size it will be drawn in -
function loadMarker(id, px) {
  markerImg.onload = null; // a duplicate src would not fire load again
  markerImg.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(arucoToSVGString(id, px));
}

// --- paint: white plate with the marker centred ----------------------------
function draw() {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (markerImg.naturalWidth > 0) {
    const size = markerPixelSize();
    const x = (canvas.width - size) / 2;
    const y = (canvas.height - size) / 2;
    ctx.drawImage(
      markerImg, 0, 0, markerImg.naturalWidth, markerImg.naturalHeight,
      x, y, size, size
    );
  }
}

// --- notify the three.js side so it re-uploads the texture -----------------
function changed() {
  window.dispatchEvent(new CustomEvent('aruco:changed'));
}

// Marker id changed → new SVG, refresh the <img>, repaint, notify.
range.addEventListener('input', () => {
  markerId = Number(range.value);
  loadMarker(markerId, markerPixelSize());
  markerImg.onload = () => {
    img.src = markerImg.src;
    draw();
    changed();
  };
});

// Plate size changed → resize the canvas (a resize clears it), repaint,
// notify. The marker is redrawn at the new pixel size.
function onPlateResize() {
  sizeCanvas();
  loadMarker(markerId, markerPixelSize());
  markerImg.onload = () => {
    img.src = markerImg.src;
    draw();
    changed();
  };
}
sliderX.addEventListener('input', onPlateResize);
sliderY.addEventListener('input', onPlateResize);

// --- first paint -------------------------------------------------------------
sizeCanvas();
loadMarker(markerId, markerPixelSize());
markerImg.onload = () => {
  img.src = markerImg.src;
  draw();
  changed();
};
