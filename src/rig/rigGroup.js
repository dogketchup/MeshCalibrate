// The printable object as a three.js Group: two meshes, white body and black
// inlay. DOM-free, so the 3MF export can be tested under node; the page shows
// this same Group. three-3mf-exporter turns it into ONE 3MF object with two
// parts and gives each material colour its own filament slot (white = 1,
// black = 2) in Bambu Studio's metadata.
import * as THREE from 'three';

function toGeometry({ positions, indices }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  const flat = g.toNonIndexed(); // per-face normals: shared corner vertices would smooth the box edges
  flat.computeVertexNormals();
  g.dispose();
  return flat;
}

export function makeRigGroup() {
  const group = new THREE.Group();
  group.name = 'MeshCalibrate_corner_rig';
  const white = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true }));
  white.name = 'rig_white';
  const black = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x000000, flatShading: true }));
  black.name = 'rig_black';
  group.add(white, black);

  function setMeshes(meshes) {
    white.geometry.dispose();
    black.geometry.dispose();
    white.geometry = toGeometry(meshes.white);
    black.geometry = toGeometry(meshes.black);
  }
  return { group, setMeshes };
}
