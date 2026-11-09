/**
 * pin 的重定位分级（docs/design.md 第 7 节）。相似度由 adapter 的 RecordFingerprints 计算，这里只按阈值分级。
 *
 * 候选：相似度 >= low 的记录。高置信度候选：相似度 >= high 的记录。
 * - 恰好一个高置信度候选，并且第二名候选（如果有）比它至少低 margin：
 *   它就是 expectedIndex 时为 EXACT，否则为 RELOCATED。
 * - 有候选，但不满足上一条（没有高置信度候选、高置信度候选不止一个，或第二名离第一名太近）：CONFLICT_AMBIGUOUS。
 * - 没有候选：CONFLICT_MISSING。
 * 冲突时不选任何记录，绝不在相近的候选之间猜测。
 */
import type { RelocationCandidate } from "./source.ts";

export interface RelocationThresholds {
  /** 高置信度下限。 */
  readonly high: number;
  /** 候选下限。 */
  readonly low: number;
  /** 唯一的高置信度候选与第二名候选之间至少要差这么多。 */
  readonly margin: number;
}

/** 初始阈值见设计文档；校准结果见 docs/decisions.md。 */
export const RELOCATION_THRESHOLDS: RelocationThresholds = Object.freeze({ high: 0.85, low: 0.5, margin: 0.1 });

/** 报告和问题里最多列出的候选数。 */
export const MAX_LISTED_CANDIDATES = 10;

export type PinClassification =
  | { readonly result: "EXACT"; readonly index: number; readonly score: number; readonly candidates: RelocationCandidate[]; readonly candidateCount: number }
  | { readonly result: "RELOCATED"; readonly index: number; readonly score: number; readonly candidates: RelocationCandidate[]; readonly candidateCount: number }
  | { readonly result: "CONFLICT_AMBIGUOUS"; readonly candidates: RelocationCandidate[]; readonly candidateCount: number }
  | { readonly result: "CONFLICT_MISSING"; readonly candidates: RelocationCandidate[]; readonly candidateCount: number };

/** 相似度保留 4 位小数，先取整再比较，报告里的数和判断用的数一致。 */
export function roundScore(s: number): number {
  return Math.round(s * 10000) / 10000;
}

export function classifyPin(scores: readonly number[], expectedIndex: number, t: RelocationThresholds = RELOCATION_THRESHOLDS): PinClassification {
  const all: RelocationCandidate[] = [];
  scores.forEach((raw, index) => {
    if (!Number.isFinite(raw)) throw new RangeError(`fingerprint score for #${index} is not a finite number`);
    const score = roundScore(Math.min(1, Math.max(0, raw)));
    if (score >= t.low) all.push({ index, score });
  });
  all.sort((a, b) => b.score - a.score || a.index - b.index);
  const candidates = all.slice(0, MAX_LISTED_CANDIDATES);
  const candidateCount = all.length;
  if (all.length === 0) return { result: "CONFLICT_MISSING", candidates, candidateCount };
  const top = all[0]!;
  const second = all[1];
  // 并列第一一定是歧义，即使 margin 为 0
  const unique = top.score >= t.high && (second === undefined || (second.score < t.high && second.score < top.score && roundScore(top.score - second.score) >= t.margin));
  if (!unique) return { result: "CONFLICT_AMBIGUOUS", candidates, candidateCount };
  const found = { index: top.index, score: top.score, candidates, candidateCount };
  return top.index === expectedIndex ? { result: "EXACT", ...found } : { result: "RELOCATED", ...found };
}
