// Minimal JSON-Pointer style paths with array support and one wildcard level.
//
//   $.user.addresses[*].city      -> ["$","user","addresses","[*]","city"]
//   $.items[0].sku                -> ["$","items","[0]","sku"]
//
// `[*]` maps every element of an array. A step's source/target must contain
// the same number of wildcards, in the same positions, so mappings pair up.

import {JsonObject, JsonValue, isObject} from './types';

export type Segment = {kind: 'root'} | {kind: 'key'; value: string} | {kind: 'index'; value: number} | {kind: 'wildcard'};

export function parsePath(path: string): Segment[] {
  const text = path.trim();
  if (!text.startsWith('$')) {
    throw new Error(`path must start with '$': ${path}`);
  }
  const segments: Segment[] = [{kind: 'root'}];
  let i = 1;
  const readKey = (raw: string) => {
    const key = raw.trim();
    if (key === '') throw new Error(`empty key in path: ${path}`);
    segments.push({kind: 'key', value: key});
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.') {
      i += 1;
      let key = '';
      while (i < text.length && text[i] !== '.' && text[i] !== '[') {
        key += text[i];
        i += 1;
      }
      readKey(key);
    } else if (ch === '[') {
      const end = text.indexOf(']', i);
      if (end === -1) throw new Error(`unclosed '[' in path: ${path}`);
      const inner = text.slice(i + 1, end).trim();
      if (inner === '*') {
        segments.push({kind: 'wildcard'});
      } else if (/^\d+$/.test(inner)) {
        segments.push({kind: 'index', value: Number(inner)});
      } else {
        // Allow $.x["my.key"]
        const quoted = inner.match(/^(['"])(.*)\1$/);
        if (quoted) {
          readKey(quoted[2]);
        } else {
          throw new Error(`invalid bracket expression '${inner}' in path: ${path}`);
        }
      }
      i = end + 1;
    } else {
      throw new Error(`unexpected character '${ch}' in path: ${path}`);
    }
  }
  return segments;
}

export function formatPath(segments: Segment[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.kind === 'root') out = '$';
    else if (segment.kind === 'key') {
      out += /^[A-Za-z_$][\w$]*$/.test(segment.value)
        ? (out ? `.${segment.value}` : segment.value)
        : `["${segment.value}"]`;
    } else if (segment.kind === 'index') out += `[${segment.value}]`;
    else out += '[*]';
  }
  return out;
}

/** Returns `[container, lastSegment]` for the parent of the path, or null
 *  when the path is the root or a parent segment does not exist. */
export function resolveParent(
  root: JsonValue,
  segments: Segment[]
): [JsonObject | JsonValue[], string | number] | null {
  if (segments.length < 2) return null;
  let current: JsonValue = root;
  for (let i = 1; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment.kind === 'key') {
      if (!isObject(current)) return null;
      if (!(segment.value in current)) return null;
      current = current[segment.value];
    } else if (segment.kind === 'index') {
      if (!Array.isArray(current) || segment.value < 0 || segment.value >= current.length) return null;
      current = current[segment.value];
    } else {
      // Wildcards cannot be traversed to a single parent.
      return null;
    }
  }
  const last = segments[segments.length - 1];
  if (last.kind === 'key') return [current as JsonObject, last.value];
  if (last.kind === 'index') return [current as JsonValue[], last.value];
  return null;
}

export function getValue(root: JsonValue, path: string): {found: boolean; value: JsonValue} {
  const segments = parsePath(path);
  const parent = resolveParent(root, segments);
  if (!parent) return {found: false, value: null};
  const [container, key] = parent;
  if (Array.isArray(container)) {
    if (typeof key !== 'number' || key < 0 || key >= container.length) return {found: false, value: null};
    return {found: true, value: container[key]};
  }
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(container, key)) {
    return {found: false, value: null};
  }
  return {found: true, value: container[key]};
}

export function setValue(root: JsonValue, path: string, value: JsonValue): void {
  const segments = parsePath(path);
  const parent = resolveParent(root, segments);
  if (!parent) throw new Error(`cannot resolve target parent: ${path}`);
  const [container, key] = parent;
  if (Array.isArray(container)) {
    if (typeof key !== 'number' || key < 0 || key > container.length) {
      throw new Error(`index ${String(key)} out of bounds: ${path}`);
    }
    container[key] = value;
  } else {
    container[key as string] = value;
  }
}

export function removeValue(root: JsonValue, path: string): boolean {
  const segments = parsePath(path);
  const parent = resolveParent(root, segments);
  if (!parent) return false;
  const [container, key] = parent;
  if (Array.isArray(container)) {
    if (typeof key !== 'number' || key >= container.length) return false;
    container.splice(key, 1);
    return true;
  }
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(container, key)) return false;
  delete container[key];
  return true;
}

export function targetExists(root: JsonValue, path: string): boolean {
  const lookup = getValue(root, path);
  return lookup.found && lookup.value !== null && lookup.value !== undefined;
}

/** Expand a path containing wildcards into concrete paths by reading the
 *  current data. `sourcePaths` for missing wildcard positions are still
 *  produced (paired against `templatePaths`). */
export function expandWildcards(
  root: JsonValue,
  sourcePath: string,
  targetPath: string
): {sources: string[]; targets: string[]} {
  const sourceSegments = parsePath(sourcePath);
  const targetSegments = parsePath(targetPath);
  const wildcardIndexes: number[] = [];
  for (let i = 0; i < sourceSegments.length; i += 1) {
    const a = sourceSegments[i]?.kind === 'wildcard';
    const b = targetSegments[i]?.kind === 'wildcard';
    if (a !== b) throw new Error(`wildcards must line up: ${sourcePath} -> ${targetPath}`);
    if (a) wildcardIndexes.push(i);
  }
  if (sourceSegments.some((segment) => segment.kind === 'wildcard') &&
      sourceSegments.length !== targetSegments.length) {
    throw new Error(`wildcard source and target must have the same depth: ${sourcePath} -> ${targetPath}`);
  }
  if (wildcardIndexes.length === 0) return {sources: [sourcePath], targets: [targetPath]};
  if (wildcardIndexes.length > 1) throw new Error('only one wildcard level is supported');

  // Navigate to the array.
  const wildcardIndex = wildcardIndexes[0];
  let array: JsonValue = root;
  for (let i = 1; i < wildcardIndex; i += 1) {
    const segment = sourceSegments[i];
    if (segment.kind === 'key') {
      if (!isObject(array) || !(segment.value in array)) {
        throw {code: 'path_not_found', message: `container not found: ${formatPath(sourceSegments.slice(0, i + 1))}`, sourcePath};
      }
      array = array[segment.value];
    } else if (segment.kind === 'index') {
      if (!Array.isArray(array) || segment.value >= array.length) {
        throw {code: 'path_not_found', message: `array index not found: ${formatPath(sourceSegments.slice(0, i + 1))}`, sourcePath};
      }
      array = array[segment.value];
    }
  }
  if (!Array.isArray(array)) {
    throw {code: 'type_mismatch', message: `[*] requires an array at: ${formatPath(sourceSegments.slice(0, wildcardIndex))}`, sourcePath};
  }

  const sources: string[] = [];
  const targets: string[] = [];
  const concrete = (segments: Segment[], index: number): Segment[] =>
    segments.map((segment) => (segment.kind === 'wildcard' ? {kind: 'index', value: index} : segment));
  for (let index = 0; index < array.length; index += 1) {
    sources.push(formatPath(concrete(sourceSegments, index)));
    targets.push(formatPath(concrete(targetSegments, index)));
  }
  return {sources, targets};
}
