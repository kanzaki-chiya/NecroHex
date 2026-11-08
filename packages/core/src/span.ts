/** 半开字节区间 [start, end)。 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export function span(start: number, length: number): Span {
  return { start, end: start + length };
}

export function spanLength(s: Span): number {
  return s.end - s.start;
}

export function spansOverlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 合并重叠或相邻的区间，返回按起点排序的新数组。空区间被丢弃。 */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      if (s.end > last.end) out[out.length - 1] = { start: last.start, end: s.end };
    } else {
      out.push({ start: s.start, end: s.end });
    }
  }
  return out;
}

/** 返回 [0, total) 中没有被 covered 覆盖的区间。 */
export function complementSpans(total: number, covered: readonly Span[]): Span[] {
  const out: Span[] = [];
  let cursor = 0;
  for (const s of mergeSpans(covered)) {
    const start = Math.max(0, Math.min(s.start, total));
    const end = Math.max(0, Math.min(s.end, total));
    if (start > cursor) out.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < total) out.push({ start: cursor, end: total });
  return out;
}

export function spanWithin(inner: Span, outer: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}
