import * as THREE from 'three';

/**
 * Builds a multi-part THREE.Group for multi-color slicing in Bambu Studio / OrcaSlicer.
 */
export function buildMultiColorGroup(plateWidth, plateHeight, plateThickness, points, tagSize) {
  const group = new THREE.Group();

  // 1. White Base Plate Mesh
  const plateGeo = new THREE.BoxGeometry(plateWidth, plateThickness, plateHeight);
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const plateMesh = new THREE.Mesh(plateGeo, whiteMat);
  plateMesh.name = 'Base_Plate';
  group.add(plateMesh);

  // 2. Black Tag Extrusions (0.2mm height = 1 layer thick)
  const tagDepth = 0.2;
  const tagMat = new THREE.MeshStandardMaterial({ color: 0x000000 });

  points.forEach((p, index) => {
    const tagGeo = new THREE.BoxGeometry(tagSize, tagDepth, tagSize);
    const tagMesh = new THREE.Mesh(tagGeo, tagMat);
    tagMesh.name = `Tag_Marker_${index + 1}`;

    // Map canvas coordinates to 3D centered box coordinates
    const posX = p.x - plateWidth / 2;
    const posZ = p.y - plateHeight / 2;
    const posY = plateThickness / 2 + tagDepth / 2;

    tagMesh.position.set(posX, posY, posZ);
    group.add(tagMesh);
  });

  return group;
}
