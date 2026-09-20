// Safe expression evaluator: hand-written lexer + Pratt parser, no eval and
// no Function constructor. Expressions run against an explicit scope object;
// free identifiers must exist in that scope. Member access can only touch
// plain data fields; prototype/constructor chains are blocked.

import {JsonValue} from './types';

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type TokenType =
  | 'number'
  | 'string'
  | 'ident'
  | 'op'
  | 'punc'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OPERATORS = [
  '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??',
  '+', '-', '*', '/', '%', '<', '>', '!', '?', ':',
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isIdentStart = (ch: string) => /[A-Za-z_$]/.test(ch);
  const isIdentPart = (ch: string) => /[\w$]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && isIdentPart(source[i])) i += 1;
      tokens.push({type: 'ident', value: source.slice(start, i), pos: start});
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && /[0-9.]/.test(source[i])) i += 1;
      const raw = source.slice(start, i);
      if (!/^\d+(\.\d+)?$/.test(raw)) throw new ExpressionError(`invalid number '${raw}'`);
      tokens.push({type: 'number', value: raw, pos: start});
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i += 1;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          i += 1;
          const escaped = source[i];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
        } else {
          value += source[i];
        }
        i += 1;
      }
      if (source[i] !== quote) throw new ExpressionError('unterminated string literal');
      i += 1;
      tokens.push({type: 'string', value, pos: start});
      continue;
    }
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (OPERATORS.includes(three)) {
      tokens.push({type: 'op', value: three, pos: i});
      i += 3;
      continue;
    }
    if (OPERATORS.includes(two)) {
      tokens.push({type: 'op', value: two, pos: i});
      i += 2;
      continue;
    }
    if ('()[]{},.'.includes(ch)) {
      tokens.push({type: 'punc', value: ch, pos: i});
      i += 1;
      continue;
    }
    if (OPERATORS.includes(ch)) {
      tokens.push({type: 'op', value: ch, pos: i});
      i += 1;
      continue;
    }
    throw new ExpressionError(`unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({type: 'eof', value: '', pos: source.length});
  return tokens;
}

type Node =
  | {kind: 'literal'; value: JsonValue}
  | {kind: 'ident'; name: string}
  | {kind: 'unary'; op: string; arg: Node}
  | {kind: 'binary'; op: string; left: Node; right: Node}
  | {kind: 'conditional'; test: Node; consequent: Node; alternate: Node}
  | {kind: 'member'; object: Node; property: string}
  | {kind: 'call'; callee: Node; args: Node[]};

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private consume(type: TokenType, value?: string): Token {
    const token = this.peek();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new ExpressionError(`expected ${value ?? type} at position ${token.pos}`);
    }
    return this.next();
  }

  parse(): Node {
    const expression = this.parseExpression(0);
    if (this.peek().type !== 'eof') {
      throw new ExpressionError(`unexpected token '${this.peek().value}' at position ${this.peek().pos}`);
    }
    return expression;
  }

  // Pratt parser.
  private prefixPrecedence(): number {
    return 100;
  }

  private binaryPrecedence(op: string): number {
    switch (op) {
      case '?': return 1;
      case '||': case '??': return 2;
      case '&&': return 3;
      case '==': case '!=': case '===': case '!==': return 4;
      case '<': case '>': case '<=': case '>=': return 5;
      case '+': case '-': return 6;
      case '*': case '/': case '%': return 7;
      default: return 0;
    }
  }

  private parseExpression(minPrecedence: number): Node {
    let left = this.parsePrefix();
    for (;;) {
      const token = this.peek();
      if (token.type === 'op' && token.value === '?') {
        if (this.binaryPrecedence('?') < minPrecedence) break;
        this.next();
        const consequent = this.parseExpression(0);
        this.consume('op', ':');
        const alternate = this.parseExpression(this.binaryPrecedence('?'));
        left = {kind: 'conditional', test: left, consequent, alternate};
        continue;
      }
      if (token.type !== 'op') break;
      const precedence = this.binaryPrecedence(token.value);
      if (precedence === 0 || precedence < minPrecedence) break;
      this.next();
      const right = this.parseExpression(precedence + 1);
      left = {kind: 'binary', op: token.value, left, right};
    }
    return left;
  }

  private parsePrefix(): Node {
    const token = this.peek();
    if (token.type === 'op' && (token.value === '-' || token.value === '!')) {
      this.next();
      return {kind: 'unary', op: token.value, arg: this.parseExpression(this.prefixPrecedence())};
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parseAtom();
    for (;;) {
      const token = this.peek();
      if (token.type === 'punc' && token.value === '.') {
        this.next();
        const property = this.consume('ident').value;
        node = {kind: 'member', object: node, property};
      } else if (token.type === 'punc' && token.value === '[') {
        this.next();
        // Only static string/ident keys are supported, no arbitrary evaluation.
        const keyToken = this.next();
        let key: string;
        if (keyToken.type === 'string') key = keyToken.value;
        else if (keyToken.type === 'number') key = keyToken.value;
        else throw new ExpressionError('only literal keys supported inside []');
        this.consume('punc', ']');
        node = {kind: 'member', object: node, property: key};
      } else if (token.type === 'punc' && token.value === '(') {
        this.next();
        const args: Node[] = [];
        if (this.peek().value !== ')') {
          for (;;) {
            args.push(this.parseExpression(0));
            if (this.peek().value === ',') {
              this.next();
              continue;
            }
            break;
          }
        }
        this.consume('punc', ')');
        node = {kind: 'call', callee: node, args};
      } else {
        break;
      }
    }
    return node;
  }

  private parseAtom(): Node {
    const token = this.next();
    if (token.type === 'number') return {kind: 'literal', value: Number(token.value)};
    if (token.type === 'string') return {kind: 'literal', value: token.value};
    if (token.type === 'ident') {
      if (token.value === 'true') return {kind: 'literal', value: true};
      if (token.value === 'false') return {kind: 'literal', value: false};
      if (token.value === 'null') return {kind: 'literal', value: null};
      if (token.value === 'undefined') return {kind: 'literal', value: null};
      return {kind: 'ident', name: token.value};
    }
    if (token.type === 'punc' && token.value === '(') {
      const node = this.parseExpression(0);
      this.consume('punc', ')');
      return node;
    }
    if (token.type === 'punc' && token.value === '[') {
      const elements: Node[] = [];
      if (this.peek().value !== ']') {
        for (;;) {
          elements.push(this.parseExpression(0));
          if (this.peek().value === ',') {
            this.next();
            continue;
          }
          break;
        }
      }
      this.consume('punc', ']');
      // Arrays desugar to a builtin call.
      return {kind: 'call', callee: {kind: 'ident', name: '__array'}, args: elements};
    }
    throw new ExpressionError(`unexpected token '${token.value}' at position ${token.pos}`);
  }
}

const BLOCKED_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  upper: (value) => String(value ?? '').toUpperCase(),
  lower: (value) => String(value ?? '').toLowerCase(),
  trim: (value) => String(value ?? '').trim(),
  string: (value) => (value === null || value === undefined ? null : String(value)),
  number: (value) => {
    if (value === null || value === undefined || value === '') return null;
    const converted = Number(value);
    if (Number.isNaN(converted)) throw new ExpressionError(`cannot convert ${JSON.stringify(value)} to number`);
    return converted;
  },
  coalesce: (...values) => values.find((value) => value !== null && value !== undefined) ?? null,
  concat: (...values) => values.map((value) => String(value ?? '')).join(''),
  includes: (haystack, needle) => String(haystack ?? '').includes(String(needle ?? '')),
  length: (value) => (typeof value === 'string' || Array.isArray(value) ? value.length : null),
  round: (value, digits = 0) => {
    if (value === null || value === undefined) return null;
    const factor = 10 ** Number(digits);
    return Math.round(Number(value) * factor) / factor;
  },
  strpad: (value, width, fill = ' ') => String(value ?? '').padStart(Number(width), String(fill)),
  join: (array, joiner = ',') => (Array.isArray(array) ? array.join(String(joiner)) : null),
  __array: (...values) => values as unknown[],
};

function evaluate(node: Node, scope: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ident':
      if (!Object.prototype.hasOwnProperty.call(scope, node.name)) {
        throw new ExpressionError(`unknown identifier '${node.name}'`);
      }
      return scope[node.name];
    case 'unary': {
      const value = evaluate(node.arg, scope);
      if (node.op === '-') return -Number(value);
      return !truthy(value);
    }
    case 'binary':
      return applyBinary(node.op, evaluate(node.left, scope), evaluate(node.right, scope));
    case 'conditional':
      return truthy(evaluate(node.test, scope))
        ? evaluate(node.consequent, scope)
        : evaluate(node.alternate, scope);
    case 'member': {
      const object = evaluate(node.object, scope);
      if (BLOCKED_PROPERTIES.has(node.property)) {
        throw new ExpressionError(`access to '${node.property}' is not allowed`);
      }
      if (object === null || object === undefined) return null;
      if (typeof object !== 'object') {
        throw new ExpressionError(`cannot read property '${node.property}' of ${typeof object}`);
      }
      return (object as Record<string, unknown>)[node.property] ?? null;
    }
    case 'call': {
      if (node.callee.kind !== 'ident') {
        throw new ExpressionError('only built-in functions can be called');
      }
      const fn = FUNCTIONS[node.callee.name];
      if (!fn) throw new ExpressionError(`unknown function '${node.callee.name}'`);
      return fn(...node.args.map((arg) => evaluate(arg, scope)));
    }
    default:
      throw new ExpressionError('unsupported expression node');
  }
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== '';
}

function applyBinary(op: string, left: unknown, right: unknown): unknown {
  switch (op) {
    case '&&': return truthy(left) ? right : left;
    case '||': return truthy(left) ? left : right;
    case '??': return left ?? right;
    case '===': return left === right;
    case '!==': return left !== right;
    case '==': return looseEqual(left, right);
    case '!=': return !looseEqual(left, right);
    case '+':
      return typeof left === 'string' || typeof right === 'string'
        ? `${left ?? ''}${right ?? ''}`
        : Number(left) + Number(right);
    case '-': return Number(left) - Number(right);
    case '*': return Number(left) * Number(right);
    case '/': {
      const divisor = Number(right);
      if (divisor === 0) throw new ExpressionError('division by zero');
      return Number(left) / divisor;
    }
    case '%': return Number(left) % Number(right);
    case '<': return (left as never) < (right as never);
    case '>': return (left as never) > (right as never);
    case '<=': return (left as never) <= (right as never);
    case '>=': return (left as never) >= (right as never);
    default: throw new ExpressionError(`unsupported operator '${op}'`);
  }
}

function looseEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  // eslint-disable-next-line eqeqeq
  return left == right;
}

export function evaluateExpression(source: string, scope: Record<string, unknown>): JsonValue {
  const ast = new Parser(tokenize(source)).parse();
  const value = evaluate(ast, scope);
  if (value === undefined) return null;
  return value as JsonValue;
}
