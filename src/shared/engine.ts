import {
  expandWildcard,
  get,
  isMissing,
  MISSING,
  parsePath,
  PathError,
  resolveTargets,
  setAt,
  deleteAt,
  type LookupResult,
  type ResolvedTarget,
} from './path';
import {evaluate, ExpressionError} from './expression';
import type {
  JsonValue,
  NodeSummary,
  Step,
  StepChange,
  StepFailurePayload,
  StepResult,
  ValueKind,
} from './types';

export class StepError extends Error {
  code: string;
  sourcePath?: string;
  constructor(code: string, message: string, sourcePath?: string) {
    super(message);
    this.name = 'StepError';
    this.code = code;
    this.sourcePath = sourcePath;
  }
}

interface WriteOp {
  path: string;
  value: JsonValue;
  onConflict: NonNullable<Step['onConflict']>;
}

interface PlannedStep {
  writes: WriteOp[];
  deletes: string[];
  changes: StepChange[];
  /** no source value existed and the step asked to tolerate that — apply nothing */
  noop?: boolean;
}

const MAX_PRESTATE_NODES = 2000;

export function runPipeline(
  input: JsonValue,
  steps: Step[],
): { status: 'ok'; output: JsonValue; results: StepResult[] }
  | { status: 'error'; error: StepFailurePayload; results: StepResult[] } {
  const working: JsonValue = structuredClone(input);
  const results: StepResult[] = [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    evalRootHolder.root = working;
    const started = (globalThis.performance?.now?.() ?? Date.now());
    try {
      const planned = planStep(working, step);
      const {skipped} = commitStep(working, planned);
      const changes = planned.changes.map(c =>
        c.op === 'set' && skipped.includes(c.path)
          ? {op: 'noop' as const, path: c.path, detail: 'skipped: target exists'}
          : c,
      );
      results.push({
        index,
        stepId: step.id,
        kind: step.kind,
        changes,
        after: summarize(working),
        durationMs: Math.max(0, Math.round(((globalThis.performance?.now?.() ?? Date.now()) - started) * 1000) / 1000),
      });
    } catch (err) {
      return {
        status: 'error',
        results,
        error: toFailure(err, index, step, working),
      };
    }
  }
  return {status: 'ok', output: working, results};
}

function toFailure(err: unknown, index: number, step: Step, pre: JsonValue): StepFailurePayload {
  const sourcePath = (err instanceof StepError ? err.sourcePath : undefined) ?? step.source;
  const base = {
    index,
    stepId: step.id,
    sourcePath,
    preStatePath: sourcePath,
  };
  if (err instanceof ExpressionError) {
    return {...base, code: 'expression_error', message: err.message};
  }
  if (err instanceof StepError) {
    const preState = sourcePath ? boundedSubtree(pre, sourcePath) : undefined;
    return {
      ...base,
      code: err.code,
      message: err.message,
      preState: preState?.value,
      preStateTruncated: preState?.truncated,
    };
  }
  if (err instanceof PathError) {
    return {...base, code: 'path_error', message: err.message};
  }
  return {...base, code: 'engine_error', message: err instanceof Error ? err.message : 'step failed'};
}

// --- planning (read-only; no mutation until commit) -----------------------

function planStep(root: JsonValue, step: Step): PlannedStep {
  switch (step.kind) {
    case 'rename': return planRelocate(root, step, /*mustSameParent*/ true);
    case 'move': return planRelocate(root, step, false);
    case 'split': return planSplit(root, step);
    case 'merge': return planMerge(root, step);
    case 'compute': return planCompute(root, step);
  }
}

function requireSource(root: JsonValue, path: string | undefined, step: Step): {value: JsonValue; path: string} {
  if (!path) throw new StepError('missing_source_path', `${step.kind} step needs a source path`);
  parsePath(path); // validates syntax
  const found = get(root, path);
  if (isMissing(found)) {
    throw new StepError('missing_source', `source does not exist: ${path}`, path);
  }
  // explicit JSON null is a real, addressable value
  return {value: found, path};
}

