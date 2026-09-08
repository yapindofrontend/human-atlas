# How Human Atlas Displays Anatomy

How 2,234 individually selectable meshes render at 60fps in one browser tab — from network bytes to a picked structure. Core file: [app/scene.tsx](../app/scene.tsx).

---

## 1. The core problem

The atlas is **2,234 separate source meshes** (~2.29M triangles). The naive approach — one Three.js `Mesh` per part — means 2,234 draw calls per frame. That tanks framerate.

**The trick:** merge all parts of a system into ONE geometry per system (15 draw calls total), then drive each part's *visibility*, *position offset*, and *selection highlight* from **GPU textures** that a custom shader reads per-vertex. React never touches Three objects mesh-by-mesh — it flips values in typed arrays, uploads two small textures, and the GPU does the rest.

```
2,234 meshes  ──merge by system──►  15 draw calls
per-part state ──packed into──►  2 DataTextures  ──read by──►  patched shader
```

---

## 2. Data model

Defined in [app/anatomy.ts](../app/anatomy.ts).

| Type | Meaning |
|------|---------|
| `Part` | ONE source mesh. Has byte offsets (`positions`/`normals`/`indices`) into a chunk buffer, `vertexCount`, `indexCount`, `bounds`, and a `system`. |
| `Concept` | A *named* structure (e.g. "heart"). Groups one or more `Part` ids via `elements`. 3,432 of them. |
| `Atlas` | The catalogue: `parts[]`, `concepts[]`, `chunks[]` (binary file manifest), `triangles`. |
| `SceneState` | UI intent React passes to the scene: `explode`, `visible[]` systems, `selected[]` parts, `isolate`, `view`, `rotate`, `reset`. |

Runtime files live in `public/models/`: `atlas.json` (the catalogue) + `body-0.bin`…`body-14.bin` (geometry, 15 chunks) + `.gz` variants.

**Part vs Concept is the key distinction:** the geometry/picking layer works in Parts (source meshes); the UI (search, detail panel) works in Concepts (human names). Tapping selects a Part → resolves to its Concept for display.

---

## 3. Load pipeline

### 3a. Catalogue fetch — [app/page.tsx](../app/page.tsx)
On mount, `Home` fetches `/models/atlas.json` into React state. Nothing renders until it arrives. `<AnatomyScene>` mounts only once `atlas` is set.

