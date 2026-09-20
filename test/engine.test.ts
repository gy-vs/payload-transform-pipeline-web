import {describe, expect, it} from 'vitest';
import {runPipeline} from '../src/shared/engine';
import {validateSteps} from '../src/shared/shape';
import {JsonValue, Step} from '../src/shared/types';

const sample: JsonValue = {
  user: {first_name: 'Ada', last_name: 'Lovelace', title: null},
  tags: 'a,b,c',
  items: [
    {price_cents: 1999, qty: 2},
    {price_cents: 450, qty: 1},
    {price_cents: 100, qty: 5},
  ],
  shipping: {city: 'London'},
};

function run(input: JsonValue, steps: Step[]) {
  return runPipeline(input, steps);
}

const obj = (value: JsonValue): Record<string, any> => value as unknown as Record<string, any>;

describe('rename / move', () => {
  it('renames a field and removes the source', () => {
    const result = run(sample, [{id: '1', op: 'rename', source: '$.user.first_name', target: '$.user.firstName'}]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(obj(result.output).user).toEqual({firstName: 'Ada', last_name: 'Lovelace', title: null});
  });

  it('moves a field between containers', () => {
    const result = run(sample, [{id: '1', op: 'move', source: '$.shipping.city', target: '$.shipCity'}]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(obj(result.output).shipping).toEqual({});
    expect(obj(result.output).shipCity).toBe('London');
  });

  it('refuses an existing target unless overwrite is set', () => {
    const clash = run(sample, [
      {id: '1', op: 'rename', source: '$.user.first_name', target: '$.user.last_name'},
    ]);
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.code).toBe('target_exists');
    expect(clash.sourcePath).toBe('$.user.last_name');
    // And the input is untouched: failure carries only the pre-state.
    expect(obj(clash.preState).user.first_name).toBe('Ada');
    expect(obj(clash.preState).user.last_name).toBe('Lovelace');

    const forced = run(sample, [
      {id: '1', op: 'rename', source: '$.user.first_name', target: '$.user.last_name', overwrite: true},
    ]);
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(obj(forced.output).user.last_name).toBe('Ada');
    expect(obj(forced.output).user.first_name).toBeUndefined();
  });
});

describe('array element mapping', () => {
  it('maps each element with item/index in scope and writes a relative field', () => {
    const result = run(sample, [
      {
        id: '1',
        op: 'expression',
        mapEach: '$.items',
        expr: 'item.price_cents * item.qty / 100',
        target: 'total',
        outputType: 'number',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((obj(result.output).items as Array<Record<string, number>>).map((item) => item.total)).toEqual([39.98, 4.5, 5]);
    // Expression adds the computed field and preserves the source fields.
    expect(obj(result.output).items[0]).toMatchObject({price_cents: 1999, total: 39.98});
  });

  it('renames a field on every array element via wildcard', () => {
    const result = run(sample, [
      {id: '1', op: 'rename', source: '$.items[*].price_cents', target: '$.items[*].priceCents'},
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(obj(result.output).items[0]).toMatchObject({priceCents: 1999});
    expect(obj(result.output).items[0]).not.toHaveProperty('price_cents');
  });

  it('is atomic when one element expression throws', () => {
    const bad: JsonValue = {items: [{n: 10}, {n: 0}]};
    const result = run(bad, [
      {id: '1', op: 'expression', mapEach: '$.items', expr: '100 / item.n', target: 'share'},
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedIndex).toBe(0);
    expect(result.sourcePath).toBe('$.items[1]');
    // No partial output: element 0 was not mutated either.
    expect(result.preState).toEqual(bad);
  });
});

describe('missing vs null', () => {
  it('treats null as a real value and absence as missing', () => {
    // Null exists: merging over it hits target_exists logic downstream;
    // here null flows through an expression unchanged.
    const result = run(sample, [
      {id: '1', op: 'expression', expr: 't', inputs: {t: '$.user.title'}, target: '$.user.salutation'},
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(obj(result.output).user.salutation).toBeNull();

    const missing = run(sample, [
      {id: '1', op: 'expression', expr: 't', inputs: {t: '$.user.nope'}, target: '$.user.salutation'},
    ]);
    // Missing inputs bind to null inside expressions (documented in UI),
    // but direct source steps fail on absence.
    expect(missing.ok).toBe(true);

    const direct = run(sample, [{id: '1', op: 'rename', source: '$.user.nope', target: '$.user.x'}]);
    expect(direct.ok).toBe(false);
    if (direct.ok) return;
    expect(direct.code).toBe('path_not_found');
    expect(direct.sourcePath).toBe('$.user.nope');

    const optional = run(sample, [
      {id: '1', op: 'rename', source: '$.user.nope', target: '$.user.x', optional: true},
    ]);
    expect(optional.ok).toBe(true);
  });
});

describe('split / merge', () => {
  it('splits a string across targets and can keep or drop the source', () => {
    const result = run(sample, [
      {id: '1', op: 'split', source: '$.tags', delimiter: ',', targets: ['$.t1', '$.t2', '$.t3']},
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(obj(result.output).t1).toBe('a');
    expect(obj(result.output).t3).toBe('c');
    expect(result.output).not.toHaveProperty('tags');
  });

  it('fails on part overflow unless extraIntoLast is set, atomically', () => {
    const overflow = run(sample, [
      {id: '1', op: 'split', source: '$.tags', delimiter: ',', targets: ['$.t1', '$.t2']},
    ]);
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.code).toBe('split_overflow');
    expect(overflow.preState).toEqual(sample);

    const collected = run(sample, [
      {id: '1', op: 'split', source: '$.tags', delimiter: ',', targets: ['$.first', '$.rest'], extraIntoLast: true},
    ]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(obj(collected.output).rest).toBe('b,c');
  });

  it('merges with join, concat and deep strategies', () => {
    const joined = run(sample, [
      {id: '1', op: 'merge', sources: ['$.user.first_name', '$.user.last_name'], target: '$.fullName', strategy: 'join', joiner: ' '},
    ]);
    expect(joined.ok).toBe(true);
    if (joined.ok) expect(obj(joined.output).fullName).toBe('Ada Lovelace');

    const arrays: JsonValue = {a: [1, 2], b: [3]};
    const concatenated = run(arrays, [{id: '1', op: 'merge', sources: ['$.a', '$.b'], target: '$.all', strategy: 'concat'}]);
    expect(concatenated.ok).toBe(true);
    if (concatenated.ok) expect(obj(concatenated.output).all).toEqual([1, 2, 3]);

    const deep = run(
      {x: {a: 1, nested: {p: 1}}, y: {b: 2, nested: {q: 2}}},
      [{id: '1', op: 'merge', sources: ['$.x', '$.y'], target: '$.z', strategy: 'deep'}]
    );
    expect(deep.ok).toBe(true);
    if (deep.ok) expect(obj(deep.output).z).toEqual({a: 1, b: 2, nested: {p: 1, q: 2}});
  });
});

describe('reorder re-validation', () => {
  const reorderSample: JsonValue = {
    user: {first_name: 'Ada', last_name: 'Lovelace'},
    profile: {},
  };
  const moveAway: Step = {id: 'move-away', op: 'move', source: '$.user.first_name', target: '$.profile.firstName'};
  const useField: Step = {
    id: 'merge-use',
    op: 'merge',
    sources: ['$.user.first_name', '$.user.last_name'],
    target: '$.fullName',
    strategy: 'join',
  };

  it('accepts the order where the reference is read first, flags it after the move is pulled ahead', () => {
    expect(validateSteps(reorderSample, [useField, moveAway])).toHaveLength(0);
    const diagnostics = validateSteps(reorderSample, [moveAway, useField]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].index).toBe(1);
    expect(diagnostics[0].code).toBe('path_not_found');
    expect(diagnostics[0].sourcePath).toBe('$.user.first_name');
  });

  it('the same steps execute successfully in the valid order and fail in the swapped one', () => {
    const good = run(reorderSample, [useField, moveAway]);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(obj(good.output).fullName).toBe('Ada Lovelace');
      expect(obj(good.output).profile.firstName).toBe('Ada');
      expect(obj(good.output).user.first_name).toBeUndefined();
    }
    const bad = run(reorderSample, [moveAway, useField]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.failedIndex).toBe(1);
      expect(bad.sourcePath).toBe('$.user.first_name');
    }
  });
});

describe('failure envelope', () => {
  it('returns index, step id, source path and pre-state — never an output', () => {
    const result = run(sample, [
      {id: 'ok', op: 'rename', source: '$.tags', target: '$.tagString'},
      {id: 'boom', op: 'expression', expr: 'missing / 0', target: '$.x'},
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedIndex).toBe(1);
    expect(result.stepId).toBe('boom');
    expect(result.sourcePath).toBeNull();
    expect(obj(result.preState).tagString).toBe('a,b,c');
    expect('output' in result).toBe(false);
  });
});
