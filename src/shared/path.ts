// Dotted-path + JSON-pointer-ish addressing with first-class distinction
// between MISSING and EXPLICIT NULL.
//
//   $.user.name         object field
//   $.items[0].id       array index (must exist)
//   $.items[*].id       wildcard over every element
//
// A literal key containing "." or "[" can be written bracket-quoted:
//   $["weird.key"][2]

import type {JsonArray, JsonValue} from './types';

export type Segment =
  | { type: 'key'; value: string }
  | { type: 'index'; value: number }
  | { type: 'wildcard' };

const TOKEN_RE = /(?:\.([A-Za-z_$][\w$]*))|(?:\[(\d+)\])|\[\*\]|\["((?:[^"\\]|\\.)*)"\]/gy;

export function parsePath(input: string): Segment[] {
  const raw = input.trim();
  if (!raw.startsWith('$')) {
    throw new PathError(`path must start with "$": ${input}`, input);
  }
  const segments: Segment[] = [];
  let pos = 1;
  const re = new RegExp(TOKEN_RE);
  re.lastIndex = 1;
  while (pos < raw.length) {
    const m = re.exec(raw);
    if (!m || m.index !== pos) {
      throw new PathError(`invalid path near "${raw.slice(pos)}": ${input}`, input);
    }
    if (m[1] !== undefined) segments.push({type: 'key', value: m[1]});
    else if (m[2] !== undefined) segments.push({type: 'index', value: Number(m[2])});
    else if (m[3] !== undefined) segments.push({type: 'key', value: unescapeQuoted(m[3])});
    else segments.push({type: 'wildcard'});
    pos = re.lastIndex;
  }
  return segments;
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

export class PathError extends Error {
  path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = 'PathError';
    this.path = path;
  }
}

export class Missing {
  static readonly INSTANCE = new Missing();
  private constructor() {}
}
export type LookupResult = JsonValue | Missing;
export const MISSING = Missing.INSTANCE;

export function isMissing(v: LookupResult): v is Missing {
  return v === MISSING;
}

export function hasWildcard(segments: Segment[]): boolean {
  return segments.some(s => s.type === 'wildcard');
}

/** Resolve a concrete (non-wildcard) path. Returns MISSING, never throws. */
export function get(root: JsonValue, path: string | Segment[]): LookupResult {
  const segs = typeof path === 'string' ? safeParse(path) : path;
  let cur: JsonValue = root;
  for (const seg of segs) {
    if (cur === null) return MISSING; // null has no children — not an error, just absent
    if (seg.type === 'key') {
      if (typeof cur !== 'object' || Array.isArray(cur)) return MISSING;
      if (!Object.prototype.hasOwnProperty.call(cur, seg.value)) return MISSING;
      cur = cur[seg.value] as JsonValue;
    } else if (seg.type === 'index') {
      if (!Array.isArray(cur)) return MISSING;
      if (seg.value < 0 || seg.value >= cur.length) return MISSING;
      cur = cur[seg.value] as JsonValue;
    } else {
      return MISSING;
    }
  }
  return cur;
}

function safeParse(path: string): Segment[] {
  try {
    return parsePath(path);
  } catch {
    return [];
  }
}

export interface ResolvedTarget {
  parent: JsonValue;
  key: string | number;
  /** path of the final assignment, wildcard-expanded where possible */
  resolvedPath: string;
}

/**
 * Locate the parent container for assignment, creating intermediate objects.
 * For wildcard paths the wildcard must resolve against an existing array;
 * every element becomes an assignment target.
 */
export function resolveTargets(root: JsonValue, path: string): ResolvedTarget[] {
  const segs = parsePath(path);
  if (!hasWildcard(segs)) {
    const parent = ensureParent(root, segs.slice(0, -1), path);
    const last = segs[segs.length - 1];
    return [{
      parent,
      key: last.type === 'index' ? last.value : last.type === 'key' ? last.value : '*',
      resolvedPath: path,
    }];
  }
  // Expand wildcard: everything before it must exist concretely.
  const wIdx = segs.findIndex(s => s.type === 'wildcard');
  const containerLookup = get(root, segs.slice(0, wIdx));
  if (isMissing(containerLookup) || !Array.isArray(containerLookup)) return [];
  const container: JsonArray = containerLookup;
  const tail = segs.slice(wIdx + 1);
  const out: ResolvedTarget[] = [];
  const prefixPath = path.slice(0, path.indexOf('[*]'));
  container.forEach((_el: JsonValue, i: number) => {
    const elementPath = `${prefixPath}[${i}]`;
    if (tail.length === 0) {
      out.push({parent: container, key: i, resolvedPath: elementPath});
      return;
    }
    const parent = ensureParent(container[i], tail.slice(0, -1), path);
    const last = tail[tail.length - 1];
    out.push({
      parent,
      key: last.type === 'index' ? last.value : last.type === 'key' ? last.value : '*',
      resolvedPath: `${elementPath}${renderTail(tail)}`,
    });
  });
  return out;
}

