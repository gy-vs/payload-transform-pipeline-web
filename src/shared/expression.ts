// Deliberately tiny sandboxed expression language — no eval/Function.
//
// Available names : v / value (the looked-up source, null if absent),
//                   root ($root doc), index (wildcard position, -1 otherwise)
// Null propagation: a.b.c on a null/missing chain yields null rather than throwing.
// Missing vs null : use isMissing(v) — a genuinely absent source is distinguished
//                   from an explicit JSON null.
// Functions       : coalesce, concat, upper, lower, trim, length, split, join,
//                   number, string, bool, isMissing, if(cond,then,else), round

import type {JsonValue} from './types';

type Scope = {value: JsonValue | undefined; root: JsonValue; index: number};

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punc'; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') { out += src[j + 1] ?? ''; j += 2; }
        else { out += src[j]; j++; }
      }
      if (src[j] !== quote) throw new ExpressionError('unterminated string literal');
      tokens.push({t: 'str', v: out});
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = Number(src.slice(i, j));
      if (Number.isNaN(num)) throw new ExpressionError(`bad number "${src.slice(i, j)}"`);
      tokens.push({t: 'num', v: num});
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      tokens.push({t: 'ident', v: src.slice(i, j)});
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (three === '===' || three === '!==') { tokens.push({t: 'op', v: three}); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({t: 'op', v: two}); i += 2; continue;
    }
    if ('+-*/%<>!'.includes(c)) { tokens.push({t: 'op', v: c}); i++; continue; }
    if ('()[],.?:'.includes(c)) { tokens.push({t: 'punc', v: c}); i++; continue; }
    throw new ExpressionError(`unexpected character "${c}"`);
  }
  return tokens;
}

// AST ----------------------------------------------------------------------

type Node =
  | { k: 'lit'; v: JsonValue }
  | { k: 'name'; v: string }
  | { k: 'un'; op: string; x: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'get'; o: Node; prop: string }
  | { k: 'idx'; o: Node; i: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'cond'; test: Node; yes: Node; no: Node };

function parse(tokens: Token[]): Node {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (v?: string) => {
    const tk = tokens[p];
    if (v !== undefined && (!tk || tk.v !== v)) throw new ExpressionError(`expected "${v}"`);
    p++;
    return tk;
  };

  function parseExpr(minPrec: number): Node {
    let left = parseUnary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== 'op') break;
      const prec = BIN_PREC[tk.v];
      if (prec === undefined || prec < minPrec) break;
      eat();
      const right = parseExpr(prec + 1);
      left = {k: 'bin', op: tk.v, l: left, r: right};
    }
    return left;
  }

  function parseUnary(): Node {
    const tk = peek();
    if (tk && tk.t === 'op' && (tk.v === '!' || tk.v === '-')) {
      eat();
      return {k: 'un', op: tk.v, x: parseUnary()};
    }
    return parsePostfix();
  }

  function parsePostfix(): Node {
    let node = parsePrimary();
    for (;;) {
      const tk = peek();
      if (tk && tk.t === 'punc' && tk.v === '.') {
        eat('.');
        const name = eat();
        if (!name || name.t !== 'ident') throw new ExpressionError('expected property name after "."');
        node = {k: 'get', o: node, prop: name.v};
      } else if (tk && tk.t === 'punc' && tk.v === '[') {
        eat('[');
        const idx = parseExpr(0);
        eat(']');
        node = {k: 'idx', o: node, i: idx};
      } else break;
    }
    return node;
  }

  function parsePrimary(): Node {
    const tk = eat();
    if (!tk) throw new ExpressionError('unexpected end of expression');
    if (tk.t === 'num') return {k: 'lit', v: tk.v};
    if (tk.t === 'str') return {k: 'lit', v: tk.v};
    if (tk.t === 'ident') {
      if (tk.v === 'true') return {k: 'lit', v: true};
      if (tk.v === 'false') return {k: 'lit', v: false};
      if (tk.v === 'null') return {k: 'lit', v: null};
      if (peek()?.t === 'punc' && peek()?.v === '(') {
        eat('(');
        const args: Node[] = [];
        if (peek()?.v !== ')') {
          args.push(parseExpr(0));
          while (peek()?.v === ',') { eat(','); args.push(parseExpr(0)); }
        }
        eat(')');
        return {k: 'call', name: tk.v, args};
      }
      return {k: 'name', v: tk.v};
    }
    if (tk.t === 'punc' && tk.v === '(') {
      const inner = parseTernary();
      eat(')');
      return inner;
    }
    throw new ExpressionError(`unexpected token "${tk.v}"`);
  }

  function parseTernary(): Node {
    const test = parseExpr(0);
    if (peek()?.t === 'punc' && peek()?.v === '?') {
      eat('?');
      const yes = parseTernary();
      eat(':');
      const no = parseTernary();
      return {k: 'cond', test, yes, no};
    }
    return test;
  }

  const root = parseTernary();
  if (p < tokens.length) throw new ExpressionError(`unexpected token "${tokens[p].v}"`);
  return root;
}

