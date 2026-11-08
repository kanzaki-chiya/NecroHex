export type FieldType = "int16" | "uint16" | "name8";

export interface FieldLayout {
  readonly offset: number;
  readonly type: FieldType;
  readonly count: number;
}

export interface RecordLayout {
  readonly name: string;
  readonly lump: string;
  readonly size: number;
  readonly fields: Readonly<Record<string, FieldLayout>>;
}

export const FIELD_TYPE_SIZE: Readonly<Record<FieldType, number>> = { int16: 2, uint16: 2, name8: 8 };

/** 字段占用的总字节数。 */
export function fieldByteLength(f: FieldLayout): number {
  return FIELD_TYPE_SIZE[f.type] * f.count;
}

/**
 * 读取 8 字节名称：到第一个 NUL 为止，按 latin1 解码。
 * 只用于展示和比较；原始 8 字节始终保留在基础缓冲里。
 */
export function decodeName8(view: DataView, offset: number): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** 编码新的名称值：1 到 8 个可打印 ASCII 字符，NUL 填充。 */
export function encodeName8(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string") throw new TypeError(`${label}: expected a string`);
  if (value.length < 1 || value.length > 8) throw new RangeError(`${label}: name must be 1 to 8 characters`);
  const out = new Uint8Array(8);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) throw new RangeError(`${label}: name contains a non-printable or non-ASCII character`);
    out[i] = c;
  }
  return out;
}

function encodeInt(type: "int16" | "uint16", value: unknown, label: string): Uint8Array {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`${label}: expected an integer`);
  const [min, max] = type === "int16" ? [-32768, 32767] : [0, 65535];
  if (value < min || value > max) throw new RangeError(`${label}: ${value} is outside ${type} range ${min}..${max}`);
  const out = new Uint8Array(2);
  const view = new DataView(out.buffer);
  if (type === "int16") view.setInt16(0, value, true);
  else view.setUint16(0, value, true);
  return out;
}

/** 校验并编码一个字段的新值。只在写入新值时调用，读取从不校验。 */
export function encodeField(layout: FieldLayout, label: string, value: unknown): Uint8Array {
  const items: unknown[] = layout.count > 1 ? (Array.isArray(value) ? value : []) : [value];
  if (items.length !== layout.count) throw new TypeError(`${label}: expected ${layout.count} values`);
  const parts = items.map((v, i) => {
    const l = layout.count > 1 ? `${label}[${i}]` : label;
    return layout.type === "name8" ? encodeName8(v, l) : encodeInt(layout.type, v, l);
  });
  const out = new Uint8Array(fieldByteLength(layout));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
