import {runPipeline} from './engine';
import {parsePath, PathError, get, isMissing} from './path';
import {compile, ExpressionError} from './expression';
import type {JsonValue, Step, StepDiagnostic} from './types';

/**
 * Validate a pipeline against a sample document. Path references for each
 * step are checked against the shape produced by the steps before it — the
 * same sequential semantics as execution — so reordering a move before a
 * compute that reads the moved path surfaces a fresh diagnostic.
 */
export function validatePipeline(
  steps: Step[],
  sample: JsonValue | null,
): StepDiagnostic[] {
  const diagnostics: StepDiagnostic[] = [];
  const seenIds = new Set<string>();

  steps.forEach((step, index) => {
    const push = (code: string, message: string, path?: string, severity: 'error' | 'warning' = 'error') =>
      diagnostics.push({stepId: step.id, index, severity, code, message, path});

    if (!step.id || seenIds.has(step.id)) push('duplicate_step_id', `duplicate or empty step id: ${step.id}`);
    seenIds.add(step.id);

    const structural = (path: string | undefined, label: string): boolean => {
      if (!path) {
        push('missing_path', `${label} path is required`);
        return false;
      }
      try {
        parsePath(path);
      } catch (err) {
        if (err instanceof PathError) push('invalid_path', err.message, path);
        return false;
      }
      return true;
    };

    switch (step.kind) {
      case 'rename':
      case 'move':
        structural(step.source, 'source');
        structural(step.target, 'target');
        break;
      case 'split': {
        structural(step.source, 'source');
        (step.targets ?? []).forEach(t => structural(t, 'split target'));
        if ((step.targets ?? []).length === 0) push('missing_targets', 'split needs at least one target');
        break;
      }
      case 'merge': {
        (step.sources ?? []).forEach(s => structural(s, 'merge source'));
        structural(step.target, 'target');
        if ((step.sources ?? []).length === 0) push('missing_sources', 'merge needs at least one source');
        break;
      }
      case 'compute': {
        structural(step.source, 'source');
        structural(step.target, 'target');
        const expr = (step.expression ?? '').trim();
        if (!expr) {
          push('missing_expression', 'compute step needs an expression');
        } else {
          try {
            compile(expr);
          } catch (err) {
            if (err instanceof ExpressionError) push('invalid_expression', err.message);
          }
        }
        const wcSource = step.source?.includes('[*]') ?? false;
        const wcTarget = step.target?.includes('[*]') ?? false;
        if (wcSource !== wcTarget) {
          push('wildcard_mismatch', 'source and target must both use [*] or neither');
        }
        break;
      }
    }
  });

  // Structural/compile errors above can make sequential checks meaningless;
  // still run them against the sample so the UI sees live path diagnostics.
  if (sample !== null && !Array.isArray(sample) && typeof sample === 'object') {
    const run = runPipeline(sample, steps);
    if (run.status === 'error') {
      const e = run.error;
      const step = steps[e.index];
      const severity = step?.ignoreMissing && e.code === 'missing_source' ? 'warning' : 'error';
      // Avoid duplicating a syntax diagnostic already emitted above.
      if (!diagnostics.some(d => d.index === e.index && d.code === e.code && d.path === e.sourcePath)) {
        diagnostics.push({
          stepId: e.stepId,
          index: e.index,
          severity,
          code: e.code,
          message: e.message,
          path: e.sourcePath,
        });
      }
    }
  }

  return diagnostics.sort((a, b) => a.index - b.index);
}

/** Cheap check whether a concrete path currently exists in a document. */
export function pathExists(doc: JsonValue, path: string): boolean {
  try {
    return !isMissing(get(doc, path));
  } catch {
    return false;
  }
}
