// Step executors and the pipeline runner.
//
// Atomicity contract: every step is computed against the post-state of the
// previous step and either fully applies (all paired mappings, all split
// targets, all mapped elements) or throws a StepError and leaves the working
// document untouched — mutations are made on a shallow-worked clone tree and
// discarded on failure.

import {ExpressionError, evaluateExpression} from './expr';
import {
  expandWildcards,
  getValue,
  parsePath,
  removeValue,
  setValue,
  targetExists,
} from './path';
import {
  ExpressionStep,
  JsonValue,
  MergeStep,
  MoveStep,
  PipelineFailure,
  PipelineResult,
  RenameStep,
  SplitStep,
  Step,
  isObject,
} from './types';

export interface StepError {
  code: PipelineFailure['code'];
  message: string;
  sourcePath: string | null;
}

export function stepError(
  code: StepError['code'],
  message: string,
  sourcePath: string | null
): StepError {
  return {code, message, sourcePath};
}

const clone = (value: JsonValue): JsonValue =>
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as JsonValue);

/** Validate that an absolute path is well-formed. */
export function assertAbsolutePath(path: string): void {
  const segments = parsePath(path);
  if (segments.length === 1) {
    throw stepError('invalid_path', 'path must point at a field, not the root', path);
  }
}

function assertTargetFree(working: JsonValue, path: string, overwrite: boolean | undefined, label = 'target'): void {
  if (!overwrite && targetExists(working, path)) {
    throw stepError('target_exists', `${label} already exists: ${path} (set overwrite to replace)`, path);
  }
}

// ---------------------------------------------------------------------------
// rename / move
// ---------------------------------------------------------------------------

function applyRelocation(
  working: JsonValue,
  step: RenameStep | MoveStep,
  removeSource: boolean
): void {
  assertAbsolutePath(step.source);
  assertAbsolutePath(step.target);
  let pairs: {source: string; target: string}[];
  try {
    const expanded = expandWildcards(working, step.source, step.target);
    pairs = expanded.sources.map((source, index) => ({source, target: expanded.targets[index]}));
  } catch (error) {
    if ((error as StepError).code) throw error;
    throw stepError('invalid_path', (error as Error).message, step.source);
  }

  // Read phase: all sources must resolve (or be explicitly optional).
  const values: (JsonValue | undefined)[] = pairs.map(({source}) => {
    const lookup = getValue(working, source);
    if (!lookup.found) {
      if (step.optional) return undefined;
      throw stepError('path_not_found', `source path not found: ${source}`, source);
    }
    return lookup.value;
  });

  // Every concrete target is checked before any mutation.
  pairs.forEach(({target}, index) => {
    if (values[index] === undefined) return;
    assertTargetFree(working, target, step.overwrite);
  });

  pairs.forEach(({source, target}, index) => {
    if (values[index] === undefined) return;
    setValue(working, target, values[index] as JsonValue);
    if (removeSource && source !== target) removeValue(working, source);
  });
}

function applyRename(working: JsonValue, step: RenameStep): void {
  // A rename relocates the value and removes the old key when the concrete
  // source path differs from the concrete target path.
  applyRelocation(working, step, true);
}

function applyMove(working: JsonValue, step: MoveStep): void {
  applyRelocation(working, step, true);
}

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

