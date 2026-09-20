import {describe, expect, it} from 'vitest';
import {runPipeline} from '../src/shared/engine';
import {validatePipeline} from '../src/shared/validate';
import {evaluate} from '../src/shared/expression';
import {get, isMissing, MISSING} from '../src/shared/path';
import type {JsonValue, Step} from '../src/shared/types';

let seq = 0;
const sid = () => `step-${seq++}`;
const step = (s: Omit<Step, 'id'>): Step => ({id: sid(), onConflict: 'overwrite', ...s});

describe('path semantics: missing vs explicit null', () => {
  const doc: JsonValue = {a: null, b: {c: 1}};

  it('distinguishes an absent key from an explicit JSON null', () => {
    expect(get(doc, '$.a')).toBeNull();
    expect(isMissing(get(doc, '$.a'))).toBe(false);
    expect(get(doc, '$.missing')).toBe(MISSING);
    expect(get(doc, '$.missing.deeper')).toBe(MISSING);
    // null has no children; traversal through it is missing, not an error
    expect(get(doc, '$.a.deeper')).toBe(MISSING);
  });

  it('compute exposes isMissing(v) and isNull(v) separately', () => {
    const out = runPipeline(doc, [
      step({kind: 'compute', source: '$.a', target: '$.wasNull', expression: 'isNull(v)'}),
      step({kind: 'compute', source: '$.a', target: '$.nullIsNotMissing', expression: 'isMissing(v)'}),
      step({kind: 'compute', source: '$.nope', target: '$.wasMissing', expression: 'isMissing(v)'}),
    ]);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.output).toMatchObject({wasNull: true, nullIsNotMissing: false, wasMissing: true});
  });

  it('missing source aborts unless ignoreMissing; explicit null is a valid source', () => {
    const fail = runPipeline(doc, [
      step({kind: 'rename', source: '$.nope', target: '$.x'}),
    ]);
    expect(fail.status).toBe('error');
    if (fail.status === 'error') {
      expect(fail.error.code).toBe('missing_source');
      expect(fail.error.sourcePath).toBe('$.nope');
    }

    const okNull = runPipeline(doc, [
      step({kind: 'move', source: '$.a', target: '$.movedNull'}),
    ]);
    expect(okNull.status).toBe('ok');
    if (okNull.status === 'ok') {
      expect(okNull.output).not.toHaveProperty('a');
      expect((okNull.output as JsonObject).movedNull).toBeNull();
    }

    const ignored = runPipeline(doc, [
      step({kind: 'move', source: '$.nope', target: '$.x', ignoreMissing: true}),
    ]);
    expect(ignored.status).toBe('ok');
    if (ignored.status === 'ok') expect(ignored.output).not.toHaveProperty('x');
  });

  it('split fills unused targets with explicit null, not missing fields', () => {
    const out = runPipeline({csv: 'one,two'}, [
      step({kind: 'split', source: '$.csv', targets: ['$.p1', '$.p2', '$.p3'], separator: ','}),
    ]);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const o = out.output as JsonObject;
    expect(o.p1).toBe('one');
    expect(o.p2).toBe('two');
    expect(o).toHaveProperty('p3');
    expect(o.p3).toBeNull();
  });
});

type JsonObject = {[k: string]: JsonValue};