/** Caller converts a missing source into a no-op when step.ignoreMissing. */
function missingAsNoop(step: Step, path: string): PlannedStep | null {
  if (step.ignoreMissing) {
    return {writes: [], deletes: [], noop: true, changes: [{op: 'noop', path, detail: 'source missing; step skipped'}]};
  }
  return null;
}

function conflictPolicy(step: Step): NonNullable<Step['onConflict']> {
  return step.onConflict ?? 'overwrite';
}

function checkTarget(root: JsonValue, path: string | undefined): string {
  if (!path) throw new StepError('missing_target_path', 'step needs a target path');
  parsePath(path);
  if (!canResolve(root, path)) {
    throw new StepError('target_unreachable', `target path cannot be resolved: ${path}`, path);
  }
  return path;
}

/** Read-only feasibility check mirroring resolveTargets' creation rules. */
function canResolve(root: JsonValue, path: string): boolean {
  const segs = parsePath(path);
  const wIdx = segs.findIndex(s => s.type === 'wildcard');
  if (wIdx === -1) return canWalk(root, segs);
  const containerLookup: LookupResult = get(root, segs.slice(0, wIdx));
  if (isMissing(containerLookup) || !Array.isArray(containerLookup)) return false;
  const container = containerLookup as unknown as JsonValue[];
  const tail = segs.slice(wIdx + 1);
  return container.every((el: JsonValue) => canWalk(el, tail));
}

function canWalk(cur: LookupResult, segs: ReturnType<typeof parsePath>): boolean {
  let node: JsonValue | undefined = isMissing(cur) ? undefined : (cur as JsonValue);
  for (const seg of segs) {
    if (node === undefined) return true; // missing prefix will be auto-created
    if (node === null) return true;      // null slot will be replaced by container
    if (seg.type === 'key') {
      if (typeof node !== 'object' || Array.isArray(node)) return false;
      if (!Object.prototype.hasOwnProperty.call(node, seg.value)) return true;
      node = node[seg.value];
    } else if (seg.type === 'index') {
      if (!Array.isArray(node)) return false;
      if (seg.value >= node.length) return true;
      node = node[seg.value];
    } else {
      return false;
    }
  }
  return true;
}

function planWritesForValue(
  root: JsonValue,
  targetPath: string,
  value: JsonValue,
  policy: NonNullable<Step['onConflict']>,
  existing: LookupResult,
): WriteOp[] {
  // Resolve concrete targets at plan time only for existence checks; actual
  // (possibly creating) resolution happens during commit. We emulate by
  // checking via expandWildcard + get.
  const concrete = expandWildcard(root, targetPath);
  if (targetPath.includes('[*]') && concrete.length === 0) return [];
  void existing;
  return concrete.map(p => ({path: p, value, onConflict: policy}));
}

function planRelocate(root: JsonValue, step: Step, sameParent: boolean): PlannedStep {
  let source: {value: JsonValue; path: string};
  try {
    source = requireSource(root, step.source, step);
  } catch (err) {
    if (err instanceof StepError && err.code === 'missing_source' && step.source) {
      const noop = missingAsNoop(step, step.source);
      if (noop) return noop;
    }
    throw err;
  }
  const {value, path: sourcePath} = source;
  const targetPath = checkTarget(root, step.target);
  if (sourcePath === targetPath) {
    return {writes: [], deletes: [], changes: [{op: 'noop', path: targetPath, detail: 'source equals target'}]};
  }
  if (isInside(targetPath, sourcePath)) {
    throw new StepError('target_inside_source', `target ${targetPath} lives inside source ${sourcePath}`, sourcePath);
  }
  if (sameParent && parentOf(sourcePath) !== parentOf(targetPath)) {
    throw new StepError('cross_parent_rename', `rename target ${targetPath} must stay beside ${sourcePath}; use move`, sourcePath);
  }
  const policy = conflictPolicy(step);
  const writes = planWritesForValue(root, targetPath, value, policy, get(root, targetPath));
  const deleteSource = step.kind === 'rename' || step.deleteSource !== false;
  const changes: StepChange[] = writes.map(w => ({
    op: 'set', path: w.path, from: sourcePath,
    detail: describeValue(value),
  }));
  if (deleteSource) changes.push({op: 'delete', path: sourcePath});
  return {
    writes,
    deletes: deleteSource ? [sourcePath] : [],
    changes,
  };
}

