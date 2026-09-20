import {describe, expect, it} from 'vitest';
import {evaluateExpression, ExpressionError} from '../src/shared/expr';

describe('expression evaluator', () => {
  it('evaluates arithmetic, comparisons, ternaries and builtins', () => {
    expect(evaluateExpression('a + b', {a: 2, b: 3})).toBe(5);
    expect(evaluateExpression('a > 1 ? "big" : "small"', {a: 2})).toBe('big');
    expect(evaluateExpression('upper(trim(name))', {name: '  ada '})).toBe('ADA');
    expect(evaluateExpression('coalesce(v, fallback)', {v: null, fallback: 'x'})).toBe('x');
    expect(evaluateExpression('"a" + "b"', {})).toBe('ab');
  });

  it('distinguishes missing identifiers from null values', () => {
    // Null is a real value.
    expect(evaluateExpression('v === null', {v: null})).toBe(true);
    expect(evaluateExpression('v ?? "default"', {v: null})).toBe('default');
    // Unknown identifiers are an error, not silently null.
    expect(() => evaluateExpression('unknownField + 1', {})).toThrow(ExpressionError);
  });

  it('propagates runtime errors such as division by zero', () => {
    expect(() => evaluateExpression('a / b', {a: 1, b: 0})).toThrow(/division by zero/);
  });

  it('blocks prototype access and non-whitelisted calls', () => {
    expect(() => evaluateExpression('x.constructor', {x: {}})).toThrow(/not allowed/);
    expect(() => evaluateExpression('evil()', {})).toThrow(/unknown function/);
  });
});