describe('array element mapping with [*]', () => {
  it('maps every element of an array, one write per element', () => {
    const input: JsonValue = {items: [{name: 'a'}, {name: 'b'}]};
    const out = runPipeline(input, [
      step({kind: 'compute', source: '$.items[*].name', target: '$.items[*].label', expression: 'upper(v) + "-" + (index + 1)'}),
    ]);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const items = (out.output as JsonObject).items as JsonValue[];
    expect(items).toEqual([
      {name: 'a', label: 'A-1'},
      {name: 'b', label: 'B-2'},
    ]);
    expect(out.results[0]!.changes).toHaveLength(2);
  });

  it('missing tail field per element is observed as missing by the expression', () => {
    const input: JsonValue = {items: [{name: 'a'}, {name: 'b', code: 'x'}]};
    const out = runPipeline(input, [
      step({kind: 'compute', source: '$.items[*].code', target: '$.items[*].hasCode', expression: '!isMissing(v)'}),
    ]);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const items = (out.output as JsonObject).items as JsonObject[];
    expect(items[0]!.hasCode).toBe(false);
    expect(items[1]!.hasCode).toBe(true);
  });

  it('concat merge flattens arrays element-wise', () => {
    const out = runPipeline({a: [1, 2], b: [3], c: [4, 5]}, [
      step({kind: 'merge', sources: ['$.a', '$.b', '$.c'], target: '$.all', join: 'concat'}),
    ]);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect((out.output as JsonObject).all).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('step reordering changes sequential validation', () => {
  const input: JsonValue = {full_name: 'Ada'};
  const ordered = [
    step({kind: 'move', source: '$.full_name', target: '$.profile.name'}),
    step({kind: 'rename', source: '$.profile.name', target: '$.profile.displayName'}),
  ];
  const reordered = [ordered[1]!, ordered[0]!];

  it('succeeds when the creating move precedes the step reading the new path', () => {
    const out = runPipeline(input, ordered);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') {
      expect((out.output as JsonObject).profile).toEqual({displayName: 'Ada'});
    }
  });

  it('the same steps in the other order fail at the now-broken reference', () => {
    const out = runPipeline(input, reordered);
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.error.index).toBe(0);
    expect(out.error.code).toBe('missing_source');
    expect(out.error.sourcePath).toBe('$.profile.name');
    // the later step never ran
    expect(out.results).toHaveLength(0);
  });

  it('validatePipeline re-checks each path against preceding steps', () => {
    expect(validatePipeline(ordered, input).filter(d => d.severity === 'error')).toHaveLength(0);
    const diags = validatePipeline(reordered, input);
    expect(diags.some(d => d.index === 0 && d.code === 'missing_source')).toBe(true);
  });
});

describe('expression failures', () => {
  it('reports step id, source path, bounded pre-state and never returns partial output', () => {
    const input: JsonValue = {name: 'Ada', keep: 1};
    const out = runPipeline(input, [
      step({kind: 'compute', source: '$.name', target: '$.n1', expression: 'upper(v)'}),
      step({kind: 'compute', source: '$.name', target: '$.n2', expression: 'v.foo.bar'}),
      step({kind: 'compute', source: '$.keep', target: '$.n3', expression: 'v + 1'}),
    ]);
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.error.index).toBe(1);
    expect(out.error.code).toBe('expression_error');
    expect(out.error.sourcePath).toBe('$.name');
    expect(out.error.preState).toBe('Ada');
    // key contract: an error run carries no `output`; first step result is diagnostic only
    expect('output' in out).toBe(false);
    expect(out.results).toHaveLength(1);
  });

  it('catches type errors, division by zero and unknown identifiers', () => {
    for (const expression of ['v / 0', 'unknownName', 'upper(123)', 'number("abc")']) {
      let threw = false;
      try { evaluate(expression, {value: 10, root: {}, index: -1}); }
      catch { threw = true; }
      expect(threw, expression).toBe(true);
    }
  });

  it('null propagates through arithmetic and property chains', () => {
    expect(evaluate('v.a.b + 1', {value: null, root: {}, index: -1})).toBeNull();
    expect(evaluate('coalesce(v, "x")', {value: null, root: {}, index: -1})).toBe('x');
    expect(evaluate('v == null', {value: null, root: {}, index: -1})).toBe(true);
  });
});

describe('target overwrite policies', () => {
  const input: JsonValue = {src: 'new', existing: 'old'};

  it('overwrite replaces; skip keeps and reports noop; error aborts atomically', () => {
    const over = runPipeline(input, [
      step({kind: 'move', source: '$.src', target: '$.existing', onConflict: 'overwrite'}),
    ]);
    expect(over.status).toBe('ok');
    if (over.status === 'ok') expect((over.output as JsonObject).existing).toBe('new');

    const skip = runPipeline({src: 'new', existing: 'old'}, [
      step({kind: 'move', source: '$.src', target: '$.existing', onConflict: 'skip'}),
    ]);
    expect(skip.status).toBe('ok');
    if (skip.status !== 'ok') return;
    expect((skip.output as JsonObject).existing).toBe('old');
    expect(skip.results[0]!.changes.some(c => c.op === 'noop' && /skip/.test(c.detail ?? ''))).toBe(true);

    const err = runPipeline({src: 'new', existing: 'old'}, [
      step({kind: 'move', source: '$.src', target: '$.existing', onConflict: 'error'}),
    ]);
    expect(err.status).toBe('error');
    if (err.status === 'error') {
      expect(err.error.code).toBe('target_conflict');
      // atomic: the source must not have been deleted on the failed run
      expect(err.error.preStatePath).toBe('$.existing');
    }
  });

  it('rejects a rename that moves across parents', () => {
    const out = runPipeline({a: 1}, [step({kind: 'rename', source: '$.a', target: '$.b.c'})]);
    expect(out.status).toBe('error');
    if (out.status === 'error') expect(out.error.code).toBe('cross_parent_rename');
  });
});
