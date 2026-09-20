# Payload Migration Workbench

Convert legacy API payloads to a new schema with a pipeline of **rename,
move, split, merge and expression** steps. Steps are composed in a
drag-and-drop list, validated against the sample after every reorder, and
previewed one step at a time.

## Run

```bash
npm install
npm run dev      # API on :4174, Vite UI on :4173 (proxied)
npm test         # vitest: engine, expressions, HTTP API, stream guard
npm run build    # tsc --noEmit + vite build
npm start        # API only
```

## How the requirements map to the code

### Steps and atomic execution — `src/shared/engine.ts`, `src/shared/path.ts`
- Five step kinds: `rename`, `move`, `split`, `merge` (`join` / `concat` /
  `deep`), `expression` (optionally `mapEach` an array).
- Each step reads everything first, validates all targets, and only then
  mutates. The preview runner additionally executes every step on a clone
  (`src/server/preview.ts`), so a mid-step exception discards all partial
  changes — the document stays at the previous step.
- A failed run returns `failedIndex`, `stepId`, `code`, a concrete
  `sourcePath`, and a diagnostic `preState` / `preStateSummary`. There is
  never an `output` on failure (the `PipelineResult` type enforces this).
- Paths are `$.a.b[0].c` with one wildcard level, `$.items[*].sku`, for
  array element mapping. Missing (`path_not_found`, unless `optional`) is
  distinct from an explicit `null`, which is a real value that flows
  through expressions and merge.
- Expressions use a sandboxed hand-written lexer/parser
  (`src/shared/expr.ts`) — no `eval` / `Function` — with a whitelisted scope
  (`item`, `index`, named inputs, `$`) and builtins
  (`upper`, `lower`, `trim`, `coalesce`, `concat`, `round`, …). Divide-by-
  zero and other expression errors fail the step with the element path.

### Reordering and re-validation — `src/shared/shape.ts`
- After every edit or drag, the whole ordering is replayed over a type-only
  shape inferred from the sample. A step whose path existed before but was
  moved/removed by an earlier step is flagged at **its** index, even though
  its configuration never changed. The same code runs in the browser
  (instant diagnostics) and on the server (`POST /api/validate`).

### Stale preview protection — `src/client/api.ts`
- Every preview run gets a monotonic generation and an `AbortController`.
- Starting a new run (e.g. after reordering) aborts the in-flight request,
  and events from older generations are dropped before any React state
  update, so an old order can never overwrite the new preview. Covered by
  `test/client-stream.test.ts`.

### Optimistic concurrency — `src/server/index.ts`
- The pipeline is stored with a numeric `revision`. `PUT /api/pipeline`
  must echo the base revision; a stale writer gets `409 revision_conflict`
  with the current document and can retry against the new revision.
  Malformed bodies return `400` without bumping the revision.

### Streaming summaries, not full copies — `src/shared/summary.ts`, `preview.ts`
- `POST /api/preview` streams NDJSON: `start`, one bounded `step` event per
  step (type tags, counts, short scalar previews), then `done` / `error`.
- Every intermediate state is kept only in a server-side session
  (TTL / eviction bounded). The UI shows summaries and fetches exactly one
  full node on demand via
  `GET /api/preview/:sessionId/node?stepIndex=&path=`
  (`stepIndex`: `-1` input, `i` after step `i`, `N` final output). The
  browser never receives a full-document copy per step — asserted in
  `test/api.test.ts` against a 500-element sample.

## Layout

```
src/shared/   types, paths, expression evaluator, engine, shape replay, summaries
src/server/   express app + server-side preview sessions
src/client/   React workbench, step editors, streaming preview, node expansion
seed/         sample payload
test/         engine, expressions, HTTP/streaming API, client generation guard
```
