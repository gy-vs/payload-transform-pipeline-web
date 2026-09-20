import {randomUUID} from 'node:crypto';
import type {Response} from 'express';
import {runPipeline} from '../shared/engine';
import {get, isMissing, parsePath} from '../shared/path';
import type {JsonValue, Step, StepResult, StreamEvent} from '../shared/types';

interface Session {
  input: JsonValue;
  steps: Step[];
  /** summaries that already streamed (small); full trees are NOT retained */
  results: StepResult[];
  status: 'running' | 'done' | 'error';
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  // Sessions are pure data (no per-session timers); periodic TTL pruning
  // keeps memory bounded for large-sample previews.
  sessions.clear();
}, SESSION_TTL_MS).unref();

const STEP_DELAY_MS = 120; // pace streaming so the UI renders progressively

export async function startStream(
  res: Response,
  input: JsonValue,
  steps: Step[],
): Promise<void> {
  const executionId = randomUUID();
  const session: Session = {input, steps, results: [], status: 'running'};
  sessions.set(executionId, session);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: StreamEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({type: 'start', executionId, totalSteps: steps.length});

  let working: JsonValue = structuredClone(input);
  for (let index = 0; index < steps.length; index++) {
    if (res.writableEnded || res.destroyed) {
      session.status = 'error';
      sessions.delete(executionId);
      return;
    }
    // Each step is run against the working document from the previous frame;
    // the single-step result's local index (always 0) is rewritten to the
    // global pipeline index so error events point at the right step.
    const result = runPipeline(working, [steps[index]!]);
    if (result.status === 'error') {
      session.status = 'error';
      send({type: 'error', ...result.error, index});
      res.end();
      return;
    }
    // Streamed payload is a shallow summary only — never the whole tree.
    working = result.output;
    const summary: StepResult = {...result.results[0]!, index};
    session.results.push(summary);
    send({type: 'step', ...summary});
    await new Promise(r => setTimeout(r, STEP_DELAY_MS));
  }

  session.status = 'done';
  send({type: 'done', executionId});
  res.end();
}

const MAX_NODE_NODES = 5000;
const MAX_NODE_DEPTH = 8;

/**
 * Expand a single node on demand. Replays stored steps up to `afterStep`
 * against the original input — the server never kept full per-step copies.
 * Returned subtree is bounded so a huge branch cannot flood the browser.
 */
export function expandNode(
  executionId: string,
  afterStep: number,
  path: string,
): {status: number; body: unknown} {
  const session = sessions.get(executionId);
  if (!session) return {status: 404, body: {error: 'execution_not_found'}};
  if (afterStep < -1 || afterStep >= session.steps.length) {
    return {status: 400, body: {error: 'bad_step_index'}};
  }
  let segs;
  try {
    segs = parsePath(path);
  } catch {
    return {status: 400, body: {error: 'bad_path', path}};
  }

  const run = runPipeline(session.input, session.steps.slice(0, afterStep + 1));
  if (run.status === 'error') {
    // The requested step boundary is beyond the last successful step.
    return {status: 409, body: {error: 'step_failed', failure: run.error}};
  }
  const doc = run.output;

  const found = get(doc, segs);
  if (isMissing(found)) {
    return {status: 200, body: {executionId, afterStep, path, state: 'missing'}};
  }

  let nodes = 0;
  let truncated = false;
  const bound = (v: JsonValue, depth: number): JsonValue => {
    nodes++;
    if (nodes > MAX_NODE_NODES || depth > MAX_NODE_DEPTH) {
      truncated = true;
      if (Array.isArray(v)) return [`… ${v.length - (nodes - 1)} elements truncated …` as unknown as JsonValue];
      if (typeof v === 'object' && v !== null) return {_truncated: true};
      return v;
    }
    if (Array.isArray(v)) return v.map(el => bound(el, depth + 1));
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, JsonValue> = {};
      for (const [k, child] of Object.entries(v)) out[k] = bound(child, depth + 1);
      return out;
    }
    return v;
  };
  return {
    status: 200,
    body: {
      executionId,
      afterStep,
      path,
      state: 'value',
      value: bound(found, 0),
      truncated,
    },
  };
}