function renderTail(segs: Segment[]): string {
  return segs.map(s =>
    s.type === 'key' ? `.${s.value}` : s.type === 'index' ? `[${s.value}]` : '[*]'
  ).join('');
}

function ensureParent(root: JsonValue, prefix: Segment[], fullPath: string): JsonValue {
  if (prefix.length === 0) {
    if (Array.isArray(root) || (typeof root === 'object' && root !== null)) return root;
    throw new PathError(`cannot write into scalar at ${fullPath}`, fullPath);
  }
  let cur = root;
  for (const seg of prefix) {
    if (seg.type === 'key') {
      if (typeof cur !== 'object' || Array.isArray(cur) || cur === null) {
        throw new PathError(`expected object while resolving ${fullPath}`, fullPath);
      }
      const next = cur[seg.value];
      if (next === undefined || next === null) {
        const created: JsonValue = {};
        cur[seg.value] = created;
        cur = created;
      } else {
        cur = next;
      }
    } else if (seg.type === 'index') {
      if (!Array.isArray(cur)) {
        throw new PathError(`expected array while resolving ${fullPath}`, fullPath);
      }
      while (cur.length <= seg.value) cur.push(null);
      const slot = cur[seg.value];
      if (slot === null || slot === undefined) {
        const created: JsonValue = {};
        cur[seg.value] = created;
        cur = created;
      } else {
        cur = slot;
      }
    } else {
      throw new PathError('[*] is only supported as the last fan-out segment', fullPath);
    }
  }
  return cur;
}

export function setAt(target: ResolvedTarget, value: JsonValue): boolean {
  if (Array.isArray(target.parent)) {
    const k = target.key as number;
    const existed = k < target.parent.length;
    target.parent[k] = value;
    return existed;
  }
  if (typeof target.parent === 'object' && target.parent !== null) {
    const k = String(target.key);
    const existed = Object.prototype.hasOwnProperty.call(target.parent, k);
    target.parent[k] = value;
    return existed;
  }
  throw new PathError(`assignment target is not a container: ${target.resolvedPath}`, target.resolvedPath);
}

export function deleteAt(root: JsonValue, path: string): boolean {
  const segs = parsePath(path);
  if (hasWildcard(segs)) throw new PathError(`delete does not support wildcards: ${path}`, path);
  const parentLookup: LookupResult = get(root, segs.slice(0, -1));
  if (isMissing(parentLookup) || parentLookup === null) return false;
  const parent = parentLookup as JsonValue;
  const last = segs[segs.length - 1];
  if (Array.isArray(parent)) {
    if (last.type !== 'index') return false;
    if (last.value < 0 || last.value >= parent.length) return false;
    parent.splice(last.value, 1);
    return true;
  }
  if (typeof parent === 'object') {
    if (parent === null) return false;
    const k = last.type === 'key' ? last.value : String((last as {value: number}).value);
    if (!Object.prototype.hasOwnProperty.call(parent, k)) return false;
    delete parent[k];
    return true;
  }
  return false;
}

/** Expand a wildcard read path into concrete paths that currently exist. */
export function expandWildcard(root: JsonValue, path: string): string[] {
  const segs = parsePath(path);
  const wIdx = segs.findIndex(s => s.type === 'wildcard');
  if (wIdx === -1) return [path];
  const containerLookup = get(root, segs.slice(0, wIdx));
  if (isMissing(containerLookup) || !Array.isArray(containerLookup)) return [];
  const container: JsonArray = containerLookup;
  const prefixPath = path.slice(0, path.indexOf('[*]'));
  const tail = renderTail(segs.slice(wIdx + 1));
  return container.map((_el: JsonValue, i: number) => `${prefixPath}[${i}]${tail}`);
}