import {randomUUID} from 'node:crypto';
import type {JsonValue, Pipeline, Step} from '../shared/types';

export interface StoredRun {
  pipeline: Pipeline;
  /** default sample documents users can preview against */
  samples: Record<string, JsonValue>;
}

export class RevisionConflictError extends Error {
  current: Pipeline;
  constructor(current: Pipeline) {
    super('revision_conflict');
    this.name = 'RevisionConflictError';
    this.current = current;
  }
}

class PipelineStore {
  private runs = new Map<string, StoredRun>();

  list(): {id: string; name: string; revision: number; stepCount: number; updatedAt: string}[] {
    return [...this.runs.values()].map(({pipeline}) => ({
      id: pipeline.id,
      name: pipeline.name,
      revision: pipeline.revision,
      stepCount: pipeline.steps.length,
      updatedAt: pipeline.updatedAt,
    }));
  }

  get(id: string): StoredRun | undefined {
    return this.runs.get(id);
  }

  create(name: string, steps: Step[], samples: Record<string, JsonValue>): StoredRun {
    const now = new Date().toISOString();
    const pipeline: Pipeline = {id: randomUUID(), name, revision: 1, updatedAt: now, steps};
    const run: StoredRun = {pipeline, samples};
    this.runs.set(pipeline.id, run);
    return run;
  }

  /**
   * Optimistic-concurrency update. Caller supplies the revision its edit was
   * based on; a stale revision is rejected and the current document returned.
   */
  save(id: string, expectedRevision: number, patch: {name?: string; steps?: Step[]}): Pipeline {
    const run = this.runs.get(id);
    if (!run) throw new Error('not_found');
    if (expectedRevision !== run.pipeline.revision) {
      throw new RevisionConflictError(run.pipeline);
    }
    if (patch.name !== undefined) run.pipeline.name = patch.name;
    if (patch.steps !== undefined) run.pipeline.steps = patch.steps;
    run.pipeline.revision += 1;
    run.pipeline.updatedAt = new Date().toISOString();
    return structuredClone(run.pipeline);
  }
}

export const store = new PipelineStore();

// --- seed data ------------------------------------------------------------

const legacyApiPayload: JsonValue = {
  user_id: 1042,
  full_name: 'Ada Lovelace',
  contact: 'ada@example.org;Engineering',
  primary_email: null, // explicit null — different from an absent field
  addresses: [
    {street: '12 Analytical Rd', city: 'London', zip: 'NW1'},
    {street: '88 Engine Way', city: 'Manchester', zip: 'M1'},
  ],
  tags: ['admin', 'analyst'],
  roles: [{code: 'ROLE_USER'}, {code: 'ROLE_ADMIN'}],
};

const largeSample: JsonValue = {
  batch: Array.from({length: 500}, (_, i) => ({
    id: i + 1,
    full_name: `User ${i + 1}`,
    email: `user${i + 1}@example.org`,
    active: i % 7 !== 0,
    score: (i * 13) % 100,
    meta: {source: 'legacy', nested: {region: ['eu', 'us', 'ap'][i % 3]}},
  })),
};

function step(partial: Omit<Step, 'id'>): Step {
  return {...partial, id: randomUUID()};
}

const seed: StoredRun = store.create(
  'Legacy /v1/users -> UserV2',
  [
    step({kind: 'rename', source: '$.user_id', target: '$.id'}),
    step({kind: 'move', source: '$.full_name', target: '$.profile.displayName'}),
    step({
      kind: 'split',
      source: '$.contact',
      targets: ['$.profile.email', '$.profile.department'],
      separator: ';',
      onConflict: 'overwrite',
    }),
    step({
      kind: 'compute',
      source: '$.addresses[*].zip',
      target: '$.addresses[*].postalCode',
      expression: 'upper(v)',
      onConflict: 'overwrite',
    }),
    step({
      kind: 'merge',
      sources: ['$.tags', '$.roles'],
      target: '$.entitlements',
      join: 'concat',
      onConflict: 'overwrite',
    }),
    step({
      kind: 'compute',
      source: '$.primary_email',
      target: '$.hasExplicitNullEmail',
      expression: 'isNull(v)',
      onConflict: 'overwrite',
    }),
  ],
  {sample: legacyApiPayload, large: largeSample},
);

export const seedId = seed.pipeline.id;
