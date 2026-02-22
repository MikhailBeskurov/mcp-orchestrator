import { describe, it, expect } from 'vitest';
import { parseJsonField } from '../utils.js';

describe('parseJsonField', () => {
  it('null → null', () => {
    expect(parseJsonField(null)).toBe(null);
  });

  it('undefined → null', () => {
    expect(parseJsonField(undefined)).toBe(null);
  });

  it('пустая строка → null', () => {
    expect(parseJsonField('')).toBe(null);
  });

  it('валидный JSON-массив строкой → распарсенный массив', () => {
    expect(parseJsonField('["a","b"]')).toEqual(['a', 'b']);
  });

  it('валидный JSON-объект строкой → распарсенный объект', () => {
    expect(parseJsonField('{"x":1}')).toEqual({ x: 1 });
  });

  it('невалидный JSON → null', () => {
    expect(parseJsonField('{invalid}')).toBe(null);
  });

  it('массив → тот же массив', () => {
    const arr = [1, 2, 3];
    expect(parseJsonField(arr)).toBe(arr);
  });

  it('объект → тот же объект', () => {
    const obj = { a: 1 };
    expect(parseJsonField(obj)).toBe(obj);
  });

  it('число → null', () => {
    expect(parseJsonField(42)).toBe(null);
  });

  it('boolean → null', () => {
    expect(parseJsonField(true)).toBe(null);
    expect(parseJsonField(false)).toBe(null);
  });

  it("пустой массив '[]' → []", () => {
    expect(parseJsonField('[]')).toEqual([]);
  });

  it("пустой объект '{}' → {}", () => {
    expect(parseJsonField('{}')).toEqual({});
  });
});
