import express from 'express';
import {fileURLToPath} from 'node:url';
import {store, RevisionConflictError, seedId} from './store';
import {validatePipeline} from '../shared/validate';
import {startStream, expandNode} from './execute';
import type {JsonValue, Step} from '../shared/types';

export function createApp(){
  const app = express();
  app.use(express.json({limit:'25mb'}));

  app.get('/api/health', (_req, res) => res.json({ok: true}));

  app.get('/api/pipelines', (_req, res) => {
    res.json(store.list());
  });

  app.get('/api/pipelines/:id', (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({error: 'not_found'});
    res.set('ETag', `"${run.pipeline.revision}"`);
    res.json({...run.pipeline, samples: run.samples});
  });

  app.post('/api/pipelines', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : 'Untitled pipeline';
    const steps = sanitizeSteps(req.body?.steps ?? []);
    const samples = sanitizeSamples(req.body?.samples);
    const created = store.create(name, steps, samples);
    res.status(201).json(created.pipeline);
  });

  app.put('/api/pipelines/:id', (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({error: 'not_found'});
    const expected = Number(req.body?.revision);
    if (!Number.isInteger(expected)) {
      return res.status(400).json({error: 'revision_required'});
    }
    try {
      const updated = store.save(req.params.id, expected, {
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        steps: req.body?.steps !== undefined ? sanitizeSteps(req.body.steps) : undefined,
      });
      res.set('ETag', `"${updated.revision}"`);
      res.json(updated);
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        return res.status(409).json({
          error: 'revision_conflict',
          message: `saved by another writer at revision ${err.current.revision}`,
          current: err.current,
        });
      }
      throw err;
    }
  });

  app.post('/api/pipelines/:id/validate', (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({error: 'not_found'});
    const steps = sanitizeSteps(req.body?.steps ?? run.pipeline.steps);
    const sample: JsonValue | null =
      req.body?.sample !== undefined ? req.body.sample as JsonValue :
      run.samples.sample ?? null;
    const diagnostics = validatePipeline(steps, sample);
    res.json({ok: diagnostics.length === 0, revision: run.pipeline.revision, diagnostics});
  });

  // Streaming preview: SSE carries one shallow summary per step, never full trees.
  app.post('/api/pipelines/:id/execute', async (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({error: 'not_found'});

    // If the client pins a revision, a concurrently-saved pipeline refuses to
    // run stale steps instead of silently previewing the wrong configuration.
    if (req.body?.revision !== undefined && Number(req.body.revision) !== run.pipeline.revision) {
      return res.status(409).json({
        error: 'revision_conflict',
        currentRevision: run.pipeline.revision,
      });
    }

    const steps = sanitizeSteps(req.body?.steps ?? run.pipeline.steps);
    const sampleName = typeof req.body?.sample === 'string' ? req.body.sample : 'sample';
    const input: JsonValue =
      req.body?.input !== undefined ? req.body.input as JsonValue :
      run.samples[sampleName] ?? run.samples.sample ?? {};

    try {
      await startStream(res, input, steps);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({error: 'execution_failed', message: String(err)});
    }
  });

  // Lazy node expansion for the streamed timeline.
  app.get('/api/executions/:executionId/nodes', (req, res) => {
    const afterStep = Number(req.query.afterStep ?? -1);
    const path = typeof req.query.path === 'string' ? req.query.path : '$';
    if (!Number.isInteger(afterStep)) return res.status(400).json({error: 'bad_afterStep'});
    const result = expandNode(req.params.executionId, afterStep, path);
    res.status(result.status).json(result.body);
  });

  return app;
}

function sanitizeSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s, i) => ({
      id: typeof s.id === 'string' && s.id ? s.id : `step-${i}-${Math.random().toString(36).slice(2, 8)}`,
      kind: s.kind as Step['kind'],
      description: typeof s.description === 'string' ? s.description : undefined,
      source: typeof s.source === 'string' ? s.source : undefined,
      target: typeof s.target === 'string' ? s.target : undefined,
      sources: Array.isArray(s.sources) ? s.sources.filter((x): x is string => typeof x === 'string') : undefined,
      targets: Array.isArray(s.targets) ? s.targets.filter((x): x is string => typeof x === 'string') : undefined,
      expression: typeof s.expression === 'string' ? s.expression : undefined,
      separator: typeof s.separator === 'string' ? s.separator : undefined,
      join: s.join === 'concat' || s.join === 'object' || s.join === 'join' ? s.join : undefined,
      deleteSource: typeof s.deleteSource === 'boolean' ? s.deleteSource : undefined,
      ignoreMissing: typeof s.ignoreMissing === 'boolean' ? s.ignoreMissing : undefined,
      onConflict:
        s.onConflict === 'skip' || s.onConflict === 'error' || s.onConflict === 'overwrite'
          ? s.onConflict
          : 'overwrite',
    }))
    .map(stripUndefined) as Step[];
}

function stripUndefined<T extends object>(obj: T): T {
  for (const k of Object.keys(obj)) {
    if ((obj as Record<string, unknown>)[k] === undefined) delete (obj as Record<string, unknown>)[k];
  }
  return obj;
}

function sanitizeSamples(raw: unknown): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      try {
        out[k] = JSON.parse(JSON.stringify(v)) as JsonValue;
      } catch { /* skip non-JSON sample */ }
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => {
    console.log('server http://127.0.0.1:4174');
    console.log(`seed pipeline: /api/pipelines/${seedId}`);
  });
}
