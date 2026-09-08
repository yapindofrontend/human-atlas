# Data Format & GPU Contract

Exact spec to reproduce the runtime assets and the shader that consumes them. Everything an agent needs to write a compatible converter or renderer from scratch. Companion to [rendering.md](./rendering.md).

---

## 1. Files in `public/models/`

| File | Content |
|------|---------|
| `atlas.json` | The catalogue. Parsed first; describes every part's location in the binaries. |
| `body-0.bin` … `body-14.bin` | Geometry chunks (~≤7 MB each). Raw concatenated typed-array segments. |
| `body-*.bin.gz` | gzip -9 of each chunk. Loaded when `DecompressionStream` exists. |

---

## 2. `atlas.json` shape

```jsonc
{
  "version": "BodyParts3D 4.0",
  "sex": "male",                 // optional
  "source": "...",               // optional
  "scope": "...",                // optional
  "triangles": 2288268,          // sum of every part's indexCount/3 — validated exactly
  "sourceTriangles": 0,          // pre-simplification count (written by optimize step)
  "optimized": true,             // guard flag; blocks re-running optimize
  "chunks": [
    { "url": "/models/body-0.bin", "bytes": 4019496,
      "gzip": "/models/body-0.bin.gz", "gzipBytes": 2257262 }
  ],
  "parts":    [ /* Part */ ],    // 2,234 — source meshes
  "concepts": [ /* Concept */ ]  // 3,432 — named groupings
}
```

> **Type drift:** the `Atlas` interface in [app/anatomy.ts](../app/anatomy.ts) omits `sourceTriangles` and `optimized`, which exist in the real JSON. Add them if you rely on the type.

### Part (one source mesh)
```jsonc
{
  "id": "FJ1252",              // unique; validators reject "-" and duplicates
  "name": "Gingiva of upper jaw",
  "conceptId": "FMA59763",    // links to a Concept; reject "-"
  "system": "skeletal",       // one of the 15 SystemId values
  "chunk": 0,                 // which body-N.bin holds this part's bytes
  "positions": 0,             // BYTE offset into the chunk buffer
  "normals": 10596,           // BYTE offset
  "indices": 15896,           // BYTE offset
  "vertexCount": 883,
  "indexCount": 4272,
  "bounds": [[minX,minY,minZ],[maxX,maxY,maxZ]]  // world-space AABB, meters
}
```

### Concept (named structure)
```jsonc
{ "id": "FMA3710", "name": "vascular tree",
  "elements": ["FJ2925","FJ2933", …] }   // Part ids; every id must exist
```
A Concept has **no** `system` — that lives on its Parts. One Concept can span multiple Parts across systems.

---

## 3. Binary chunk byte layout

Each `body-N.bin` is raw segments back-to-back, **no header**. A Part's three offsets are **relative to the start of its own chunk buffer**. Read with typed-array *views* (zero-copy):

| Attribute | Offset field | TypedArray | Length (elements) | Notes |
|-----------|-------------|------------|-------------------|-------|
| position | `positions` | `Float32Array` | `vertexCount * 3` | world meters, Y-up |
| normal | `normals` | `Int16Array` (normalized) | `vertexCount * 3` | value = `round(component * 32767)`; read with `normalized: true` |
| index | `indices` | `Uint32Array` | `indexCount` | triangle list |

**4-byte alignment:** every segment starts on a 4-byte boundary. The writer zero-pads before each segment (`while(len % 4) push(0)`). A reader must trust the stored offset (already aligned), not recompute it.

