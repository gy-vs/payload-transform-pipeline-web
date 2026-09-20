// Streaming summaries. The preview stream never ships the whole document per
// step: each event carries a bounded `summary` tree. Full nodes stay in the
// server-side preview session and are fetched on demand via /node.

import {JsonValue} from './types';

export type KindTag = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface SummaryNode {
  kind: KindTag;
  /** For arrays: element count. For objects: key count. */
  size: number;
  /** For scalars: the value when short, otherwise a truncated preview. */
  preview?: string | number | boolean;
  truncated?: boolean;
  /** For objects: summaries of up to `fieldLimit` keys. */
  fields?: {name: string; node: SummaryNode}[];
  /** For arrays: summaries of up to `fieldLimit` first elements. */
  items?: SummaryNode[];
  /** Set when fields/items were elided; fetch the full node on demand. */
  hasMore?: boolean;
}

export const MAX_INLINE_CHARS = 80;
export const FIELD_LIMIT = 20;
export const ARRAY_ITEM_LIMIT = 10;

export function kindOf(value: JsonValue): KindTag {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as KindTag;
}

function summarizeScalar(value: string | number | boolean): SummaryNode {
  if (typeof value === 'string') {
    const truncated = value.length > MAX_INLINE_CHARS;
    return {
      kind: 'string',
      size: value.length,
      preview: truncated ? value.slice(0, MAX_INLINE_CHARS) : value,
      truncated,
    };
  }
  return {kind: typeof value === 'number' ? 'number' : 'boolean', size: 0, preview: value};
}

/** A bounded summary, depth 2: object keys / array items are themselves
 *  summarized (counts + scalar previews), never inlined wholesale. */
export function summarize(value: JsonValue): SummaryNode {
  const kind = kindOf(value);
  if (kind === 'null') return {kind: 'null', size: 0};
  if (kind === 'array') {
    const array = value as JsonValue[];
    return {
      kind: 'array',
      size: array.length,
      items: array.slice(0, ARRAY_ITEM_LIMIT).map(shallowSummary),
      hasMore: array.length > ARRAY_ITEM_LIMIT,
    };
  }
  if (kind === 'object') {
    const entries = Object.entries(value as Record<string, JsonValue>);
    return {
      kind: 'object',
      size: entries.length,
      fields: entries.slice(0, FIELD_LIMIT).map(([name, child]) => ({name, node: shallowSummary(child)})),
      hasMore: entries.length > FIELD_LIMIT,
    };
  }
  return summarizeScalar(value as string | number | boolean);
}

/** Level-2 summary: counts and previews only, no nested children. */
function shallowSummary(value: JsonValue): SummaryNode {
  const kind = kindOf(value);
  if (kind === 'null') return {kind: 'null', size: 0};
  if (kind === 'array') return {kind: 'array', size: (value as JsonValue[]).length, hasMore: (value as JsonValue[]).length > 0};
  if (kind === 'object') {
    const keys = Object.keys(value as Record<string, JsonValue>);
    return {kind: 'object', size: keys.length, hasMore: keys.length > 0};
  }
  return summarizeScalar(value as string | number | boolean);
}

export interface StepStreamEvent {
  type: 'step';
  index: number;
  stepId: string;
  op: string;
  changed: {
    sources: string[];
    targets: string[];
  };
  summary: SummaryNode;
}

export interface DoneStreamEvent {
  type: 'done';
  outputSummary: SummaryNode;
}

export interface ErrorStreamEvent {
  type: 'error';
  failedIndex: number;
  stepId: string;
  code: string;
  message: string;
  sourcePath: string | null;
  /** Summary of the pre-failure state for context. Never labelled output. */
  preStateSummary: SummaryNode;
  /** Step index to use when expanding preStateSummary: N-1 for a failure at
   *  step N, or -1 when the failure happened on the first step (input). */
  preStateStepIndex: number;
}

/** Rough serialized size for tests asserting summaries stay bounded. */
export function summaryByteSize(node: SummaryNode): number {
  return JSON.stringify(node).length;
}
