// export3mf.js
//
// "Export mesh + texture (3MF)" button.
//
// 3MF is an OPC (zip) package:
//   [Content_Types].xml
//   _rels/.rels
//   3D/3dmodel.model          <- mesh (vertices + triangles + UVs)
//   3D/3dmodel.rels           <- references the texture image
//   3D/Textures/plate.png     <- the ArUco canvas, exported as PNG
//
// No external zip library: a minimal STORE (uncompressed) zip writer is
// included below. Coordinates are exported in millimeters (3MF unit).
//
// Data flow (same event pattern as arCuoTag -> threejsscene):
//   button click -> dispatch 'mesh:export-request'
//   threejsscene answers with 'mesh:export-data'
//   (positions, uvs, indices, scale) -> we build the .3mf and download it.

// ---------------------------------------------------------------------------
// Minimal zip writer (STORE method, no compression)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  // files: [{ name: string, data: Uint8Array }]
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method: STORE
    local.setUint16(10, 0, true); // mod time
    local.setUint16(12, 0, true); // mod date
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra len

    localParts.push(new Uint8Array(local.buffer), name, file.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central dir signature
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0, true); // flags
    central.setUint16(10, 0, true); // method
    central.setUint16(12, 0, true); // time
    central.setUint16(14, 0, true); // date
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, 0, true); // extra len
    central.setUint16(32, 0, true); // comment len
    central.setUint16(34, 0, true); // disk number
    central.setUint16(36, 0, true); // internal attrs
    central.setUint32(38, 0, true); // external attrs
    central.setUint32(42, offset, true); // local header offset

    centralParts.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + size;
  }

  const cdOffset = offset;
  const cdSize = centralParts.reduce((n, p) => n + p.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true); // disk
  eocd.setUint16(6, 0, true); // cd disk
  eocd.setUint16(8, files.length, true); // entries this disk
  eocd.setUint16(10, files.length, true); // entries total
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdOffset, true);
  eocd.setUint16(20, 0, true); // comment len

  return new Blob([...localParts, ...centralParts, new Uint8Array(eocd.buffer)], {
    type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  });
}

// ---------------------------------------------------------------------------
// 3MF content
// ---------------------------------------------------------------------------
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>
`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2015/01/3d"/>
</Relationships>
`;

const MODEL_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/Textures/plate.png" Id="rel1" Type="http://schemas.microsoft.com/3dmanufacturing/2015/01/3d"/>
</Relationships>
`;

function buildModelXml({ positions, uvs, indices, scale }) {
  // positions are in cm (box units) -> export in millimeters.
  const cmToMm = 10;
  const sx = scale[0] * cmToMm;
  const sy = scale[1] * cmToMm;
  const sz = scale[2] * cmToMm;

  let vertices = '<vertices>\n';
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] * sx;
    const y = positions[i + 1] * sy;
    const z = positions[i + 2] * sz;
    vertices += `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="${z.toFixed(4)}"/>`;
  }
  vertices += '</vertices>\n';

  let uvsXml = '<texturecoords>\n';
  for (let i = 0; i < uvs.length; i += 2) {
    // Three.js UVs are y-down in texture space; 3MF is y-up on the map,
    // so flip v so the marker isn't upside down on the top face.
    uvsXml += `<u v="${(1 - uvs[i + 1]).toFixed(6)}" t="${uvs[i].toFixed(6)}"/>`;
  }
  uvsXml += '</texturecoords>\n';

  let triangles = '<triangles>\n';
  for (let i = 0; i < indices.length; i += 3) {
    triangles += `<triangle p1="${indices[i]}" p2="${indices[i + 1]}" p3="${indices[i + 2]}" material_index="1"/>`;
  }
  triangles += '</triangles>\n';

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/05"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/properties/2015/06">
  <resources>
    <object id="1" type="model">
      <mesh>
        ${vertices}
        ${uvsXml}
        ${triangles}
      </mesh>
    </object>
    <object id="2" type="model">
      <mesh>
        <components objectid="1"/>
      </mesh>
    </object>
    <basematerial id="100">
      <texture albedourleid="101"/>
    </basematerial>
    <texture id="101" albedourl="#/3D/Textures/plate.png"/>
  </resources>
  <build>
    <item objectid="2"/>
  </build>
</model>
`;
}

// ---------------------------------------------------------------------------
// Export driver
// ---------------------------------------------------------------------------
function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Failed to encode canvas as PNG'));
      blob.arrayBuffer().then(resolve, reject);
    }, 'image/png');
  });
}

async function requestMeshData() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No scene responded to export request')), 3000);
    window.addEventListener('mesh:export-data', (e) => {
      clearTimeout(timer);
      resolve(e.detail);
    }, { once: true });
    window.dispatchEvent(new CustomEvent('mesh:export-request'));
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.addEventListener('DOMContentLoaded', async () => {
  const btn = document.getElementById('export-mesh');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Exporting...';
    try {
      const { positions, uvs, indices, scale } = await requestMeshData();

      const canvas = document.getElementById('plane_1_texture');
      const png = new Uint8Array(await canvasToPngBytes(canvas));

      const modelXml = buildModelXml({ positions, uvs, indices, scale });

      const enc = new TextEncoder();
      const blob = buildZip([
        { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
        { name: '_rels/.rels', data: enc.encode(ROOT_RELS) },
        { name: '3D/3dmodel.model', data: enc.encode(modelXml) },
        { name: '3D/3dmodel.rels', data: enc.encode(MODEL_RELS) },
        { name: '3D/Textures/plate.png', data: png },
      ]);

      const sx = Math.round(scale[0] * 10);
      const sy = Math.round(scale[1] * 10);
      const sz = Math.round(scale[2] * 10);
      download(blob, `buildplate_${sx}x${sy}x${sz}mm.3mf`);
    } catch (err) {
      console.error('3MF export failed:', err);
      alert(`Export failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
});
