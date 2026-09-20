// HTTP layer: pipeline persistence with optimistic revision control,
// NDJSON streaming previews (summaries only), and on-demand node expansion.

import express from 'express';
import {fileURLToPath} from 'node:url';
import {runPipeline} from '../shared/engine';
import {validateSteps} from '../shared/shape';
import {JsonValue, PipelineDoc, Step} from '../shared/types';
import {PreviewManager, runPreview} from './preview';

// --- seed data --------------------------------------------------------------

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

function seedSample(): JsonValue {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', '..', 'seed', 'sample.json'), 'utf-8')) as JsonValue;
  } catch {
    return {
      user: {first_name: 'Ada', last_name: 'Lovelace', age: '36'},
      tags: 'analyst,engineer',
      items: [
        {sku: 'A-1', price_cents: 1999},
        {sku: 'B-2', price_cents: 450},
      ],
    };
  }
}

function seedPipeline(): PipelineDoc {
  const steps: Step[] = [
    {id: 's1', op: 'rename', source: '$.customer.first_name', target: '$.customer.firstName'},
    {id: 's2', op: 'rename', source: '$.customer.last_name', target: '$.customer.lastName'},
    {
      id: 's3',
      op: 'split',
      source: '$.tags',
      delimiter: ',',
      targets: ['$.tagList[0]', '$.tagList[1]', '$.tagList[2]'],
      keepSource: false,
    },
    {
      id: 's4',
      op: 'expression',
      mapEach: '$.items',
      expr: 'item.price_cents * item.qty / 100',
      target: 'lineTotal',
      outputType: 'number',
    },
    {
      id: 's5',
      op: 'merge',
      sources: ['$.customer.firstName', '$.customer.lastName'],
      target: '$.customer.displayName',
      strategy: 'join',
      joiner: ' ',
    },
  ];
  return {
    id: 'default',
    name: 'Legacy order payload v1 -> v2',
    steps,
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
}

// --- validation -------------------------------------------------------------

const OPS = new Set(['rename', 'move', 'split', 'merge', 'expression']);

export function validateStepShape(step: unknown, index: number): string | null {
  if (!step || typeof step !== 'object') return `step ${index} is not an object`;
  const candidate = step as {id?: unknown; op?: unknown};
  if (typeof candidate.id !== 'string' || !candidate.id) return `step ${index} is missing an id`;
  if (typeof candidate.op !== 'string' || !OPS.has(candidate.op)) {
    return `step ${index} has invalid op`;
  }
  const s = step as Record<string, unknown>;
  const pathsToCheck: unknown[] =
    candidate.op === 'merge'
      ? ['target', ...(Array.isArray(s.sources) ? (s.sources as unknown[]) : [])].flatMap((field) =>
          field === 'target' ? [s.target] : [field]
        )
      : candidate.op === 'split'
        ? [s.source, ...(Array.isArray(s.targets) ? (s.targets as unknown[]) : [])]
        : candidate.op === 'expression'
          ? [s.mapEach, ...Object.values((s.inputs as Record<string, unknown>) ?? {}), s.mapEach ? null : s.target]
          : [s.source, s.target];
  for (const field of pathsToCheck) {
    if (field === null || field === undefined) continue;
    if (typeof field !== 'string' || !field.startsWith('$')) {
      return `step ${index} (${candidate.id}) has a non-string or non-absolute path`;
    }
  }
  return null;
}

function validatePipelineBody(body: unknown): {steps?: Step[]; name?: unknown; revision?: unknown} | string {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const candidate = body as {steps?: unknown; name?: unknown; revision?: unknown};
  if (candidate.name !== undefined && typeof candidate.name !== 'string') return 'name must be a string';
  if (!Array.isArray(candidate.steps)) return 'steps must be an array';
  candidate.steps.forEach((step, index) => {
    const problem = validateStepShape(step, index);
    if (problem) throw new Error(problem);
  });
  return candidate as {steps: Step[]; name?: unknown; revision?: unknown};
}

// --- app --------------------------------------------------------------------

export function createApp(initial?: PipelineDoc) {
  const app = express();
  app.use(express.json({limit: '10mb'}));

  let pipeline: PipelineDoc = initial ?? seedPipeline();
  const sample: JsonValue = seedSample();
  const previewManager = new PreviewManager();

  app.get('/api/sample', (_req, res) => res.json(sample));

  app.get('/api/pipeline', (_req, res) => res.json(pipeline));

  // Optimistic concurrency: the client must echo the revision it edited.
  app.put('/api/pipeline', (req, res) => {
    let parsed: ReturnType<typeof validatePipelineBody>;
    try {
      parsed = validatePipelineBody(req.body);
    } catch (error) {
      return res.status(400).json({error: 'invalid_body', message: (error as Error).message});
    }
    if (typeof parsed === 'string') return res.status(400).json({error: 'invalid_body', message: parsed});
    if (typeof parsed.revision !== 'number') {
      return res.status(400).json({error: 'invalid_body', message: 'revision is required'});
    }
    if (parsed.revision !== pipeline.revision) {
      return res.status(409).json({
        error: 'revision_conflict',
        message: `pipeline is at revision ${pipeline.revision}, your edit was based on ${parsed.revision}`,
        current: pipeline,
      });
    }
    pipeline = {
      ...pipeline,
      name: typeof parsed.name === 'string' ? parsed.name : pipeline.name,
      steps: parsed.steps as Step[],
      revision: pipeline.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    return res.json(pipeline);
  });

  // Static diagnostics for a candidate ordering without persisting it.
  app.post('/api/validate', (req, res) => {
    const steps = Array.isArray(req.body?.steps) ? (req.body.steps as Step[]) : null;
    if (!steps) return res.status(400).json({error: 'invalid_body', message: 'steps are required'});
    return res.json({diagnostics: validateSteps(req.body.sample ?? sample, steps)});
  });

  // Non-streaming execute: full output only on success; on failure return the
  // failed step/source plus a pre-state SNAPSHOT marked as diagnostic.
  app.post('/api/run', (req, res) => {
    const steps = Array.isArray(req.body?.steps) ? (req.body.steps as Step[]) : pipeline.steps;
    const result = runPipeline((req.body?.sample ?? sample) as JsonValue, steps);
    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        failedIndex: result.failedIndex,
        stepId: result.stepId,
        code: result.code,
        message: result.message,
        sourcePath: result.sourcePath,
        // Diagnostic only — there is intentionally no `output` field.
        preStatePreview: result.preState,
      });
    }
    return res.json({ok: true, output: result.output});
  });

  // Streaming preview: one NDJSON event per step, summaries only.
  app.post('/api/preview', async (req, res) => {
    const steps = Array.isArray(req.body?.steps) ? (req.body.steps as Step[]) : pipeline.steps;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const write = (event: unknown) => {
      res.write(JSON.stringify(event) + '\n');
    };
    let closed = false;
    // `res` 'close' fires when the client actually goes away. Listening on
    // `req` would abort immediately in Express 5 once the body is consumed.
    res.on('close', () => {
      if (!res.writableEnded) closed = true;
    });

    try {
      await runPreview(previewManager, (req.body?.sample ?? sample) as JsonValue, steps, {
        onEvent: write,
        delayMs: 5,
        signal: {get aborted() { return closed; }},
      });
    } catch (error) {
      write({type: 'error', failedIndex: -1, stepId: '', code: 'invalid_step', message: (error as Error).message, sourcePath: null});
    }
    res.end();
  });

  // On-demand expansion of ONE node in ONE intermediate state.
  app.get('/api/preview/:sessionId/node', (req, res) => {
    const stepIndex = Number(req.query.stepIndex);
    const path = String(req.query.path ?? '$');
    if (!Number.isInteger(stepIndex) || stepIndex < -1) {
      return res.status(400).json({error: 'invalid_body', message: 'stepIndex must be -1 (input) or a non-negative integer'});
    }
    const node = previewManager.getNode(req.params.sessionId, stepIndex, path);
    if (node === undefined) return res.status(404).json({error: 'not_found', message: 'session, step or path not found'});
    return res.json({stepIndex, path, node});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
