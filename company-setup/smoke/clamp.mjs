/**
 * 将数值限制在闭区间 [min, max] 内
 *
 * @param {unknown} value 待限制的数值
 * @param {unknown} min 区间下界
 * @param {unknown} max 区间上界
 * @returns {number} 限制后的值；value 已在区间内时原样返回
 * @throws {TypeError} 如果任一参数不是有限数字
 * @throws {RangeError} 如果 min > max
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new TypeError('clamp arguments must be finite numbers');
  }

  if (min > max) {
    throw new RangeError('min must not be greater than max');
  }

  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}
