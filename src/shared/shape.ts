// Structural validation by shape replay. After every reorder/edit the whole
// pipeline is re-validated from the sample: each step is simulated against a
// lightweight "shape" (types only), so a later step referencing a field moved
// away by an earlier step is reported at the step that breaks — even though
// its path was valid under the previous ordering.

import {parsePath} from './path';
import {
  ExpressionStep,
  JsonValue,
  MergeStep,
  MoveStep,
  RenameStep,
  SplitStep,
  Step,
} from './types';

export type ShapeKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'missing';

export interface ShapeNode {
  kind: ShapeKind;
  /** object fields / array element shape */
  fields?: {[name: string]: ShapeNode};
  element?: ShapeNode;
}

export const missingShape = (): ShapeNode => ({kind: 'missing'});

export function inferShape(value: JsonValue | undefined): ShapeNode {
  if (value === undefined) return {kind: 'missing'};
  if (value === null) return {kind: 'null'};
  if (Array.isArray(value)) {
    return value.length === 0
      ? {kind: 'array'}
      : {kind: 'array', element: inferShape(value[0])};
  }
  if (typeof value === 'object') {
    const fields: {[name: string]: ShapeNode} = {};
    for (const [key, child] of Object.entries(value)) fields[key] = inferShape(child);
    return {kind: 'object', fields};
  }
  return {kind: typeof value as 'string' | 'number' | 'boolean'};
}

export interface StepDiagnostic {
  index: number;
  stepId: string;
  code:
    | 'invalid_step'
    | 'invalid_path'
    | 'path_not_found'
    | 'type_mismatch'
    | 'target_exists'
    | 'expression_error';
  message: string;
  sourcePath: string | null;
}

type LookupResult = {found: true; shape: ShapeNode; concrete: string} | {found: false};

function followSegments(shape: ShapeNode, segments: ReturnType<typeof parsePath>, wildcardAsElement: boolean): LookupResult {
  let current = shape;
  let concrete = '$';
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.kind === 'key') {
      if (current.kind !== 'object' || !current.fields || !(segment.value in current.fields)) {
        return {found: false};
      }
      current = current.fields[segment.value];
      concrete += `.${segment.value}`;
    } else if (segment.kind === 'index') {
      if (current.kind !== 'array' || !current.element) return {found: false};
      current = current.element;
      concrete += `[${segment.value}]`;
    } else if (segment.kind === 'wildcard') {
      if (current.kind !== 'array' || !current.element) return {found: false};
      current = current.element;
      if (!wildcardAsElement) {
        // Caller wants to continue INSIDE the elements.
      }
      concrete += '[*]';
    } else {
      return {found: false};
    }
  }
  return {found: true, shape: current, concrete};
}

function lookup(shape: ShapeNode, path: string): LookupResult {
  try {
    return followSegments(shape, parsePath(path), false);
  } catch {
    throw {code: 'invalid_path' as const};
  }
}

function assertValidPath(path: string, allowRelative = false): void {
  if (allowRelative && !path.startsWith('$')) {
    if (!/^[A-Za-z_$][\w$]*$/.test(path)) {
      throw {code: 'invalid_path' as const};
    }
    return;
  }
  const segments = parsePath(path);
  if (segments.length < 2) throw {code: 'invalid_path' as const};
}

function getField(shape: ShapeNode, name: string): ShapeNode | undefined {
  return shape.kind === 'object' ? shape.fields?.[name] : undefined;
}

function setField(shape: ShapeNode, name: string, child: ShapeNode): void {
  if (shape.kind === 'object') {
    if (!shape.fields) shape.fields = {};
    shape.fields[name] = child;
  }
}

function deleteField(shape: ShapeNode, name: string): void {
  if (shape.kind === 'object' && shape.fields) delete shape.fields[name];
}

// ---- shape mutations -------------------------------------------------------

