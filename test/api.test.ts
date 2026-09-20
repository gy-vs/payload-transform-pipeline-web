import {Buffer} from 'node:buffer';
import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import type {JsonValue, Step, StreamEvent} from '../src/shared/types';

let seq = 0;
const sid = () => `t${seq++}`;
const step = (s: Omit<Step, 'id'>): Step => ({id: sid(), onConflict: 'overwrite', ...s});

// Fixed ids so the steps used for assertions and the copies sent in the
// create() request refer to the same pipeline definition.
const SEED_IDS = ['rename-user', 'move-name', 'rename-missing', 'compute-postal'];
const sstep = (i: number, s: Omit<Step, 'id'>): Step => ({id: SEED_IDS[i]!, onConflict: 'overwrite', ...s});

const seedSteps = (): Step[] => [
  sstep(0, {kind: 'rename', source: '$.user_id', target: '$.id'}),
  sstep(1, {kind: 'move', source: '$.full_name', target: '$.profile.name'}),
  // fails here: the compute below created postalCode, not a name to rename —
  // path references must resolve against what preceding steps produced.
  sstep(2, {kind: 'rename', source: '$.profile.displayName', target: '$.profile.label'}),
  sstep(3, {
    kind: 'compute',
    source: '$.addresses[*].zip',
    target: '$.addresses[*].postalCode',
    expression: 'upper(v)',
  }),
];

const seedInput: JsonValue = {
  user_id: 7, full_name: 'Grace',
  addresses: [{zip: 'ab1'}, {zip: 'cd2'}],
};

async function createPipeline(app: ReturnType<typeof createApp>, steps = seedSteps()) {
  const res = await request(app)
    .post('/api/pipelines')
    .send({name: 'test pipeline', steps, samples: {sample: seedInput}})
    .expect(201);
  return res.body.id as string;
}

function parseSSE(buf: Buffer): StreamEvent[] {
  return buf.toString('utf8')
    .split('\n\n')
    .map(chunk => chunk.split('\n').find(l => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map(l => JSON.parse(l.slice(6)) as StreamEvent);
}

describe('pipeline HTTP API', () => {
  it('optimistic concurrency: stale revision save is rejected with 409 and current doc', async () => {
    const app = createApp();
    const id = await createPipeline(app);
    const first = await request(app).put(`/api/pipelines/${id}`)
      .send({revision: 1, name: 'writer A'}).expect(200);
    expect(first.body.revision).toBe(2);

    const stale = await request(app).put(`/api/pipelines/${id}`)
      .send({revision: 1, name: 'writer B'}).expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.revision).toBe(2);
    expect(stale.body.current.name).toBe('writer A');

    // retrying on the returned revision succeeds
    await request(app).put(`/api/pipelines/${id}`)
      .send({revision: 2, name: 'writer B'}).expect(200);
  });

  it('streams one shallow summary per step, then an error event — no full trees in frames', async () => {
    const app = createApp();
    const id = await createPipeline(app);
    const res = await request(app)
      .post(`/api/pipelines/${id}/execute`)
      .send({sample: 'sample'})
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSSE(res.body as Buffer);
    expect(events[0]).toMatchObject({type: 'start', totalSteps: 4});
    const steps = events.filter(e => e.type === 'step');
    expect(steps).toHaveLength(2);
    for (const e of steps) {
      if (e.type !== 'step') continue;
      // frame carries only a root summary + change list, never the document
      expect(JSON.stringify(e.after)).not.toContain('Grace');
      expect(e.after.kind === 'object' ? e.after.fieldCount : 0).toBeGreaterThan(0);
    }

    const error = events.find(e => e.type === 'error');
    expect(error).toMatchObject({type: 'error', index: 2, code: 'missing_source'});
    // done must never follow an error — partial result is not a final output
    expect(events.some(e => e.type === 'done')).toBe(false);
  });
  it('serves full nodes on demand via the node endpoint, with missing-vs-null semantics', async () => {
    const app = createApp();
    const goodSteps = [seedSteps()[0]!, seedSteps()[1]!, seedSteps()[3]!];
    const id = await createPipeline(app, goodSteps);

    const exec = await request(app)
      .post(`/api/pipelines/${id}/execute`)
      .send({sample: 'sample'})
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const events = parseSSE(exec.body as Buffer);
    const executionId = (events[0] as {executionId: string}).executionId;

    const root = await request(app)
      .get(`/api/executions/${executionId}/nodes?afterStep=2&path=$`)
      .expect(200);
    expect(root.body.state).toBe('value');
    expect(root.body.value.addresses[0].postalCode).toBe('AB1');

    const missing = await request(app)
      .get(`/api/executions/${executionId}/nodes?afterStep=2&path=$.notHere`)
      .expect(200);
    expect(missing.body.state).toBe('missing');

    // a step boundary that failed (>= steps length for a failed run) returns 409
    await request(app)
      .get(`/api/executions/${executionId}/nodes?afterStep=9&path=$`)
      .expect(400);
  });

  it('refuses to execute steps pinned to a stale revision after a concurrent save', async () => {
    const app = createApp();
    const id = await createPipeline(app);
    await request(app).put(`/api/pipelines/${id}`)
      .send({revision: 1, name: 'changed'}).expect(200);
    await request(app)
      .post(`/api/pipelines/${id}/execute`)
      .send({revision: 1, sample: 'sample'})
      .expect(409);
  });

  it('large sample frames stay small even though the document is big', async () => {
    const app = createApp();
    const steps = [
      step({
        kind: 'compute',
        source: '$.batch[*].email',
        target: '$.batch[*].emailUpper',
        expression: 'upper(v)',
      }),
    ];
    const id = await createPipeline(app, steps);
    const big: JsonValue = {batch: Array.from({length: 500}, (_, i) => ({
      email: `u${i}@example.org`,
    }))};

    const res = await request(app)
      .post(`/api/pipelines/${id}/execute`)
      .send({input: big})
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const events = parseSSE(res.body as Buffer);
    const stepEvent = events.find(e => e.type === 'step');
    expect(stepEvent?.type).toBe('step');
    if (stepEvent?.type !== 'step') return;
    // root stays an object; the streamed summary only names the top fields
    expect(stepEvent.after.kind).toBe('object');
    if (stepEvent.after.kind !== 'object') return;
    expect(stepEvent.after.fields.some(f => f.name === 'batch' && f.type === 'array')).toBe(true);
    expect(stepEvent.changes).toHaveLength(500);
    // 500 mapped elements produce 500 changes, but the frame is still compact:
    // it must not embed a single email address (no full-node copying)
    const raw = (res.body as Buffer).toString('utf8');
    expect(raw).not.toContain('u499@example.org');
    expect(Buffer.byteLength(raw)).toBeLessThan(40_000);

    // expanding one specific element lazily returns just that subtree
    const done = events.find(e => e.type === 'done') as {executionId: string};
    const node = await request(app)
      .get(`/api/executions/${done.executionId}/nodes?afterStep=0&path=$.batch[499]`)
      .expect(200);
    expect(node.body.value.emailUpper).toBe('U499@EXAMPLE.ORG');
  });
});