function isInside(candidate: string, ancestor: string): boolean {
  return candidate.startsWith(ancestor + '.') || candidate.startsWith(ancestor + '[');
}
function parentOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const bracket = path.lastIndexOf('[');
  const cut = Math.max(dot, bracket);
  return cut <= 0 ? '$' : path.slice(0, cut);
}

function describeValue(v: JsonValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `object(${Object.keys(v).length})`;
  return JSON.stringify(v);
}

function planSplit(root: JsonValue, step: Step): PlannedStep {
  let source: {value: JsonValue; path: string};
  try {
    source = requireSource(root, step.source, step);
  } catch (err) {
    if (err instanceof StepError && err.code === 'missing_source' && step.source) {
      const noop = missingAsNoop(step, step.source);
      if (noop) return noop;
    }
    throw err;
  }
  const {value, path: sourcePath} = source;
  const targets = step.targets ?? [];
  if (targets.length === 0) throw new StepError('missing_targets', 'split step needs at least one target path');
  targets.forEach(t => checkTarget(root, t));

  let parts: JsonValue[];
  if (Array.isArray(value)) {
    parts = value;
  } else if (typeof value === 'string') {
    parts = value.split(step.separator ?? ',');
  } else {
    throw new StepError('unsupported_split_source', `split needs a string or array, got ${describeValue(value)}`, sourcePath);
  }
  if (parts.length > targets.length) {
    throw new StepError(
      'too_many_parts',
      `source yields ${parts.length} parts but only ${targets.length} targets were provided`,
      sourcePath,
    );
  }
  const policy = conflictPolicy(step);
  const writes: WriteOp[] = [];
  const changes: StepChange[] = [];
  targets.forEach((targetPath, i) => {
    // Unproduced parts become explicit nulls (distinct from a missing field).
    const part: JsonValue = i < parts.length ? parts[i]! : null;
    writes.push(...planWritesForValue(root, targetPath, part, policy, get(root, targetPath)));
    changes.push({
      op: 'set', path: targetPath, from: sourcePath,
      detail: i < parts.length ? `part ${i + 1}/${parts.length}` : `part ${i + 1} defaulted to null`,
    });
  });
  return {writes, deletes: [], changes};
}

function planMerge(root: JsonValue, step: Step): PlannedStep {
  const sources = step.sources ?? [];
  if (sources.length === 0) throw new StepError('missing_sources', 'merge step needs source paths');
  const targetPath = checkTarget(root, step.target);
  const mode = step.join ?? 'join';

  const values: {path: string; value: JsonValue; existed: boolean}[] = [];
  for (const p of sources) {
    parsePath(p);
    const found = get(root, p);
    if (isMissing(found)) {
      if (step.ignoreMissing) continue;
      throw new StepError('missing_source', `merge source does not exist: ${p}`, p);
    }
    values.push({path: p, value: found, existed: true});
  }
  if (values.length === 0) {
    return {writes: [], deletes: [], noop: true, changes: sources.map(p => ({op: 'noop' as const, path: p, detail: 'source missing; merge skipped'}))};
  }

  let merged: JsonValue;
  let detail: string;
  if (mode === 'concat') {
    const arrays: JsonValue[][] = [];
    for (const {value, path} of values) {
      if (!Array.isArray(value)) {
        throw new StepError('type_mismatch', `concat merge needs arrays, ${path} is ${describeValue(value)}`, path);
      }
      arrays.push(value);
    }
    merged = arrays.flat();
    detail = `${arrays.length} arrays -> ${(merged as JsonValue[]).length} elements`;
  } else if (mode === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const {value, path} of values) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new StepError('type_mismatch', `object merge needs objects, ${path} is ${describeValue(value)}`, path);
      }
      for (const [k, v] of Object.entries(value)) out[k] = v;
    }
    merged = out;
    detail = `${values.length} objects -> ${Object.keys(out).length} fields`;
  } else {
    const sep = step.separator ?? ' ';
    merged = values.map(({value}) => value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)).join(sep);
    detail = `${values.length} values joined`;
  }

  const policy = conflictPolicy(step);
  const writes = planWritesForValue(root, targetPath, merged, policy, get(root, targetPath));
  const changes: StepChange[] = [
    ...writes.map(w => ({op: 'set' as const, path: w.path, detail})),
    ...values.map(v => ({op: 'noop' as const, path: v.path, detail: 'merged from source'})),
  ];
  return {writes, deletes: [], changes};
}