const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3, '===': 3, '!==': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

// Evaluation ---------------------------------------------------------------

const MISSING = Symbol('missing');
type Dyn = JsonValue | typeof MISSING;

function evalNode(node: Node, scope: Scope): Dyn {
  switch (node.k) {
    case 'lit': return node.v;
    case 'name': {
      if (node.v === 'v' || node.v === 'value' || node.v === 'el') {
        return scope.value === undefined ? MISSING : scope.value;
      }
      if (node.v === 'root' || node.v === '$root' || node.v === '$') return scope.root;
      if (node.v === 'index' || node.v === 'i') return scope.index;
      throw new ExpressionError(`unknown identifier "${node.v}"`);
    }
    case 'un': {
      const x = evalNode(node.x, scope);
      if (x === MISSING || x === null) return node.op === '!' ? true : null;
      if (node.op === '!') return !truthy(x);
      if (typeof x !== 'number') throw new ExpressionError(`unary "-" needs a number, got ${typeName(x)}`);
      return -x;
    }
    case 'bin': return evalBin(node, scope);
    case 'get': return readProp(evalNode(node.o, scope), node.prop);
    case 'idx': {
      const o = evalNode(node.o, scope);
      if (o === MISSING || o === null) return null;
      const i = evalNode(node.i, scope);
      return readProp(o, String(i));
    }
    case 'call': return evalCall(node, scope);
    case 'cond': {
      const t = evalNode(node.test, scope);
      return truthy(t) ? evalNode(node.yes, scope) : evalNode(node.no, scope);
    }
  }
}

function readProp(o: Dyn, prop: string): Dyn {
  if (o === MISSING || o === null) return null; // null propagation
  if (typeof o !== 'object') throw new ExpressionError(`cannot read "${prop}" from ${typeName(o)}`);
  if (Array.isArray(o)) {
    const n = Number(prop);
    if (Number.isInteger(n)) return n >= 0 && n < o.length ? o[n] : null;
    if (prop === 'length') return o.length;
    return null;
  }
  return Object.prototype.hasOwnProperty.call(o, prop) ? (o as Record<string, JsonValue>)[prop] : MISSING;
}

function truthy(x: Dyn): boolean {
  if (x === MISSING || x === null || x === false) return false;
  if (x === 0 || x === '') return false;
  return true;
}

function evalBin(node: Extract<Node, {k: 'bin'}>, scope: Scope): JsonValue {
  const l = evalNode(node.l, scope);
  const r = evalNode(node.r, scope);
  const op = node.op;
  if (op === '&&') return truthy(l) ? toJson(r) : toJson(l);
  if (op === '||') return truthy(l) ? toJson(l) : toJson(r);
  if (l === MISSING || r === MISSING || l === null || r === null) {
    // equality can still be answered; arithmetic null-propagates
    if (op === '==' || op === '===') return looseEq(l, r);
    if (op === '!=' || op === '!==') return !looseEq(l, r);
    return null;
  }
  switch (op) {
    case '+':
      if (typeof l === 'string' || typeof r === 'string') return stringify(l) + stringify(r);
      return assertNum(l, op) + assertNum(r, op);
    case '-': return assertNum(l, op) - assertNum(r, op);
    case '*': return assertNum(l, op) * assertNum(r, op);
    case '/':
      if (r === 0) throw new ExpressionError('division by zero');
      return assertNum(l, op) / assertNum(r, op);
    case '%': return assertNum(l, op) % assertNum(r, op);
    case '<': return cmp(l, r) < 0;
    case '<=': return cmp(l, r) <= 0;
    case '>': return cmp(l, r) > 0;
    case '>=': return cmp(l, r) >= 0;
    case '==': case '===': return looseEq(l, r);
    case '!=': case '!==': return !looseEq(l, r);
    default: throw new ExpressionError(`unsupported operator ${op}`);
  }
}

