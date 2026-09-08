# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-08
**Commit:** 1c38bf3
**Branch:** main

## OVERVIEW
Interactive 3D anatomy explorer ("Human Atlas", package `anatomy-studio`). React 19 + Three.js + shadcn/Base UI, bundled by Vite 8, deployed static to Vercel. Renders 2,234 individually selectable BodyParts3D meshes across 15 systems.

## STRUCTURE
```
app/            # ALL product code (NOT a Next.js route tree despite the name)
web/            # Vite root: index.html + main.tsx entry that mounts app/page
components/ui/  # Generated shadcn/Base UI primitives (stock, ~60 files)
hooks/ lib/     # Shared helpers (use-mobile, cn)
public/models/  # Runtime data: atlas.json + body-0..14.bin (+ .gz) — committed geometry
scripts/        # Offline anatomy asset pipeline + validators (see scripts/AGENTS.md)
```

## WHERE TO LOOK
| Task | Location |
|------|----------|
| How rendering works (data → picked structure) | [docs/rendering.md](file:///Users/adithya/Documents/work/experimental/human-atlas/docs/rendering.md) |
| Binary `.bin` byte layout, coord transform, shader GLSL | [docs/data-format.md](file:///Users/adithya/Documents/work/experimental/human-atlas/docs/data-format.md) |
| App shell, UI state, search, selection, panels | [app/page.tsx](file:///Users/adithya/Documents/work/experimental/human-atlas/app/page.tsx) |
| Three.js renderer, GPU part-state textures, picking | [app/scene.tsx](file:///Users/adithya/Documents/work/experimental/human-atlas/app/scene.tsx) |
| Types, SYSTEMS, EXPLANATIONS, data model | [app/anatomy.ts](file:///Users/adithya/Documents/work/experimental/human-atlas/app/anatomy.ts) |
| Exploded-view packing | [app/explosion-layout.ts](file:///Users/adithya/Documents/work/experimental/human-atlas/app/explosion-layout.ts) |
| Chunked model fetch + gzip decode | [app/model-download.ts](file:///Users/adithya/Documents/work/experimental/human-atlas/app/model-download.ts) |
| Tap-vs-drag/pinch detection | [app/pointer-tap.ts](file:///Users/adithya/Documents/work/experimental/human-atlas/app/pointer-tap.ts) |
| Optional WebMCP search/inspect tools | [app/agent-tools.ts](file:///Users/adithya/Documents/work/experimental/human-atlas/app/agent-tools.ts) |
| All styling | [app/globals.css](file:///Users/adithya/Documents/work/experimental/human-atlas/app/globals.css) |

## CODE MAP
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `Home` | default component | app/page.tsx | Root shell; owns SceneState, atlas fetch, search, detail sheets |
| `AnatomyScene` | default component | app/scene.tsx | Three.js lifecycle; merged batches + per-part GPU state textures for visibility/translation/selection |
| `Atlas/Part/Concept/SceneState` | interfaces | app/anatomy.ts | Core data contracts (Part = source mesh; Concept = named group of parts) |
| `SYSTEMS` / `EXPLANATIONS` | const | app/anatomy.ts | 15 systems (color+description); per-organ copy |
| `createExplosionLayout` | fn | app/explosion-layout.ts | Packs only visible parts into non-overlapping cells |
| `decodeModelResponse` | fn | app/model-download.ts | Handles double-gzip ambiguity; verifies byte length |
| `PointerTap` | class | app/pointer-tap.ts | Per-pointer state; blocks tap on move>threshold or multitouch |
| `registerAtlasTools` | fn | app/agent-tools.ts | Registers WebMCP tools iff `document.modelContext` present |
| `cn` | fn | lib/utils.ts | clsx + tailwind-merge |

## CONVENTIONS
- **Path alias `@/*` = repo root** (tsconfig + vite alias), e.g. `@/components/ui/button`.
- **Vite root is `web/`, publicDir `public/`, output `dist/`.** Entry imports `../app/page`.
- Dense single-line style in `app/*.ts(x)` (minimal whitespace) — match it when editing those files.
- Strict TS, `moduleResolution: bundler`, `react-jsx`. No `src/`.
- Rendering is dirty-flag driven; scene mutates Three objects directly, React only passes `SceneState`.
- **CSS split (TRAP): `components/ui/*` use Tailwind utilities; product UI in [app/page.tsx](file:///Users/adithya/Documents/work/experimental/human-atlas/app/page.tsx) uses HAND-WRITTEN SEMANTIC CLASSES** (`.studio`, `.glass`, `.layers-panel`, `.detail-sheet`) all styled in [app/globals.css](file:///Users/adithya/Documents/work/experimental/human-atlas/app/globals.css). Do NOT add `sm:`/`md:` utility classes to product markup — responsive lives in `@media` blocks + `.mobile-only`/`.desktop-only` toggles.

## ANTI-PATTERNS (THIS PROJECT)
- Do NOT hand-edit `components/ui/*` as feature code — generated primitives; put product UI in `app/page.tsx`.
- Do NOT change atlas cardinality/integrity: validators hardcode 2,234 parts, 3,432 concepts, exact triangle count, unique IDs, valid indices.
- Do NOT treat drag/pinch/canceled touch as a tap (see PointerTap).
- Do NOT add per-mesh draw calls — geometry is merged into batches; state lives in GPU textures.
- Package manager is **pnpm**. Do NOT commit `package-lock.json` — use `pnpm-lock.yaml` only.

## COMMANDS
```bash
pnpm install && pnpm dev       # http://localhost:3016
pnpm check                     # tsc --noEmit
node scripts/validate-atlas.mjs
node scripts/validate-interactions.mjs
pnpm build                     # -> dist/
```
Node >=22.13. `oxfmt`/`oxlint` are installed but have NO scripts/config — run binaries directly if needed.

## NOTES
- WebMCP tools degrade silently when the browser lacks `modelContext`; visible UI must always work without them.
- Anatomy data is CC BY 4.0 (separate from MIT code) — preserve `public/ATTRIBUTION.md` when redistributing.
- `pnpm-workspace.yaml` declares no packages; repo is effectively single-package.