function planCompute(root: JsonValue, step: Step): PlannedStep {
  const expression = (step.expression ?? '').trim();
  if (!expression) throw new StepError('missing_expression', 'compute step needs an expression');
  const targetPath = checkTarget(root, step.target);

  const sourcePattern = step.source;
  const wildcard = sourcePattern?.includes('[*]') ?? false;
  if (targetPath.includes('[*]') !== wildcard) {
    throw new StepError(
      'wildcard_mismatch',
      wildcard
        ? 'wildcard source requires a [*] target'
        : 'wildcard target requires a [*] source',
      sourcePattern,
    );
  }

  const writes: WriteOp[] = [];
  const changes: StepChange[] = [];
  const policy = conflictPolicy(step);

  if (!sourcePattern) {
    const computed = safeEval(expression, undefined, -1, targetPath);
    writes.push(...planWritesForValue(root, targetPath, computed, policy, get(root, targetPath)));
    changes.push({op: 'set', path: targetPath, detail: 'computed from root'});
    return {writes, deletes: [], changes};
  }

  parsePath(sourcePattern);
  if (wildcard) {
    const before = sourcePattern.indexOf('[*]');
    const containerLookup = get(root, sourcePattern.slice(0, before));
    if (isMissing(containerLookup)) {
      if (step.ignoreMissing) return {writes: [], deletes: [], changes: [{op: 'noop', path: sourcePattern, detail: 'array missing'}]};
      throw new StepError('missing_source', `source array does not exist: ${sourcePattern.slice(0, before)}`, sourcePattern);
    }
    if (!Array.isArray(containerLookup)) {
      throw new StepError('type_mismatch', `[*] source must be an array: ${sourcePattern}`, sourcePattern);
    }
    const container = containerLookup as JsonValue[];
    // Any path segments after [*] (e.g. addresses[*].zip) are resolved per
    // element; a missing tail is undefined so the expression can test isMissing(v).
    const tailSegs = parsePath('$' + sourcePattern.slice(before + 3));
    container.forEach((el, i) => {
      const concrete = sourcePattern.replace('[*]', `[${i}]`);
      const elementValue = tailSegs.length === 0 ? el : get(el, tailSegs);
      const v: JsonValue | undefined = isMissing(elementValue) ? undefined : elementValue;
      const computed = safeEval(expression, v, i, concrete);
      const concreteTarget = targetPath.replace('[*]', `[${i}]`);
      writes.push(...planWritesForValue(root, concreteTarget, computed, policy, get(root, concreteTarget)));
      // Keep the detail value-free so fanning out over a huge array
      // never bloats streamed summaries with element payloads.
      changes.push({op: 'set', path: concreteTarget, detail: `element ${i} mapped`});
    });
  } else {
    const found = get(root, sourcePattern);
    const computed = safeEval(expression, isMissing(found) ? undefined : found, -1, sourcePattern);
    writes.push(...planWritesForValue(root, targetPath, computed, policy, isMissing(found) ? MISSING : found));
    changes.push({
      op: 'set', path: targetPath, from: sourcePattern,
      detail: `${isMissing(found) ? 'missing' : describeValue(found)} -> ${describeValue(computed)}`,
    });
  }
  return {writes, deletes: [], changes};
}

function safeEval(expression: string, value: JsonValue | undefined, index: number, sourcePath: string): JsonValue {
  try {
    return evaluate(expression, {
      value,
      // root is bound lazily by the evaluator call below; runPipeline provides it via wrapper
      root: evalRootHolder.root,
      index,
    });
  } catch (err) {
    if (err instanceof ExpressionError) {
      throw new StepError('expression_error', `${err.message} (at ${sourcePath})`, sourcePath);
    }
    throw err;
  }
}

