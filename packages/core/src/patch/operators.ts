/**
 * 算子：由旧值计算新值。只做算术，范围检查交给 Record_Source 的 writeField。
 */
import type { FieldValue } from "./source.ts";
import type { Change } from "./validate.ts";

export function clampValue(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * set：给定值。scale：Math.floor(old * k)，有 clamp 再限制。只有 clamp：min(max(old, lo), hi)。
 * scale 和 clamp 只用于整数字段（由校验保证），对非数字旧值抛 TypeError。
 */
export function computeNewValue(change: Change, oldValue: FieldValue): FieldValue {
  if ("set" in change) return change.set;
  if (typeof oldValue !== "number") throw new TypeError("scale and clamp need a numeric old value");
  if ("scale" in change) {
    const scaled = Math.floor(oldValue * change.scale);
    return change.clamp ? clampValue(scaled, change.clamp[0], change.clamp[1]) : scaled;
  }
  return clampValue(oldValue, change.clamp[0], change.clamp[1]);
}