### 3b. Chunk download — `loadChunk` in scene.tsx
Three chunks download **in parallel** (a 3-worker cursor loop, [scene.tsx:77](../app/scene.tsx#L77)). For each chunk:

1. Prefer the `.gz` URL when `DecompressionStream` exists.
2. [`decodeModelResponse`](../app/model-download.ts) handles a static-host quirk: a `.gz` may arrive already decoded (via `Content-Encoding`) or as raw gzip bytes. It sniffs the `1f 8b` magic bytes to avoid double-decoding, then **verifies byte length** against the manifest.
3. Progress reported back to React (`onProgress`) → drives the loading bar.

### 3c. Geometry assembly — `loadChunk`
For every `Part` in the chunk, it builds a `BufferGeometry` from **views into the shared ArrayBuffer** (zero-copy):
- `position`: `Float32Array`
- `normal`: `Int16Array` normalized (signed 16-bit — half the memory of floats) — see [scene.tsx:66](../app/scene.tsx#L66)
- index: `Uint32Array`
- A custom **`partIndex`** attribute: every vertex of part *i* stores the float `i` ([scene.tsx:71](../app/scene.tsx#L71)). This is how the shader knows which texel to read.

Two objects come out of each part:
- A **picker mesh** (`pickers[i]`) — kept off-scene, used only for raycasting.
- The geometry is pushed into a per-system group.

Then [scene.tsx:74](../app/scene.tsx#L74): each system's geometries are `mergeGeometries()`'d into a single mesh added to the scene. **15 meshes total.**

---

## 4. The GPU state textures (the heart of it)

Two textures, one texel per part (width = next power of two ≥ 2,234):

| Texture | Format | Channels | Meaning |
|---------|--------|----------|---------|
| `partTexture` | RGBA Float | `xyz` = translation offset, `w` = visible flag (0/1) | where each part sits + whether to draw it |
| `selectionTexture` | RGBA Uint8 | `r` = selected (0/255) | highlight tint |

`materialFor(system)` ([scene.tsx](../app/scene.tsx)) patches Three's standard material via `onBeforeCompile`:

- **Vertex shader**: reads `partTexture` at `(partIndex+0.5)/width`, adds `state.xyz` to the vertex position (the explode/layout offset), and passes `state.w` (visibility) + selection to the fragment shader.
- **Fragment shader**: `if (partVisible < 0.5) discard;` — hides parts without a separate draw call. Then mixes in a teal tint by `partSelected`.

So **moving, hiding, or highlighting any of 2,234 parts = writing floats into two typed arrays and setting `needsUpdate=true`.** No per-object JS, no re-merge.

---

## 5. The frame loop — `animate` ([scene.tsx:98](../app/scene.tsx#L98))

Runs every rAF but is **dirty-flag gated**: `renderer.render` only fires when `dirty` is true (camera moved, state changed, or explode animating). Idle = no GPU work.

Each frame, if state or explode changed:

1. **Compute visible parts** — filter by `isolate ? selected : visible systems ∪ selected` ([scene.tsx:105](../app/scene.tsx#L105)).
2. **Recompute layout if the visible set changed** — [`createExplosionLayout`](../app/explosion-layout.ts) shelf-packs only visible parts into non-overlapping cells (the "inventory" grid). Keyed by part-id list + camera aspect so it's not redone needlessly ([scene.tsx:107](../app/scene.tsx#L107)).
3. **Write per-part state** ([scene.tsx:109-114](../app/scene.tsx#L109-L114)) — for each part, compute its offset `(dx,dy,dz)`:
   - `explode ≤ 0.45`: parts drift outward radially by system (a gentle bloom).
   - `explode > 0.45`: lerp from that bloom toward the packed grid cell.
   - Pack visibility flag into `data[i*4+3]`, selection into `selectedData[i*4]`, and mirror position into the picker mesh + the marker point cloud.
4. Upload both textures (`needsUpdate=true`).

`explode` itself is **damped** ([scene.tsx:102](../app/scene.tsx#L102), `T.MathUtils.damp`) so slider changes animate smoothly.

### Camera framing
`fit()` ([scene.tsx:78](../app/scene.tsx#L78)) positions the camera per `view` (front/back/side/¾) and interpolates distance as the model explodes so the growing inventory stays in frame. It reserves screen space for the UI panels (different on mobile vs desktop).

### Isolate mode
When `isolate` is on ([scene.tsx:121](../app/scene.tsx#L121)), it unions the selected parts' bounds, then frames that box into the screen area *not* covered by the detail sheet (reads the actual DOM rects of `.detail-sheet` / `.identity`, and adapts to mobile/landscape).

### Control mode switches ([scene.tsx:126](../app/scene.tsx#L126))
As explode passes thresholds: orbit→pan, ground/platform hidden, marker dots shown (`explode>0.75`), auto-rotate disabled. Keeps interaction sensible in "inventory" view.

---

## 6. Picking (tap to inspect)

Tap detection is separate from selection:

1. [`PointerTap`](../app/pointer-tap.ts) tracks each pointer and **rejects** anything that moved past a threshold, was multitouch, or got canceled — so orbit/pinch/pan never count as a tap.
2. On a valid tap, `up()` ([scene.tsx:90](../app/scene.tsx#L90)) raycasts:
   - Sets the ray from normalized pointer coords.
   - Iterates picker meshes, but **skips hidden parts** (`data[i*4+3]<0.5`) and skips the skin/`integumentary` layer when solid organs are present (so you don't always hit the skin first) ([scene.tsx:92-93](../app/scene.tsx#L92-L93)).
   - Broad-phase `intersectBox` before the exact `intersectObject` for speed.
3. In exploded view, falls back to nearest **projected 2D target** (`findTarget`) so tapping near a small piece still works.
4. On hit → `select.current(partId)` → back up to `Home.choosePart` → opens the detail sheet.

In exploded view the frame loop also projects each visible part's bounding box to 2D screen rects (`targets`, [scene.tsx:127](../app/scene.tsx#L127)) — used for hover tooltips and tap fallback.

---

## 7. React ⇄ Scene contract

React is intentionally dumb about 3D:

```
Home (page.tsx)                        AnatomyScene (scene.tsx)
  state: SceneState  ──props──►          latest.current = state   (ref, no re-render)
  onSelect(partId)   ◄──callback──         raycast hit
  onProgress(n)      ◄──callback──         chunk loaded
```

- The whole scene lives in **one `useEffect` keyed on `atlas`** — it builds everything once and returns a full teardown (dispose geometries, materials, textures, listeners) at [scene.tsx:131](../app/scene.tsx#L131).
- State reaches the loop through `latest.current` (a ref updated every render) — so new props never rebuild the scene, they just get read next frame.
- `reset` is a counter: bumping it forces a re-fit without changing other state.

---

## 8. Quick trace: "user toggles the Muscles system off"

1. Switch `onCheckedChange` → `Home.toggle('muscular')` → `setState` drops `'muscular'` from `visible[]`.
2. New `SceneState` flows as a prop; `latest.current` updates. No Three rebuild.
3. Next `animate` frame: `changed` is true → recompute `visibleParts` (muscular parts now excluded).
4. For each muscular part, `data[i*4+3]` set to 0; `partTexture.needsUpdate=true`.
5. `dirty=true` → one `renderer.render`. Shader discards those vertices. Muscles vanish — **zero new draw calls, zero geometry changes.**

---

## Files at a glance

| Concern | File |
|---------|------|
| UI shell, state owner, search, panels | [app/page.tsx](../app/page.tsx) |
| Renderer, textures, frame loop, picking | [app/scene.tsx](../app/scene.tsx) |
| Types, systems, concept data | [app/anatomy.ts](../app/anatomy.ts) |
| Inventory packing | [app/explosion-layout.ts](../app/explosion-layout.ts) |
| Chunk fetch + gzip decode | [app/model-download.ts](../app/model-download.ts) |
| Tap-vs-drag | [app/pointer-tap.ts](../app/pointer-tap.ts) |
