// three.js preview of the corner rig, plus the exports that need three
// (3MF via three-3mf-exporter, GLB via GLTFExporter). The rig is built in its
// own frame: millimetres, +z up, origin at the inner corner.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { exportTo3MF } from 'three-3mf-exporter';
import { makeRigGroup } from './rig/rigGroup.js';

export function createRigScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x30343b);
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.up.set(0, 0, 1);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(300, 150, 400);
  scene.add(sun);

  // the shared origin every face's markers are measured from (x red, y green, z blue)
  const origin = new THREE.AxesHelper(30);
  origin.renderOrder = 2;
  origin.material.depthTest = false;
  scene.add(origin);

  const grid = new THREE.GridHelper(400, 40, 0x666666, 0x444444);
  grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; the rig's floor is XY
  scene.add(grid);

  // the printable object: one group, two parts (white body, black inlay)
  const { group: rig, setMeshes } = makeRigGroup();
  scene.add(rig);

  let framed = false;

  function setRig(meshes, params) {
    setMeshes(meshes);
    grid.position.z = -params.thicknessMm - 0.01;
    if (!framed) {
      const S = params.faceMm;
      controls.target.set(S * 0.35, S * 0.35, S * 0.25);
      camera.position.set(S * 2.6, S * 2.1, S * 1.9);
      framed = true;
    }
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  // 3MF: one object with two parts (see rig/rigGroup.js)
  function export3MF() {
    return exportTo3MF(rig);
  }

  // GLB for viewers: glTF is Y-up, so turn the Z-up rig over; units stay mm.
  function exportGLB() {
    const wrap = new THREE.Group();
    const copy = rig.clone();
    copy.rotation.x = -Math.PI / 2;
    wrap.add(copy);
    return new Promise((resolve, reject) => {
      new GLTFExporter().parse(wrap, (glb) => resolve(new Blob([glb], { type: 'model/gltf-binary' })), reject, { binary: true });
    });
  }

  return { setRig, export3MF, exportGLB };
}