// Expression scope needs the live root; thread it through a module-level holder
// set for the duration of one pipeline run (single-threaded execution).
const evalRootHolder: { root: JsonValue } = {root: null};

// --- commit ---------------------------------------------------------------

function commitStep(root: JsonValue, planned: PlannedStep): {committed: StepChange[]; skipped: string[]} {
  // 1. re-resolve targets (this may create intermediate containers)
  const resolved = planned.writes.map(w => {
    const targets = resolveTargets(root, w.path);
    if (targets.length === 0) {
      throw new StepError('target_unreachable', `target produced no assignments: ${w.path}`);
    }
    return {w, targets, skip: false};
  });
  // 2. conflict checks against the fully-resolved live tree — all checks
  //    happen before any mutation, keeping each step atomic.
  for (const r of resolved) {
    for (const t of r.targets) {
      const exists = targetExists(t);
      if (exists && r.w.onConflict === 'error') {
        throw new StepError('target_conflict', `target already exists: ${t.resolvedPath}`, t.resolvedPath);
      }
      if (exists && r.w.onConflict === 'skip') r.skip = true;
    }
  }
  // 3. apply writes (a skipped op is reported, not silently dropped)
  const committed: StepChange[] = [];
  const skipped: string[] = [];
  for (const r of resolved) {
    if (r.skip) {
      for (const t of r.targets) {
        skipped.push(t.resolvedPath);
        committed.push({op: 'noop', path: t.resolvedPath, detail: 'skipped: target exists'});
      }
      continue;
    }
    for (const t of r.targets) {
      setAt(t, r.w.value);
      committed.push({op: 'set', path: t.resolvedPath, detail: describeValue(r.w.value)});
    }
  }
  // 4. apply deletes
  for (const p of planned.deletes) deleteAt(root, p);
  return {committed, skipped};
}

function targetExists(t: ResolvedTarget): boolean {
  const {parent, key} = t;
  if (Array.isArray(parent)) return Number(key) < parent.length;
  if (typeof parent === 'object' && parent !== null) {
    return Object.prototype.hasOwnProperty.call(parent, String(key));
  }
  return false;
}

// --- summaries & bounded extraction --------------------------------------

export function summarize(value: JsonValue, maxFields = 12): NodeSummary {
  if (value === null) return {kind: 'scalar', scalar: 'null'};
  if (Array.isArray(value)) {
    const elementTypes: Partial<Record<ValueKind, number>> = {};
    for (const el of value) {
      const k = kindOf(el);
      elementTypes[k] = (elementTypes[k] ?? 0) + 1;
    }
    return {
      kind: 'array',
      length: value.length,
      elementTypes,
      head: value.slice(0, 8).map(kindOf),
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return {
      kind: 'object',
      fieldCount: entries.length,
      fields: entries.slice(0, maxFields).map(([name, v]) => ({name, type: kindOf(v)})),
      truncated: entries.length > maxFields,
    };
  }
  return {kind: 'scalar', scalar: typeof value as 'string' | 'number' | 'boolean'};
}

function kindOf(v: JsonValue): ValueKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v as ValueKind;
}

export function boundedSubtree(root: JsonValue, path: string): {value: JsonValue | undefined; truncated: boolean} {
  const found = get(root, path);
  if (isMissing(found)) return {value: undefined, truncated: false};
  let nodes = 0;
  let truncated = false;
  const walk = (v: JsonValue, depth: number): JsonValue => {
    nodes++;
    if (nodes > MAX_PRESTATE_NODES || depth > 6) {
      truncated = true;
      if (Array.isArray(v)) return [`… ${v.length} elements truncated …` as unknown as JsonValue];
      if (typeof v === 'object') return {_truncated: true};
      return v;
    }
    if (Array.isArray(v)) return v.map(el => walk(el, depth + 1));
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, JsonValue> = {};
      for (const [k, child] of Object.entries(v)) out[k] = walk(child, depth + 1);
      return out;
    }
    return v;
  };
  return {value: walk(found, 0), truncated};
}
