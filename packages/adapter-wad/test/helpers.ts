import type { Span } from "@necrohex/core";
import { fieldByteLength, MAP_DATA_LUMPS, RECORD_LAYOUTS, WadFile, type FieldLayout } from "../src/index.ts";
import type { FieldWrite } from "./arbitraries.ts";

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

/**
 * 地图格式识别之前的作用域规则（只认 10 个标准数据 Lump），内联保存作为参照：
 * 对不含 BEHAVIOR、SCRIPTS、TEXTMAP 的输入，当前实现的 maps 必须与它逐项相同（format 之外）。
 */
export function legacyMaps(wad: WadFile): Array<{ name: string; markerIndex: number; dataIndices: number[]; lumps: Record<string, number> }> {
  const data = new Set(MAP_DATA_LUMPS);
  const out = [];
  for (let i = 0; i < wad.lumps.length; i++) {
    const name = wad.lumps[i]!.name.toUpperCase();
    if (!/^(E[1-9]M[1-9]|MAP\d\d)$/.test(name)) continue;
    const dataIndices: number[] = [];
    const lumps: Record<string, number> = {};
    for (let j = i + 1; j < wad.lumps.length; j++) {
      const n = wad.lumps[j]!.name.toUpperCase();
      if (!data.has(n) || n in lumps) break;
      lumps[n] = j;
      dataIndices.push(j);
    }
    if (dataIndices.length > 0) out.push({ name: wad.lumps[i]!.name, markerIndex: i, dataIndices, lumps });
  }
  return out;
}

/** 当前 maps 去掉 format 之后的形状，用来和 legacyMaps 比较。 */
export function mapsWithoutFormat(wad: WadFile): ReturnType<typeof legacyMaps> {
  return wad.maps.map((m) => ({ name: m.name, markerIndex: m.markerIndex, dataIndices: [...m.dataIndices], lumps: { ...m.lumps } }));
}

/** 动态字段写入：记录、字段名和值在运行时才确定，类型上用断言绕过 setField 的泛型约束。 */
export function applyWrite(wad: WadFile, lumpIndex: number, index: number, w: FieldWrite): Span {
  return wad.setField(lumpIndex, w.record as "Sector", index, w.field as "tag", w.value as number);
}

/** 动态字段读取，与 applyWrite 配对。 */
export function readField(wad: WadFile, lumpIndex: number, index: number, w: FieldWrite): unknown {
  return (wad.readRecord(lumpIndex, w.record, index) as unknown as Record<string, unknown>)[w.field];
}

/** 字段在文件中的物理区间，由布局偏移和 Lump 的 filepos 计算，不经过 fieldSpan。 */
export function fieldRange(wad: WadFile, lumpIndex: number, index: number, w: FieldWrite): Span {
  const layout = (RECORD_LAYOUTS[w.record].fields as Record<string, FieldLayout>)[w.field]!;
  const start = wad.lumps[lumpIndex]!.filepos + index * RECORD_LAYOUTS[w.record].size + layout.offset;
  return { start, end: start + fieldByteLength(layout) };
}

/** 返回副本：把某个 Lump 的目录项 filepos 改写为给定值，名称、大小和 Lump 顺序不变。 */
export function withFilepos(bytes: Uint8Array, lumpIndex: number, filepos: number): Uint8Array {
  const wad = WadFile.parse(bytes);
  const entry = wad.lumps[lumpIndex]!.entrySpan;
  const out = bytes.slice();
  new DataView(out.buffer).setInt32(entry.start, filepos, true);
  return out;
}

/**
 * 独立于 WadFile 内部实现的参考判定：[start, end) 是否与文件头、目录或 lumpIndex 以外的 Lump 数据区间相交。
 * 只用头部原始数值和目录项的 filepos/size 计算，不使用 regions、dataSpan 或 core 的 spansOverlap。
 */
export function touchesStructure(wad: WadFile, totalLength: number, lumpIndex: number, start: number, end: number): boolean {
  const cross = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
  if (cross(start, end, 0, 12)) return true;
  if (wad.numLumps > 0 && cross(start, end, wad.directoryOffset, wad.directoryOffset + 16 * wad.numLumps)) return true;
  for (const l of wad.lumps) {
    if (l.index === lumpIndex) continue;
    if (l.size > 0 && l.filepos >= 0 && l.filepos + l.size <= totalLength && cross(start, end, l.filepos, l.filepos + l.size)) return true;
  }
  return false;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
