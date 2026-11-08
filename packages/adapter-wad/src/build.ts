import { DIRECTORY_ENTRY_SIZE, HEADER_SIZE, type WadKind } from "./wad.ts";

export interface LumpInput {
  /** 最多 8 个字符；构造时以 NUL 填充。需要特殊名称字节时用 nameBytes。 */
  readonly name: string;
  readonly data: Uint8Array;
  /** 原始 8 字节名称，优先于 name。 */
  readonly nameBytes?: Uint8Array | undefined;
  /** 数据前插入的间隙字节。 */
  readonly gapBefore?: Uint8Array | undefined;
  /** 仅对大小为 0 的 Lump 有效：目录里写入的 filepos（真实 WAD 中标记的 filepos 常为任意值）。 */
  readonly markerFilepos?: number | undefined;
}

export interface BuildOptions {
  readonly kind: WadKind;
  readonly lumps: readonly LumpInput[];
  /** 最后一个 Lump 之后、目录之前的间隙字节。 */
  readonly gapBeforeDirectory?: Uint8Array | undefined;
  /** 目录之后的尾部字节。 */
  readonly trailing?: Uint8Array | undefined;
}

/** 构造一个 WAD 容器，用于测试和夹具。目录放在所有 Lump 数据之后。 */
export function buildWad(options: BuildOptions): Uint8Array {
  const parts: Uint8Array[] = [];
  const entries: { filepos: number; size: number; name: Uint8Array }[] = [];
  let at = HEADER_SIZE;
  for (const lump of options.lumps) {
    if (lump.gapBefore) {
      parts.push(lump.gapBefore);
      at += lump.gapBefore.length;
    }
    const name = new Uint8Array(8);
    if (lump.nameBytes) {
      if (lump.nameBytes.length !== 8) throw new RangeError("nameBytes must be 8 bytes");
      name.set(lump.nameBytes);
    } else {
      if (lump.name.length > 8) throw new RangeError(`lump name ${lump.name} is longer than 8`);
      for (let i = 0; i < lump.name.length; i++) name[i] = lump.name.charCodeAt(i);
    }
    const size = lump.data.length;
    entries.push({ filepos: size === 0 && lump.markerFilepos !== undefined ? lump.markerFilepos : at, size, name });
    parts.push(lump.data);
    at += size;
  }
  if (options.gapBeforeDirectory) {
    parts.push(options.gapBeforeDirectory);
    at += options.gapBeforeDirectory.length;
  }
  const dirOfs = at;
  const dir = new Uint8Array(entries.length * DIRECTORY_ENTRY_SIZE);
  const dv = new DataView(dir.buffer);
  entries.forEach((e, i) => {
    dv.setInt32(i * DIRECTORY_ENTRY_SIZE, e.filepos, true);
    dv.setInt32(i * DIRECTORY_ENTRY_SIZE + 4, e.size, true);
    dir.set(e.name, i * DIRECTORY_ENTRY_SIZE + 8);
  });
  parts.push(dir);
  if (options.trailing) parts.push(options.trailing);

  const total = parts.reduce((n, p) => n + p.length, HEADER_SIZE);
  const out = new Uint8Array(total);
  out.set([...options.kind].map((c) => c.charCodeAt(0)), 0);
  const hv = new DataView(out.buffer);
  hv.setInt32(4, entries.length, true);
  hv.setInt32(8, dirOfs, true);
  let p = HEADER_SIZE;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
