import * as THREE from 'three';

/**
 * Samples texture pixels into vertex colors strictly for the top (+Y) face.
 */
export function sampleTextureToVertexColors(mesh, canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const W = canvas.width;
  const H = canvas.height;

  const geometry = mesh.geometry;
  const uvAttr = geometry.attributes.uv;
  const posAttr = geometry.attributes.position;
  const normalAttr = geometry.attributes.normal;

  if (!uvAttr || !posAttr) return;

  const vertexCount = posAttr.count;
  let colorAttr = geometry.attributes.color;

  if (!colorAttr || colorAttr.count !== vertexCount) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    geometry.setAttribute('color', colorAttr);
  }

  for (let i = 0; i < vertexCount; i++) {
    // Check if vertex belongs to the top (+Y) face
    const ny = normalAttr ? normalAttr.getY(i) : (posAttr.getY(i) > 0 ? 1 : 0);

    if (ny > 0.5) {
      // Top face (+Y): Sample texture using UVs
      const u = Math.min(Math.max(uvAttr.getX(i), 0), 1);
      const v = Math.min(Math.max(uvAttr.getY(i), 0), 1);

      const px = Math.min(Math.floor(u * W), W - 1);
      const py = Math.min(Math.floor((1 - v) * H), H - 1);

      const offset = (py * W + px) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];

      // Binary threshold: snap anti-aliased gray edges to pure black or white
      const val = (r + g + b) / 3 < 128 ? 0.0 : 1.0;
      colorAttr.setXYZ(i, val, val, val);
    } else {
      // Side and bottom faces: set to clean white
      colorAttr.setXYZ(i, 1.0, 1.0, 1.0);
    }
  }

  colorAttr.needsUpdate = true;
}
