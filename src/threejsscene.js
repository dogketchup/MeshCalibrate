import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'



const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );
const renderer = new THREE.WebGLRenderer();
const controls = new OrbitControls( camera, renderer.domElement );

renderer.domElement.id = 'meshspace'
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setAnimationLoop( animate );
document.body.appendChild( renderer.domElement );


// Three spotlights in a uniform polar arrangement around the z axis.
// They share the original light's (x, y) offset (0, 10), rotated 0°, 120°,
// 240° about z, and each light's z still tracks the camera's lerped distance.
const spotLightOffset = new THREE.Vector2( 0, 10 ); // original spotlight's x/y
const spotLights = [];
for ( let i = 0; i < 3; i ++ ) {
	const light = new THREE.SpotLight( 0xffffff );
	light.angle = Math.PI / 5;
	light.intensity = 100;
	light.target.position.set( 0, 0, 0 );
	light.userData.angle = i * ( Math.PI * 2 / 3 ); // 0°, 120°, 240°
	scene.add( light );
	scene.add( light.target );
	spotLights.push( light );
}
const size = 35;
const divisions = 1;
// 2. Create the grid helper
const gridHelper = new THREE.GridHelper(size, divisions,0xffffff,0xffffff);

// 3. Add it to your existing scene
scene.add(gridHelper);


const sliderXValue = document.getElementById('build_plate_x').value;
const sliderYValue = document.getElementById('build_plate_y').value;


const geometry = new THREE.BoxGeometry( sliderXValue, 1, sliderYValue );
// The top (+Y) face of the cube carries the ArUco marker. arCuoTag.js
// paints the marker into the hidden #plane_1_texture canvas and fires an
// "aruco:changed" window event on every repaint; we just flip needsUpdate
// so three re-uploads the texture.
const plane1 = document.getElementById( 'plane_1_texture' );
const plane1Texture = new THREE.CanvasTexture( plane1 );
plane1Texture.colorSpace = THREE.SRGBColorSpace;
const faceMaterial = new THREE.MeshStandardMaterial( { color: 0xffffff } );
const markerMaterial = new THREE.MeshStandardMaterial( { color: 0xffffff, map: plane1Texture } );
// BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
const material = [ faceMaterial, faceMaterial, markerMaterial, faceMaterial, faceMaterial, faceMaterial ];
const cube = new THREE.Mesh( geometry, material );
scene.add( cube );

window.addEventListener( 'aruco:changed', () => {
  plane1Texture.needsUpdate = true;
});

camera.position.z = 5;
controls.target.set( 0, 0, 0 );

const axesHelper = new THREE.AxesHelper( 5 );
scene.add( axesHelper );

// Camera auto-backoff: the orbit target is the cube, so we keep the camera
// direction fixed and only ease its distance away from the cube as it grows.
const cameraOffset = new THREE.Vector3();
let targetDistance = 10;
const LERP_FACTOR = 0.1; // higher = snappier, lower = floatier

function setTargetDistance()
{
  const maxSize = Math.max( cube.scale.x, cube.scale.y, 1 );
  targetDistance = 3 + maxSize * 1.5;
}

function lerpCamera()
{
  cameraOffset.copy( camera.position ).sub( controls.target ).normalize();

  const current = camera.position.distanceTo( controls.target );
  const newDistance = current + ( targetDistance - current ) * LERP_FACTOR;

  camera.position.copy( controls.target ).addScaledVector( cameraOffset, newDistance );

  // Spotlights constrained to the z axis: their polar offset (x, y) stays
  // fixed per light, only z tracks the camera distance — the θ=0 light keeps
  // the original light's exact (0, 10, z) mapping.
  for ( const light of spotLights ) {
	const theta = light.userData.angle;
	light.position.x = spotLightOffset.x * Math.cos( theta ) - spotLightOffset.y * Math.sin( theta );
	light.position.y = spotLightOffset.x * Math.sin( theta ) + spotLightOffset.y * Math.cos( theta );
	light.position.z = newDistance;
  }
}

const sliderX = document.getElementById('build_plate_x');
const sliderY = document.getElementById('build_plate_y');

function onChangeBuildX( event )
{
  const mm = Number( event.target.value );
  cube.scale.x = 1 + mm / 100; // 0 mm still shows the base cube
  setTargetDistance();
}

//TODO: need to refactor Y to be Z
function onChangeBuildY( event )
{
  const mm = Number( event.target.value );
  cube.scale.z = 1 + mm / 100;
  setTargetDistance();
}

sliderX.addEventListener( 'input', onChangeBuildX );
sliderY.addEventListener( 'input', onChangeBuildY );

function animate( time ) {

  //cube.rotation.x = time / 2000;
  //cube.rotation.y = time / 1000;

  lerpCamera();
  renderer.render( scene, camera );

}
