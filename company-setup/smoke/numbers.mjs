/**
 * 汇总数值数组中的有限数字项
 *
 * @param {unknown} values 输入数组
 * @returns {{ count: number, sum: number, ignored: number }} 统计结果
 * @throws {TypeError} 如果输入不是数组
 * @throws {RangeError} 如果累加过程中任何一步结果非有限（如溢出）
 */
export function summarizeNumbers(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('Expected an array');
  }

  let count = 0;
  let sum = 0;
  let ignored = 0;

  for (const item of values) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      const nextSum = sum + item;
      if (!Number.isFinite(nextSum)) {
        throw new RangeError('Sum calculation resulted in a non-finite number');
      }
      sum = nextSum === 0 ? 0 : nextSum;
      count += 1;
    } else {
      ignored += 1;
    }
  }

  return { count, sum, ignored };
}