function relocateShape(shape: ShapeNode, sourcePath: string, targetPath: string): void {
  const sourceSegments = parsePath(sourcePath);
  const targetSegments = parsePath(targetPath);
  const wildcard = sourceSegments.some((segment) => segment.kind === 'wildcard');

  const locateParent = (segments: ReturnType<typeof parsePath>): {parent: ShapeNode; name: string; inElement: boolean} => {
    let current = shape;
    let inElement = false;
    for (let i = 1; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      if (segment.kind === 'key') {
        const next = getField(current, segment.value);
        if (!next) throw {code: 'path_not_found' as const};
        current = next;
      } else if (segment.kind === 'index' || segment.kind === 'wildcard') {
        if (!current.element) throw {code: 'path_not_found' as const};
        current = current.element;
        inElement = true;
      } else {
        throw {code: 'invalid_path' as const};
      }
    }
    const last = segments[segments.length - 1];
    if (last.kind !== 'key') throw {code: 'invalid_path' as const};
    return {parent: current, name: last.value, inElement};
  };

  const source = locateParent(sourceSegments);
  const target = locateParent(targetSegments);
  if (wildcard !== source.inElement || wildcard !== target.inElement) {
    throw {code: 'invalid_path' as const};
  }
  const child = getField(source.parent, source.name);
  if (!child) throw {code: 'path_not_found' as const};
  setField(target.parent, target.name, child);
  if (source.parent !== target.parent || source.name !== target.name) {
    deleteField(source.parent, source.name);
  }
}

function simulateRename(shape: ShapeNode, step: RenameStep | MoveStep): void {
  assertValidPath(step.source);
  assertValidPath(step.target);
  const source = lookup(shape, step.source);
  if (!source.found && !step.optional) throw {code: 'path_not_found' as const};
  const target = lookup(shape, step.target);
  if (target.found && target.shape.kind !== 'null' && target.shape.kind !== 'missing' && !step.overwrite) {
    throw {code: 'target_exists' as const};
  }
  if (source.found) relocateShape(shape, step.source, step.target);
}

function simulateSplit(shape: ShapeNode, step: SplitStep): void {
  assertValidPath(step.source);
  if (!step.targets.length) throw {code: 'invalid_step' as const};
  step.targets.forEach((target) => assertValidPath(target));
  const source = lookup(shape, step.source);
  if (!source.found && !step.optional) throw {code: 'path_not_found' as const};
  if (source.found && source.shape.kind !== 'string' && source.shape.kind !== 'null' && source.shape.kind !== 'missing') {
    throw {code: 'type_mismatch' as const};
  }
  for (const target of step.targets) {
    const existing = lookup(shape, target);
    if (existing.found && existing.shape.kind !== 'null' && !step.overwrite) {
      throw {code: 'target_exists' as const};
    }
  }
  // Parts are strings; write shapes into each target's parent.
  for (const target of step.targets) {
    const segments = parsePath(target);
    let current = shape;
    for (let i = 1; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      const next =
        segment.kind === 'key'
          ? getField(current, segment.value)
          : current.kind === 'array'
            ? current.element
            : undefined;
      if (!next) throw {code: 'path_not_found' as const};
      current = next;
    }
    const last = segments[segments.length - 1];
    if (last.kind === 'key') setField(current, last.value, {kind: 'string'});
  }
  if (source.found && !step.keepSource) {
    const segments = parsePath(step.source);
    let current = shape;
    for (let i = 1; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      current = (segment.kind === 'key' ? getField(current, segment.value) : current.element) ?? current;
    }
    const last = segments[segments.length - 1];
    if (last.kind === 'key') deleteField(current, last.value);
  }
}

function simulateMerge(shape: ShapeNode, step: MergeStep): void {
  if (!step.sources || step.sources.length < 2) throw {code: 'invalid_step' as const};
  assertValidPath(step.target);
  const optional = new Set(step.optionalSources ?? []);
  const shapes: ShapeNode[] = [];
  for (const source of step.sources) {
    assertValidPath(source);
    const found = lookup(shape, source);
    if (!found.found) {
      if (optional.has(source)) continue;
      throw {code: 'path_not_found' as const};
    }
    shapes.push(found.shape);
  }
  const target = lookup(shape, step.target);
  if (target.found && target.shape.kind !== 'null') throw {code: 'target_exists' as const};
  const resultShape = (): ShapeNode => {
    switch (step.strategy) {
      case 'join': return {kind: 'string'};
      case 'concat': return {kind: 'array', element: shapes.find((entry) => entry.kind === 'array')?.element};
      default: {
        const fields: {[name: string]: ShapeNode} = {};
        for (const entry of shapes) {
          if (entry.kind === 'object' && entry.fields) Object.assign(fields, entry.fields);
        }
        return {kind: 'object', fields};
      }
    }
  };
  const segments = parsePath(step.target);
  let current = shape;
  for (let i = 1; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const next = segment.kind === 'key' ? getField(current, segment.value) : current.element;
    if (!next) throw {code: 'path_not_found' as const};
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last.kind === 'key') setField(current, last.value, resultShape());
}

