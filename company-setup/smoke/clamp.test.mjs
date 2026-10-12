import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.mjs';

test('值位于区间内', () => {
  assert.strictEqual(clamp(5, 0, 10), 5);
  assert.strictEqual(clamp(-3, -10, 0), -3);
  assert.strictEqual(clamp(2.5, 1.0, 5.0), 2.5);
  assert.strictEqual(clamp(0, -1, 1), 0);
});

test('值低于下限', () => {
  assert.strictEqual(clamp(-5, 0, 10), 0);
  assert.strictEqual(clamp(-15, -10, -1), -10);
  assert.strictEqual(clamp(-0.5, 0, 1), 0);
});

test('值高于上限', () => {
  assert.strictEqual(clamp(15, 0, 10), 10);
  assert.strictEqual(clamp(5, -10, 0), 0);
  assert.strictEqual(clamp(1.5, 0, 1), 1);
});

test('值等于 min 边界', () => {
  assert.strictEqual(clamp(0, 0, 10), 0);
  assert.strictEqual(clamp(-5, -5, 5), -5);
  assert.strictEqual(clamp(10, 10, 20), 10);
});

test('值等于 max 边界', () => {
  assert.strictEqual(clamp(10, 0, 10), 10);
  assert.strictEqual(clamp(5, -5, 5), 5);
  assert.strictEqual(clamp(-1, -10, -1), -1);
});

test('区间退化为单点（min 等于 max）', () => {
  assert.strictEqual(clamp(5, 5, 5), 5);
  assert.strictEqual(clamp(2, 5, 5), 5);
  assert.strictEqual(clamp(8, 5, 5), 5);
});

test('非数字输入、NaN、Infinity（应抛 TypeError）', () => {
  // 非数字类型
  assert.throws(() => clamp(null, 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, null, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, 0, null), { name: 'TypeError' });
  assert.throws(() => clamp(undefined, 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, undefined, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, 0, undefined), { name: 'TypeError' });
  assert.throws(() => clamp('5', 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, '0', 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, 0, '10'), { name: 'TypeError' });
  assert.throws(() => clamp({}, 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp([], 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp(true, 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp(Symbol(), 0, 10), { name: 'TypeError' });

  // NaN
  assert.throws(() => clamp(NaN, 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, NaN, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, 0, NaN), { name: 'TypeError' });

  // Infinity 与 -Infinity
  assert.throws(() => clamp(Infinity, 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp(-Infinity, 0, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, -Infinity, 10), { name: 'TypeError' });
  assert.throws(() => clamp(5, 0, Infinity), { name: 'TypeError' });
});

test('min > max（应抛 RangeError）', () => {
  assert.throws(() => clamp(5, 10, 0), { name: 'RangeError' });
  assert.throws(() => clamp(0, 1, -1), { name: 'RangeError' });
  assert.throws(() => clamp(15, 10, 5), { name: 'RangeError' });
  assert.throws(() => clamp(-5, 5, -5), { name: 'RangeError' });
});
