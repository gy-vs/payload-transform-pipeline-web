// Shared type definitions for the payload migration workbench.
// These types are used by both the server (preview/persistence) and the
// browser client (editors, local validation).

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | {[key: string]: JsonValue};
export type JsonObject = {[key: string]: JsonValue};

export type OpType = 'rename' | 'move' | 'split' | 'merge' | 'expression';

export type MergeStrategy = 'deep' | 'concat' | 'join';

export interface RenameStep {
  id: string;
  op: 'rename';
  /** Source path, may contain [*] to map every element of an array. */
  source: string;
  /** Target path (same number of wildcards as source). */
  target: string;
  /** When true a missing source is skipped instead of failing the step. */
  optional?: boolean;
  /** Must be true when the target already holds a value. */
  overwrite?: boolean;
}

export interface MoveStep {
  id: string;
  op: 'move';
  source: string;
  target: string;
  optional?: boolean;
  overwrite?: boolean;
}

export interface SplitStep {
  id: string;
  op: 'split';
  source: string;
  /** Literal delimiter. An empty delimiter splits into characters. */
  delimiter: string;
  /** Target paths receiving the parts, in order. */
  targets: string[];
  optional?: boolean;
  overwrite?: boolean;
  keepSource?: boolean;
  /** When true, surplus parts are appended (joined) onto the last target. */
  extraIntoLast?: boolean;
}

export interface MergeStep {
  id: string;
  op: 'merge';
  sources: string[];
  target: string;
  strategy: MergeStrategy;
  /** Joiner for strategy 'join'. Defaults to a single space. */
  joiner?: string;
  /** Sources that are allowed to be absent (null is still a real value). */
  optionalSources?: string[];
}

export interface ExpressionStep {
  id: string;
  op: 'expression';
  /** Expression evaluated in a scope: input paths plus `$` (root). */
  expr: string;
  /** Absolute target path, or a relative field when mapEach is set. */
  target: string;
  inputs?: Record<string, string>;
  /** When set, the expression runs once per element of this array path.
   *  `item` and `index` are in scope and target is relative to the item. */
  mapEach?: string;
  overwrite?: boolean;
  /** Declared output type, checked after evaluation. */
  outputType?: 'string' | 'number' | 'boolean' | 'object' | 'array';
}

export type Step = RenameStep | MoveStep | SplitStep | MergeStep | ExpressionStep;

export type ErrorCode =
  | 'invalid_step'
  | 'invalid_path'
  | 'path_not_found'
  | 'type_mismatch'
  | 'target_exists'
  | 'expression_error'
  | 'split_overflow';

export interface SourceError {
  code: ErrorCode;
  message: string;
  /** Concrete source path involved, when one is attributable. */
  sourcePath: string | null;
}

/** Failure result of a pipeline run. `preState` is a diagnostic snapshot of
 *  the state immediately BEFORE the failed step. It is never returned as
 *  `output`: a failed run has no final output at all. */
export interface PipelineFailure extends SourceError {
  ok: false;
  failedIndex: number;
  stepId: string;
  preState: JsonValue;
}

export interface PipelineSuccess {
  ok: true;
  output: JsonValue;
}

export type PipelineResult = PipelineSuccess | PipelineFailure;

export interface PipelineDoc {
  id: string;
  name: string;
  steps: Step[];
  revision: number;
  updatedAt: string;
}

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