function simulateExpression(shape: ShapeNode, step: ExpressionStep): void {
  if (!step.expr?.trim()) throw {code: 'invalid_step' as const};
  for (const path of Object.values(step.inputs ?? {})) {
    assertValidPath(path);
    if (!lookup(shape, path).found) {
      // Missing input is legal at runtime (binds to null), but flag it so the
      // author can tell missing apart from a real null value.
    }
  }
  const outputKind =
    step.outputType === 'array'
      ? 'array'
      : step.outputType === 'object'
        ? 'object'
        : step.outputType ?? 'string';
  if (step.mapEach) {
    assertValidPath(step.mapEach);
    const found = lookup(shape, step.mapEach);
    if (!found.found) throw {code: 'path_not_found' as const};
    if (found.shape.kind !== 'array') throw {code: 'type_mismatch' as const};
    assertValidPath(step.target, true);
    if (found.shape.element?.kind === 'object' && found.shape.element.fields) {
      const existing = found.shape.element.fields[step.target];
      if (existing && existing.kind !== 'null' && !step.overwrite) {
        throw {code: 'target_exists' as const};
      }
      found.shape.element.fields[step.target] = {kind: outputKind as ShapeNode['kind']};
    }
    return;
  }
  assertValidPath(step.target);
  const target = lookup(shape, step.target);
  if (target.found && target.shape.kind !== 'null' && !step.overwrite) {
    throw {code: 'target_exists' as const};
  }
  const segments = parsePath(step.target);
  let current = shape;
  for (let i = 1; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const next = segment.kind === 'key' ? getField(current, segment.value) : current.element;
    if (!next) throw {code: 'path_not_found' as const};
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last.kind === 'key') setField(current, last.value, {kind: outputKind as ShapeNode['kind']});
}

/** Replay every step over the inferred shape of `sample`. Diagnostics carry
 *  the step index that actually fails under the current ordering. */
export function validateSteps(sample: JsonValue, steps: Step[]): StepDiagnostic[] {
  let shape = inferShape(sample);
  const diagnostics: StepDiagnostic[] = [];
  steps.forEach((step, index) => {
    const report = (code: StepDiagnostic['code'], message: string, sourcePath: string | null) => {
      diagnostics.push({index, stepId: step.id, code, message, sourcePath});
    };
    try {
      switch (step.op) {
        case 'rename':
        case 'move':
          simulateRename(shape, step);
          break;
        case 'split':
          simulateSplit(shape, step);
          break;
        case 'merge':
          simulateMerge(shape, step);
          break;
        case 'expression':
          simulateExpression(shape, step);
          break;
        default:
          report('invalid_step', `unknown op: ${(step as {op: string}).op}`, null);
      }
    } catch (error) {
      const code = ((error as {code?: StepDiagnostic['code']}).code ?? 'invalid_step') as StepDiagnostic['code'];
      const path =
        code === 'path_not_found'
          ? (step as RenameStep | MoveStep | SplitStep).source ??
            (step as MergeStep).sources?.[0] ??
            (step as ExpressionStep).mapEach ??
            null
          : null;
      const messages: Record<StepDiagnostic['code'], string> = {
        invalid_step: 'step configuration is invalid',
        invalid_path: 'path syntax is invalid',
        path_not_found: 'path does not exist after the preceding steps',
        type_mismatch: 'value at the path has the wrong type',
        target_exists: 'target already exists (enable overwrite to replace it)',
        expression_error: 'expression is invalid',
      };
      report(code, messages[code], path);
      // Keep the pre-step shape so later diagnostics remain meaningful.
    }
  });
  return diagnostics;
}