function applySplit(working: JsonValue, step: SplitStep): void {
  assertAbsolutePath(step.source);
  step.targets.forEach((target) => assertAbsolutePath(target));
  if (step.targets.length === 0) {
    throw stepError('invalid_step', 'split requires at least one target', step.source);
  }
  const lookup = getValue(working, step.source);
  if (!lookup.found) {
    if (step.optional) return;
    throw stepError('path_not_found', `source path not found: ${step.source}`, step.source);
  }
  if (lookup.value !== null && typeof lookup.value !== 'string') {
    throw stepError('type_mismatch', `split source must be a string, got ${Array.isArray(lookup.value) ? 'array' : typeof lookup.value}`, step.source);
  }
  step.targets.forEach((target) => assertTargetFree(working, target, step.overwrite, 'split target'));

  const parts: string[] = lookup.value === null ? [] : lookup.value.split(step.delimiter);
  if (parts.length > step.targets.length && !step.extraIntoLast) {
    throw stepError(
      'split_overflow',
      `splitting produced ${parts.length} parts but only ${step.targets.length} targets are defined`,
      step.source
    );
  }
  step.targets.forEach((target, index) => {
    let part: JsonValue = null;
    if (index === step.targets.length - 1 && parts.length > step.targets.length) {
      part = parts.slice(index).join(step.delimiter);
    } else {
      part = index < parts.length ? parts[index] : null;
    }
    setValue(working, target, part);
  });
  if (!step.keepSource) removeValue(working, step.source);
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

function deepMerge(base: JsonValue, extra: JsonValue): JsonValue {
  if (isObject(base) && isObject(extra)) {
    const result: {[key: string]: JsonValue} = {...base};
    for (const [key, value] of Object.entries(extra)) {
      result[key] = key in result ? deepMerge(result[key], value) : value;
    }
    return result;
  }
  return extra;
}

function applyMerge(working: JsonValue, step: MergeStep): void {
  assertAbsolutePath(step.target);
  if (!step.sources || step.sources.length < 2) {
    throw stepError('invalid_step', 'merge requires at least two sources', step.target);
  }
  const optional = new Set(step.optionalSources ?? []);
  const resolved: {path: string; value: JsonValue}[] = [];
  for (const source of step.sources) {
    assertAbsolutePath(source);
    const lookup = getValue(working, source);
    if (!lookup.found) {
      if (optional.has(source)) continue;
      throw stepError('path_not_found', `merge source not found: ${source}`, source);
    }
    resolved.push({path: source, value: lookup.value});
  }
  assertTargetFree(working, step.target, false, 'merge target');

  const values = resolved.map((entry) => entry.value);
  let result: JsonValue;
  if (step.strategy === 'join') {
    resolved.forEach(({path, value}) => {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
        throw stepError('type_mismatch', 'join strategy only accepts strings or numbers', path);
      }
    });
    result = values.filter((value) => value !== null).map(String).join(step.joiner ?? ' ');
  } else if (step.strategy === 'concat') {
    if (!values.every((value) => value === null || Array.isArray(value))) {
      throw stepError('type_mismatch', 'concat strategy only accepts arrays', resolved[0]?.path ?? null);
    }
    result = values.filter(Array.isArray).flat() as JsonValue;
  } else {
    if (!values.every((value) => value === null || isObject(value))) {
      throw stepError('type_mismatch', 'deep strategy only accepts objects', resolved[0]?.path ?? null);
    }
    result = values.filter(isObject).reduce<JsonValue>(
      (acc, value) => deepMerge(acc, value),
      {}
    );
  }
  setValue(working, step.target, result);
}

// ---------------------------------------------------------------------------
// expression (including array element mapping)
// ---------------------------------------------------------------------------

const OUTPUT_TYPE_CHECK: Record<NonNullable<ExpressionStep['outputType']>, (value: JsonValue) => boolean> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number',
  boolean: (value) => typeof value === 'boolean',
  object: (value) => isObject(value),
  array: (value) => Array.isArray(value),
};

function buildScope(
  root: JsonValue,
  inputs: Record<string, string>,
  extra: Record<string, unknown>
): {scope: Record<string, unknown>; missing: string[]} {
  const scope: Record<string, unknown> = {$: root, ...extra};
  const missing: string[] = [];
  for (const [name, path] of Object.entries(inputs)) {
    const lookup = getValue(root, path);
    if (!lookup.found) {
      missing.push(path);
      scope[name] = null;
    } else {
      scope[name] = lookup.value;
    }
  }
  return {scope, missing};
}

