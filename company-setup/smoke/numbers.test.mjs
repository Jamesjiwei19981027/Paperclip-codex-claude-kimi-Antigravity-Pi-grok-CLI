import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeNumbers } from './numbers.mjs';

test('空数组返回全零', () => {
  const result = summarizeNumbers([]);
  assert.deepStrictEqual(result, { count: 0, sum: 0, ignored: 0 });
});

test('普通正数求和', () => {
  const result = summarizeNumbers([1, 2, 3.5]);
  assert.deepStrictEqual(result, { count: 3, sum: 6.5, ignored: 0 });
});

test('负数求和', () => {
  const result = summarizeNumbers([-1, -2.5, -7]);
  assert.deepStrictEqual(result, { count: 3, sum: -10.5, ignored: 0 });
});

test('零的汇总', () => {
  const result = summarizeNumbers([0, -0]);
  assert.deepStrictEqual(result, { count: 2, sum: 0, ignored: 0 });
});

test('NaN、Infinity 和 -Infinity 计入 ignored', () => {
  const onlySpecial = summarizeNumbers([NaN, Infinity, -Infinity]);
  assert.deepStrictEqual(onlySpecial, { count: 0, sum: 0, ignored: 3 });

  const mixed = summarizeNumbers([10, NaN, 20, Infinity, -Infinity]);
  assert.deepStrictEqual(mixed, { count: 2, sum: 30, ignored: 3 });
});

test('字符串/null/对象混入，计入 ignored 且不把字符串转数字', () => {
  const result = summarizeNumbers(['123', null, undefined, { a: 1 }, [2], true, false, 5]);
  assert.deepStrictEqual(result, { count: 1, sum: 5, ignored: 7 });
});

test('非数组参数抛出 TypeError', () => {
  assert.throws(() => summarizeNumbers(null), {
    name: 'TypeError',
  });
  assert.throws(() => summarizeNumbers(undefined), {
    name: 'TypeError',
  });
  assert.throws(() => summarizeNumbers('123'), {
    name: 'TypeError',
  });
  assert.throws(() => summarizeNumbers(123), {
    name: 'TypeError',
  });
  assert.throws(() => summarizeNumbers({ length: 0 }), {
    name: 'TypeError',
  });
});

test('累加结果溢出非有限时抛出 RangeError', () => {
  assert.throws(() => summarizeNumbers([Number.MAX_VALUE, Number.MAX_VALUE]), {
    name: 'RangeError',
  });
  assert.throws(() => summarizeNumbers([-Number.MAX_VALUE, -Number.MAX_VALUE]), {
    name: 'RangeError',
  });
});
