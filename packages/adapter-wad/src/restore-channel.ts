/**
 * WadFile 写回通道的唯一出口。WadFile 的静态初始化块把调用私有 #restoreField 的闭包交给 installRestore；
 * record-source.ts 经 restoreWadField 调用它。本模块不经任何入口导出。
 */
import type { Span } from "@necrohex/core";
import type { WadFile } from "./wad.ts";

export type RestoreFn = (wad: WadFile, lumpIndex: number, record: string, index: number, field: string, value: unknown) => Span;

let restore: RestoreFn | undefined;

/** 只接受一次。 */
export function installRestore(fn: RestoreFn): void {
  if (restore) throw new Error("the WadFile restore channel is already installed");
  restore = fn;
}

/** 写回旧值：只读、作用域和结构检查与 setField 相同，值只做类型域检查。失败时抛出与 setField 相同类别的错误。 */
export function restoreWadField(wad: WadFile, lumpIndex: number, record: string, index: number, field: string, value: unknown): Span {
  if (!restore) throw new Error("the WadFile restore channel is not installed");
  return restore(wad, lumpIndex, record, index, field, value);
}