function looseEq(l: Dyn, r: Dyn): boolean {
  if (l === MISSING || r === MISSING) return l === r;
  return l === r;
}

function cmp(l: JsonValue, r: JsonValue): number {
  if (typeof l === 'number' && typeof r === 'number') return l - r;
  return stringify(l).localeCompare(stringify(r));
}

function assertNum(x: JsonValue, op: string): number {
  if (typeof x !== 'number') throw new ExpressionError(`operator "${op}" needs numbers, got ${typeName(x)}`);
  return x;
}

function typeName(x: Dyn): string {
  if (x === MISSING) return 'missing';
  if (x === null) return 'null';
  if (Array.isArray(x)) return 'array';
  return typeof x;
}

function stringify(x: JsonValue): string {
  if (x === null) return 'null';
  if (typeof x === 'object') return JSON.stringify(x);
  return String(x);
}

function toJson(x: Dyn): JsonValue {
  return x === MISSING ? null : x;
}

function evalCall(node: Extract<Node, {k: 'call'}>, scope: Scope): JsonValue {
  const args = node.args.map(a => evalNode(a, scope));
  const fn = FUNCTIONS[node.name];
  if (!fn) throw new ExpressionError(`unknown function "${node.name}()"`);
  return fn(args);
}

type Fn = (args: Dyn[]) => JsonValue;

const FUNCTIONS: Record<string, Fn> = {
  coalesce: args => toJson(args.find(a => a !== MISSING && a !== null) ?? null),
  concat: args => args.map(a => a === MISSING || a === null ? '' : stringify(a)).join(''),
  upper: a => strArg(a[0], 'upper').toUpperCase(),
  lower: a => strArg(a[0], 'lower').toLowerCase(),
  trim: a => strArg(a[0], 'trim').trim(),
  length: a => {
    const x = a[0];
    if (x === MISSING || x === null) return null;
    if (typeof x === 'string' || Array.isArray(x)) return x.length;
    if (typeof x === 'object') return Object.keys(x).length;
    throw new ExpressionError('length() needs string, array or object');
  },
  split: a => {
    const s = strArg(a[0], 'split');
    const sep = a[1] === MISSING || a[1] === null ? ',' : stringify(a[1] as JsonValue);
    return s.split(sep);
  },
  join: a => {
    const x = a[0];
    if (x === MISSING || x === null) return null;
    if (!Array.isArray(x)) throw new ExpressionError('join() needs an array');
    const sep = a[1] === MISSING || a[1] === null ? '' : stringify(a[1] as JsonValue);
    return x.map(stringify).join(sep);
  },
  number: a => {
    const x = a[0];
    if (x === MISSING || x === null) return null;
    if (typeof x === 'number') return x;
    const n = Number(stringify(x));
    if (Number.isNaN(n)) throw new ExpressionError(`number() cannot parse "${stringify(x)}"`);
    return n;
  },
  string: a => a[0] === MISSING ? null : stringify(a[0] as JsonValue),
  bool: a => truthy(a[0]),
  isMissing: a => a[0] === MISSING,
  isNull: a => a[0] === null,
  if: a => truthy(a[0]) ? toJson(a[1] ?? null) : toJson(a[2] ?? null),
  round: a => {
    const x = a[0];
    if (x === MISSING || x === null) return null;
    if (typeof x !== 'number') throw new ExpressionError('round() needs a number');
    const digits = typeof a[1] === 'number' ? a[1] : 0;
    const f = 10 ** digits;
    return Math.round(x * f) / f;
  },
};

function strArg(x: Dyn, fn: string): string {
  if (x === MISSING || x === null) return '';
  if (typeof x !== 'string') throw new ExpressionError(`${fn}() needs a string, got ${typeName(x)}`);
  return x;
}

// Public API ---------------------------------------------------------------

const cache = new Map<string, Node>();

export function compile(expression: string): Node {
  const hit = cache.get(expression);
  if (hit) return hit;
  if (expression.trim() === '') throw new ExpressionError('empty expression');
  const ast = parse(tokenize(expression));
  cache.set(expression, ast);
  return ast;
}

export function evaluate(
  expression: string,
  scope: Scope,
): JsonValue {
  return toJson(evalNode(compile(expression), scope));
}
