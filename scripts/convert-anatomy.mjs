/**
 * Convert official BodyParts3D 4.0 OBJ meshes without altering topology.
 * Usage: node scripts/convert-anatomy.mjs OBJ_DIRECTORY CONCEPT_MAP [SYSTEM_MAP]
 * Source and attribution: public/ATTRIBUTION.md. Geometry positions change mm/Z-up
 * into meters/Y-up; normals become signed 16-bit and parts are grouped into chunks.
 *
 * Converts official BodyParts3D OBJ meshes to the atlas binary format.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [,, objDir, conceptMapFile, systemMapFile] = process.argv;
if (!objDir || !conceptMapFile) {
  console.error('Usage: node scripts/convert-anatomy.mjs OBJ_DIRECTORY CONCEPT_MAP [SYSTEM_MAP]');
  process.exit(1);
}

const source = path.resolve(objDir);
const metadata = JSON.parse(fs.readFileSync(conceptMapFile, 'utf8'));
const systemdata = systemMapFile ? JSON.parse(fs.readFileSync(systemMapFile, 'utf8')) : {};
const outDir = path.join(root, 'public', 'models');
fs.mkdirSync(outDir, {recursive: true});

// Accept the research map's element records or a direct id -> system mapping.
let systems = systemdata.systems ?? systemdata.mapping ?? systemdata.elements ?? systemdata.meshes ?? systemdata;
if (Array.isArray(systems)) systems = Object.fromEntries(systems.map(x => [x.id, x]));

const parts = [], chunks = [];
let segments = [], blobLen = 0, chunkIdx = 0, totalTriangles = 0;

/** Pad to 4-byte boundary, append typed array, return byte offset. */
const append = typed => {
  const pad = (4 - blobLen % 4) % 4;
  if (pad) { segments.push(Buffer.alloc(pad)); blobLen += pad; }
  const offset = blobLen;
  segments.push(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength));
  blobLen += typed.byteLength;
  return offset;
};

const flushChunk = () => {
  const data = Buffer.concat(segments);
  fs.writeFileSync(path.join(outDir, `anatomy-${chunkIdx}.bin`), data);
  chunks.push({url: `/models/anatomy-${chunkIdx}.bin`, bytes: data.length});
  segments = []; blobLen = 0; chunkIdx++;
};

for (const element of metadata.elements) {
  const record = (systemdata.parts ?? {})[element.id] ?? {};
  const vertices = [], normals = [], indices = [];
  let name = element.name;

  for (const line of fs.readFileSync(path.join(source, element.id + '.obj'), 'utf8').split(/\r?\n/)) {
    if (line.startsWith('# English name : ')) {
      name = line.split(' : ', 2)[1].trim() || element.name;
    } else if (line.startsWith('v ')) {
      const tok = line.split(/\s+/);
      const x = +tok[1], y = +tok[2], z = +tok[3];
      vertices.push(x * 0.001, z * 0.001 + 0.0781112, -y * 0.001 - 0.1);
    } else if (line.startsWith('vn ')) {
      const tok = line.split(/\s+/);
      const x = +tok[1], y = +tok[2], z = +tok[3];
      normals.push(Math.round(x * 32767), Math.round(z * 32767), Math.round(-y * 32767));
    } else if (line.startsWith('f ')) {
      const face = line.split(/\s+/).slice(1).map(s => parseInt(s) - 1);
      for (let j = 1; j < face.length - 1; j++) indices.push(face[0], face[j], face[j + 1]);
    }
  }

  if (normals.length !== vertices.length) throw new Error(`${element.id}: normal/vertex count mismatch`);
  const vertexCount = vertices.length / 3;
  let maxIdx = 0; for (const i of indices) if (i > maxIdx) maxIdx = i;
  if (!vertices.length || maxIdx >= vertexCount) throw new Error(`${element.id}: invalid vertex index`);

  // Flush BEFORE appending, matching Python: `if len(blob) > 7_000_000: flush()`
  if (blobLen > 7_000_000) flushChunk();

  const po = append(new Float32Array(vertices));
  const no = append(new Int16Array(normals));
  const io = append(new Uint32Array(indices));

  // Per-axis min/max of transformed positions.
  const bounds = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
  for (let i = 0; i < vertices.length; i++) {
    const k = i % 3;
    if (vertices[i] < bounds[0][k]) bounds[0][k] = vertices[i];
    if (vertices[i] > bounds[1][k]) bounds[1][k] = vertices[i];
  }

  let system = systems[element.id] ?? 'connective';
  if (system !== null && typeof system === 'object') system = system.system ?? system.category ?? 'connective';

  parts.push({
    id: element.id,
    name: record.name ?? name,
    conceptId: record.conceptId ?? element.conceptId,
    system, chunk: chunkIdx,
    positions: po, normals: no, indices: io,
    vertexCount, indexCount: indices.length,
    bounds,
  });
  totalTriangles += indices.length / 3;
}

flushChunk();

const manifest = {
  version: 'BodyParts3D 4.0',
  parts,
  chunks,
  triangles: totalTriangles,
  concepts: metadata.concepts.map(({id, name, elements}) => ({id, name, elements})),
};
fs.writeFileSync(path.join(outDir, 'atlas.json'), JSON.stringify(manifest));
console.log(JSON.stringify({
  parts: parts.length,
  concepts: manifest.concepts.length,
  triangles: totalTriangles,
  bytes: chunks.reduce((n, c) => n + c.bytes, 0),
  chunks: chunks.length,
  systems: [...new Set(parts.map(p => p.system))].sort(),
}, null, 2));
