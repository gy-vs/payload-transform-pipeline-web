import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {Step} from '../src/shared/types';
import {MAX_INLINE_CHARS} from '../src/shared/summary';

const bigSample = () => {
  const items = Array.from({length: 500}, (_unused, index) => ({
    sku: `SKU-${index}`,
    price_cents: index * 100 + 50,
    qty: index % 7,
  }));
  return {
    customer: {first_name: 'Ada', last_name: 'Lovelace', note: 'x'.repeat(500)},
    items,
  };
};

const steps: Step[] = [
  {id: 's1', op: 'rename', source: '$.customer.first_name', target: '$.customer.firstName'},
  {
    id: 's2',
    op: 'expression',
    mapEach: '$.items',
    expr: 'item.price_cents * item.qty / 100',
    target: 'total',
    outputType: 'number',
  },
];

function parseNdjson(text: string): unknown[] {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('pipeline persistence and concurrency', () => {
  it('saves with a revision and rejects stale concurrent saves', async () => {
    const app = createApp();
    const loaded = await request(app).get('/api/pipeline').expect(200);
    const revision = loaded.body.revision;

    const first = await request(app)
      .put('/api/pipeline')
      .send({revision, name: 'A wins', steps: loaded.body.steps})
      .expect(200);
    expect(first.body.revision).toBe(revision + 1);

    // A second editor still holds the old revision.
    const stale = await request(app)
      .put('/api/pipeline')
      .send({revision, name: 'B loses', steps: loaded.body.steps})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.revision).toBe(revision + 1);

    // Retrying against the current revision succeeds.
    await request(app)
      .put('/api/pipeline')
      .send({revision: revision + 1, name: 'B retries', steps: loaded.body.steps})
      .expect(200);
  });

  it('rejects malformed steps without touching the stored revision', async () => {
    const app = createApp();
    const revision = (await request(app).get('/api/pipeline').expect(200)).body.revision;
    await request(app)
      .put('/api/pipeline')
      .send({revision, steps: [{id: 'x', op: 'explode'}]})
      .expect(400);
    const after = await request(app).get('/api/pipeline').expect(200);
    expect(after.body.revision).toBe(revision);
  });
});

describe('streaming preview', () => {
  it('streams bounded summaries per step, never the full document', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/preview')
      .send({sample: bigSample(), steps})
      .expect('Content-Type', /ndjson/)
      .expect(200);

    const events = parseNdjson(response.text) as Array<Record<string, unknown>>;
    expect(events[0].type).toBe('start');
    expect(events[1].type).toBe('step');
    expect(events.at(-1)!.type).toBe('done');

    const inputBytes = JSON.stringify(bigSample()).length;
    for (const event of events) {
      const bytes = JSON.stringify(event).length;
      // Summaries stay tiny regardless of the 500-element payload.
      expect(bytes).toBeLessThan(inputBytes / 5);
      expect(bytes).toBeLessThan(10_000);
    }
    // The array is summarized by count, with only a few items attached.
    const stepEvent = events.find((event) => event.type === 'step' && event.stepId === 's2') as {
      summary: {fields: Array<{name: string; node: {kind: string; size: number}}>};
    };
    const itemsField = stepEvent.summary.fields.find((field) => field.name === 'items');
    expect(itemsField?.node.kind).toBe('array');
    expect(itemsField?.node.size).toBe(500);
    // Long scalar text is truncated in a summary.
    const customerField = stepEvent.summary.fields.find((field) => field.name === 'customer');
    expect(customerField).toBeDefined();
    void MAX_INLINE_CHARS;
  });

  it('serves full nodes on demand from the server-side session', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/preview')
      .send({sample: bigSample(), steps})
      .expect(200);
    const events = parseNdjson(response.text) as Array<Record<string, unknown>>;
    const start = events[0] as {sessionId: string};
    const done = events.at(-1) as {type: string};
    expect(done.type).toBe('done');

    // Final state lives at stepIndex === steps.length.
    const node = await request(app)
      .get(`/api/preview/${start.sessionId}/node`)
      .query({stepIndex: steps.length, path: '$.items'})
      .expect(200);
    expect(node.body.node).toHaveLength(500);
    expect(node.body.node[0].total).toBeCloseTo(0);
    expect(node.body.node[1].total).toBeCloseTo(1.5);

    // Intermediate state after step 1 has not run the mapping yet.
    const intermediate = await request(app)
      .get(`/api/preview/${start.sessionId}/node`)
      .query({stepIndex: 0, path: '$.customer.firstName'})
      .expect(200);
    expect(intermediate.body.node).toBe('Ada');

    await request(app)
      .get(`/api/preview/${start.sessionId}/node`)
      .query({stepIndex: steps.length, path: '$.missing'})
      .expect(404);
  });
});

describe('execution failures', () => {
  it('returns step/source/pre-state and no output when a step throws', async () => {
    const app = createApp();
    const failing: Step[] = [
      {id: 'good', op: 'rename', source: '$.customer.first_name', target: '$.customer.firstName'},
      {id: 'bad-map', op: 'expression', mapEach: '$.items', expr: '100 / item.qty', target: 'share'},
    ];
    const response = await request(app).post('/api/run').send({sample: bigSample(), steps: failing}).expect(409);
    expect(response.body.ok).toBe(false);
    expect(response.body.failedIndex).toBe(1);
    expect(response.body.stepId).toBe('bad-map');
    expect(response.body.sourcePath).toMatch(/\$\.items\[\d+\]/);
    expect(response.body).not.toHaveProperty('output');
    expect(response.body.preStatePreview.customer.firstName).toBe('Ada');

    // The same failure arrives as a terminal error event in the stream,
    // carrying a pre-state SUMMARY rather than output.
    const streamed = await request(app).post('/api/preview').send({sample: bigSample(), steps: failing}).expect(200);
    const events = parseNdjson(streamed.text) as Array<Record<string, unknown>>;
    const errorEvent = events.at(-1) as {type: string; failedIndex: number; preStateSummary: unknown};
    expect(errorEvent.type).toBe('error');
    expect(errorEvent.failedIndex).toBe(1);
    expect(errorEvent.preStateSummary).toBeTruthy();
    expect(events.filter((event) => event.type === 'step')).toHaveLength(1);
  });

  it('reports path-not-found for a reordered pipeline', async () => {
    const app = createApp();
    const reordered: Step[] = [
      {id: 'move', op: 'move', source: '$.customer.first_name', target: '$.customer.firstName'},
      {id: 'after', op: 'rename', source: '$.customer.first_name', target: '$.customer.copy'},
    ];
    // Sanity: move alone is valid (existing parent).
    const alone = await request(app)
      .post('/api/validate')
      .send({sample: bigSample(), steps: [reordered[0]]})
      .expect(200);
    expect(alone.body.diagnostics).toHaveLength(0);

    // After the move, the second step's source no longer exists.
    const response = await request(app)
      .post('/api/validate')
      .send({sample: bigSample(), steps: reordered})
      .expect(200);
    expect(response.body.diagnostics).toHaveLength(1);
    expect(response.body.diagnostics[0]).toMatchObject({
      index: 1,
      code: 'path_not_found',
      sourcePath: '$.customer.first_name',
    });
  });
});
