import type { Span } from "@necrohex/core";
import { WadFile } from "../src/index.ts";

/** 解析结果的结构摘要，用于比较 parse(serialize(A)) 与 A。 */
export function summarize(wad: WadFile): unknown {
  return {
    kind: wad.kind,
    numLumps: wad.numLumps,
    directoryOffset: wad.directoryOffset,
    lumps: wad.lumps,
    maps: wad.maps,
    regions: wad.regions,
  };
}

/** 两个等长缓冲中所有不相同的字节下标。 */
export function changedIndices(a: Uint8Array, b: Uint8Array): number[] {
  if (a.length !== b.length) throw new Error("length mismatch");
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

export function insideAny(index: number, spans: readonly Span[]): boolean {
  return spans.some((s) => index >= s.start && index < s.end);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
