// Shared between server and client. Keep this file free of runtime imports.

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonObject | JsonArray;
export interface JsonObject { [key: string]: JsonValue }
export type JsonArray = JsonValue[];

export type StepKind = 'rename' | 'move' | 'split' | 'merge' | 'compute';
export type OnConflict = 'overwrite' | 'skip' | 'error';
export type MergeMode = 'concat' | 'join' | 'object';

/**
 * One transformation step. Which fields are relevant depends on `kind`:
 *  rename  : source -> target (same parent, new key name)
 *  move    : source -> target (deleteSource=false means copy)
 *  split   : source string/array -> targets[] (one per part)
 *  merge   : sources[] -> target (join mode)
 *  compute : source -> target via expression (source/target may contain [*])
 */
export interface Step {
  id: string;
  kind: StepKind;
  description?: string;
  source?: string;
  target?: string;
  sources?: string[];
  targets?: string[];
  expression?: string;
  separator?: string;
  join?: MergeMode;
  deleteSource?: boolean;
  ignoreMissing?: boolean;
  onConflict?: OnConflict;
}

export interface Pipeline {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  steps: Step[];
}

export interface PipelineSummary {
  id: string;
  name: string;
  revision: number;
  stepCount: number;
  updatedAt: string;
}

// --- validation -----------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning';

export interface StepDiagnostic {
  stepId: string;
  index: number;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResponse {
  ok: boolean;
  revision: number | null;
  diagnostics: StepDiagnostic[];
}

// --- execution summaries (streamed, shallow) ------------------------------

export type ValueKind =
  | 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export type NodeSummary =
  | { kind: 'object'; fieldCount: number; fields: { name: string; type: ValueKind }[]; truncated: boolean }
  | { kind: 'array'; length: number; elementTypes: Partial<Record<ValueKind, number>>; head: ValueKind[] }
  | { kind: 'scalar'; scalar: 'string' | 'number' | 'boolean' | 'null' };

export interface StepChange {
  op: 'set' | 'delete' | 'noop';
  path: string;
  from?: string;
  detail?: string;
}

export interface StepResult {
  index: number;
  stepId: string;
  kind: StepKind;
  changes: StepChange[];
  after: NodeSummary;
  durationMs: number;
}

export interface StepFailurePayload {
  code: string;
  message: string;
  index: number;
  stepId: string;
  sourcePath?: string;
  preStatePath?: string;
  preState?: JsonValue;
  preStateTruncated?: boolean;
}

// --- SSE events -----------------------------------------------------------

export type StreamEvent =
  | { type: 'start'; executionId: string; totalSteps: number }
  | ({ type: 'step' } & StepResult)
  | { type: 'done'; executionId: string }
  | ({ type: 'error' } & StepFailurePayload);

export interface ExecutionResponse {
  executionId: string;
  output: JsonValue;
  steps: StepResult[];
}
