import { mergeSpans, type Span } from "./span.ts";

/**
 * 基础缓冲上的写入覆盖层。
 * 基础缓冲永远不被修改；materialize 克隆它并只覆写脏区间。
 * 构造函数持有传入的引用，不复制：调用方（WadFile.parse）负责传入自己独占的副本。
 * 基础缓冲不对外暴露引用，只能通过 baseCopy() 取得副本。
 */
export class ByteOverlay {
  readonly #base: Uint8Array;
  readonly #edits: { offset: number; bytes: Uint8Array }[] = [];

  constructor(base: Uint8Array) {
    this.#base = base;
  }

  /** 基础缓冲的长度。 */
  get length(): number {
    return this.#base.length;
  }

  /** 基础缓冲的副本，不含任何写入。每次调用返回新数组。 */
  baseCopy(): Uint8Array {
    return this.#base.slice();
  }

  write(offset: number, bytes: Uint8Array): Span {
    if (!Number.isInteger(offset) || offset < 0 || offset + bytes.length > this.#base.length) {
      throw new RangeError(`write [${offset}, ${offset + bytes.length}) is outside the buffer`);
    }
    this.#edits.push({ offset, bytes: bytes.slice() });
    return { start: offset, end: offset + bytes.length };
  }

  /** 读取当前视图（含未提交的覆盖）。 */
  read(offset: number, length: number): Uint8Array {
    if (offset < 0 || length < 0 || offset + length > this.#base.length) {
      throw new RangeError(`read [${offset}, ${offset + length}) is outside the buffer`);
    }
    const out = this.#base.slice(offset, offset + length);
    for (const e of this.#edits) {
      const s = Math.max(offset, e.offset);
      const t = Math.min(offset + length, e.offset + e.bytes.length);
      for (let i = s; i < t; i++) out[i - offset] = e.bytes[i - e.offset]!;
    }
    return out;
  }

  get dirty(): boolean {
    return this.#edits.length > 0;
  }

  /** 已写入的区间（合并后）。 */
  dirtySpans(): Span[] {
    return mergeSpans(this.#edits.map((e) => ({ start: e.offset, end: e.offset + e.bytes.length })));
  }

  /** 克隆基础缓冲并应用全部写入。 */
  materialize(): Uint8Array {
    const out = this.#base.slice();
    for (const e of this.#edits) out.set(e.bytes, e.offset);
    return out;
  }
}
