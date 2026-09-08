# SCRIPTS — OFFLINE ASSET PIPELINE + VALIDATORS

Node `.mjs` (ESM) + one Python converter. Run from repo root. Not bundled, not shipped.

## PIPELINE ORDER (rebuild geometry — optional; browser-ready output is committed)
```
node convert-anatomy.mjs OBJ_DIR CONCEPT_MAP [SYSTEM_MAP]   # OBJ -> atlas.json + anatomy-*.bin
node optimize-anatomy.mjs [atlas.json]                       # meshopt simplify, 0.2% rel error; re-chunks to body-*.bin; sets manifest.optimized
node compress-models.mjs                                     # gzip -9 each chunk -> *.bin.gz; writes gzip/gzipBytes into atlas.json
```

## VALIDATORS (the test suite — no runner, no `*.test.*`)
```
node validate-atlas.mjs [atlas.json]        # data/integrity: cardinality, unique ids, buffer lengths, triangle sum
node validate-interactions.mjs              # imports app/*.ts directly; layout non-overlap + search/inspect/tap contracts
```

## CONVENTIONS
- Node `assert/strict` only (`assert.equal/ok/throws`). Import production TS from `../app/*` directly — no mocks/fixtures beyond `public/models/atlas.json`.
- All read/write via `new URL('../public/models/', import.meta.url)`.

## ANTI-PATTERNS
- Do NOT relax hardcoded invariants in `validate-atlas.mjs` (2,234 parts, 3,432 concepts, exact triangle count) — they gate atlas integrity.
- Do NOT re-run `optimize-anatomy.mjs` on already-optimized output (guarded by `manifest.optimized` — re-run converter first).
- `female`/HRA branch in optimize welds duplicate verts; `body` (BodyParts3D) path does NOT — keep them separate.
- Coordinate transform (`x*.001, z*.001+.0781112, -y*.001-.1`) lives ONLY in the converter — never re-apply downstream.