Reference reader ([app/scene.tsx:64-67](../app/scene.tsx#L64)):
```ts
g.setAttribute('position', new T.BufferAttribute(
  new Float32Array(buffer, p.positions, p.vertexCount*3), 3));
g.setAttribute('normal', new T.BufferAttribute(
  new Int16Array(buffer, p.normals, p.vertexCount*3), 3, /*normalized*/ true));
g.setIndex(new T.BufferAttribute(
  new Uint32Array(buffer, p.indices, p.indexCount), 1));
```

> `buffer` here is the chunk's `ArrayBuffer`; when slicing a Node `Buffer` use `b.buffer, b.byteOffset + p.positions, …`.

### Download decode caveat
Static hosts may serve `.gz` already decoded (via `Content-Encoding`) or as raw gzip. [`decodeModelResponse`](../app/model-download.ts) sniffs the `1f 8b` magic bytes to avoid double-decoding, then asserts `byteLength === chunk.bytes`. Reproduce both checks.

---

## 4. Coordinate transform (source → runtime)

BodyParts3D OBJ is millimeters, **Z-up**. Runtime is meters, **Y-up**, recentred. Applied once in [convert-anatomy.mjs](../scripts/convert-anatomy.mjs); never re-apply downstream.

```
position:  x' = x * 0.001
           y' = z * 0.001 + 0.0781112     // OBJ z becomes runtime y, lifted
           z' = -y * 0.001 - 0.1          // OBJ y becomes runtime -z, shifted
normal:    nx' = round(nx * 32767)
           ny' = round(nz * 32767)         // same axis swap as position
           nz' = round(-ny * 32767)
```
Faces are triangulated fan-style (`[f0, fj, fj+1]`). `bounds` = per-axis min/max of transformed positions.

---

## 5. GPU state contract (the shader patch)

The renderer draws **one merged mesh per system** but controls each part individually through two textures, indexed by a per-vertex `partIndex` attribute. To reproduce the effect exactly, reproduce these.

### Per-vertex attribute
Every vertex of part *i* carries `partIndex = i` (a `Float32Array(vertexCount).fill(i)`), added before merge. It survives `mergeGeometries`, letting the shader locate that part's texel.

### The two textures (one texel per part, width = next pow2 ≥ part count)
| Texture | Format | Channels → meaning |
|---------|--------|--------------------|
| `partTexture` | `RGBAFormat` + `FloatType` | `xyz` = translation offset (explode/layout), `w` = visible (0 or 1) |
| `selectionTexture` | RGBA `Uint8` (default) | `r` = selected (0 or 255) |

Writing state = mutate the backing `Float32Array` / `Uint8Array`, set `.needsUpdate = true`. No per-object JS, no re-merge.

### The exact `onBeforeCompile` injection ([app/scene.tsx:51-57](../app/scene.tsx#L51))
```glsl
// vertex — prepended:
attribute float partIndex; uniform sampler2D partState; uniform sampler2D selectionState;
uniform float stateWidth; varying float partVisible; varying float partSelected;

// vertex — after #include <begin_vertex>:
vec2 stateUv = vec2((partIndex + 0.5) / stateWidth, 0.5);
vec4 state = texture2D(partState, stateUv);
transformed += state.xyz;              // apply per-part offset
partVisible = state.w;
partSelected = texture2D(selectionState, stateUv).r;

// fragment — prepended:
varying float partVisible; varying float partSelected;

// fragment — after #include <clipping_planes_fragment>:
if (partVisible < 0.5) discard;        // hide invisible parts, no draw call

// fragment — after #include <color_fragment>:
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.85, 0.78), partSelected * 0.75);
```
Uniforms wired in the same hook: `partState`, `selectionState`, `stateWidth`.

---

## 6. Rebuild pipeline & invariants

```
node scripts/convert-anatomy.mjs OBJ_DIR CONCEPT_MAP [SYSTEM_MAP]   # OBJ -> atlas.json + anatomy-*.bin
node scripts/optimize-anatomy.mjs [atlas.json]                       # meshopt simplify @0.2% rel error; re-chunks to body-*.bin; sets optimized:true
node scripts/compress-models.mjs                                     # gzip -9 -> *.bin.gz; writes gzip/gzipBytes
```
Validators ([scripts/AGENTS.md](../scripts/AGENTS.md)) enforce: 2,234 parts, 3,432 concepts, unique ids, no `-` name/conceptId, every index `< vertexCount`, finite positions, buffer length == `chunk.bytes`, and `sum(indexCount/3) == triangles`. Keep these true or `validate-atlas.mjs` fails.

> The converter emits `anatomy-*.bin` at a ~7 MB chunk threshold; `optimize-anatomy.mjs` re-emits the shipped `body-*.bin`. Offsets are always chunk-relative, so re-chunking rewrites every part's `chunk`/offset fields.