function applyExpression(working: JsonValue, step: ExpressionStep): void {
  if (!step.expr || !step.expr.trim()) {
    throw stepError('invalid_step', 'expression is empty', null);
  }

  const evaluateInto = (target: string, scope: Record<string, unknown>, sourcePath: string | null): JsonValue => {
    let value: JsonValue;
    try {
      value = evaluateExpression(step.expr, scope);
    } catch (error) {
      if (error instanceof ExpressionError) {
        throw stepError('expression_error', `${(error as Error).message} in \`${step.expr}\``, sourcePath);
      }
      throw error;
    }
    if (step.outputType && !OUTPUT_TYPE_CHECK[step.outputType](value)) {
      throw stepError(
        'type_mismatch',
        `expression returned ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}, expected ${step.outputType}`,
        sourcePath
      );
    }
    return value;
  };

  if (step.mapEach) {
    assertAbsolutePath(step.mapEach);
    const lookup = getValue(working, step.mapEach);
    if (!lookup.found) {
      throw stepError('path_not_found', `mapEach array not found: ${step.mapEach}`, step.mapEach);
    }
    if (!Array.isArray(lookup.value)) {
      throw stepError('type_mismatch', `mapEach path must be an array: ${step.mapEach}`, step.mapEach);
    }
    if (step.target.startsWith('$')) {
      throw stepError('invalid_path', 'with mapEach, target must be a relative field name on each element', step.target);
    }
    const inputPaths = step.inputs ?? {};

    // Phase 1: evaluate every element first so an exception is atomic.
    const results: JsonValue[] = lookup.value.map((item, index) => {
      const {scope} = buildScope(working, inputPaths, {item, index});
      return evaluateInto(step.target, scope, `${step.mapEach}[${index}]`);
    });
    // Phase 2: verify all element targets, then mutate.
    lookup.value.forEach((item, index) => {
      if (!isObject(item)) {
        throw stepError('type_mismatch', `array element ${index} is not an object, cannot set ${step.target}`, `${step.mapEach}[${index}]`);
      }
      const concrete = `${step.mapEach}[${index}].${step.target}`;
      assertTargetFree(working, concrete, step.overwrite, 'element target');
    });
    lookup.value.forEach((item, index) => {
      (item as Record<string, JsonValue>)[step.target] = results[index];
    });
    return;
  }

  assertAbsolutePath(step.target);
  const {scope} = buildScope(working, step.inputs ?? {}, {});
  const value = evaluateInto(step.target, scope, null);
  assertTargetFree(working, step.target, step.overwrite);
  setValue(working, step.target, value);
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

export function applyStep(working: JsonValue, step: Step): void {
  switch (step.op) {
    case 'rename': return applyRename(working, step);
    case 'move': return applyMove(working, step);
    case 'split': return applySplit(working, step);
    case 'merge': return applyMerge(working, step);
    case 'expression': return applyExpression(working, step);
    default: {
      const exhaustive: never = step;
      throw stepError('invalid_step', `unknown op: ${JSON.stringify(exhaustive)}`, null);
    }
  }
}

/** Execute all steps. On failure returns the failed step index/id, a concrete
 *  source path where available, and a snapshot of the state BEFORE that step.
 *  There is no `output` on failure — the partial state is diagnostic only. */
export function runPipeline(input: JsonValue, steps: Step[]): PipelineResult {
  let state = clone(input);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const preState = clone(state);
    try {
      applyStep(state, step);
    } catch (error) {
      const failure: PipelineFailure = {
        ok: false,
        failedIndex: index,
        stepId: step.id,
        code: (error as StepError).code ?? 'invalid_step',
        message: (error as Error).message ?? 'step failed',
        sourcePath: (error as StepError).sourcePath ?? null,
        preState,
      };
      return failure;
    }
  }
  return {ok: true, output: state};
}
