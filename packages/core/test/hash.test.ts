import { describe, expect, it } from "vitest";
import { bytesHash, canonicalJson, sha256, toHex, utf8Encode } from "../src/hash.ts";
import vectors from "./vectors/sha256-nist.json";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("SHA-256：FIPS 180-4 示例", () => {
  it.each(vectors.fips)("$source", ({ msgHex, md }) => {
    expect(toHex(sha256(fromHex(msgHex)))).toBe(md);
  });

  it("1,000,000 个 'a'", () => {
    const m = vectors.million;
    const data = new Uint8Array(m.count).fill(parseInt(m.byteHex, 16));
    expect(toHex(sha256(data))).toBe(m.md);
  });
});

describe("SHA-256：CAVP 字节向量", () => {
  it("选取了要求的条目", () => {
    expect(vectors.cavp.map((v) => v.len)).toEqual([0, 8, 440, 448, 504, 512, 1304, 2096, 51200]);
  });

  it.each(vectors.cavp)("$source", ({ len, msgHex, md }) => {
    // Len 以位计；Len = 0 的条目在 .rsp 中写作 Msg = 00，消息只取前 len / 8 字节
    const msg = fromHex(msgHex).subarray(0, len / 8);
    expect(msg.length).toBe(len / 8);
    expect(toHex(sha256(msg))).toBe(md);
  });
});

describe("bytesHash", () => {
  it("格式为 sha256: 加 64 位小写十六进制", () => {
    expect(bytesHash(new Uint8Array(0))).toBe("sha256:" + vectors.fips[0]!.md);
    expect(bytesHash(Uint8Array.of(1, 2, 3))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("不修改输入", () => {
    const data = Uint8Array.of(9, 8, 7);
    sha256(data);
    expect([...data]).toEqual([9, 8, 7]);
  });
});

describe("utf8Encode", () => {
  it("ASCII、两字节、三字节", () => {
    expect([...utf8Encode("A")]).toEqual([0x41]);
    expect([...utf8Encode("é")]).toEqual([0xc3, 0xa9]);
    expect([...utf8Encode("中")]).toEqual([0xe4, 0xb8, 0xad]);
  });

  it("代理对编码为一个 4 字节码点", () => {
    expect([...utf8Encode("😀")]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect([...utf8Encode("\u{10ffff}")]).toEqual([0xf4, 0x8f, 0xbf, 0xbf]);
  });

  it("孤立代理项编码为 U+FFFD", () => {
    expect([...utf8Encode("\ud800")]).toEqual([0xef, 0xbf, 0xbd]);
    expect([...utf8Encode("\udc00x")]).toEqual([0xef, 0xbf, 0xbd, 0x78]);
    expect([...utf8Encode("\ud800\ud800")]).toEqual([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd]);
  });
});

describe("canonicalJson", () => {
  it("键按 UTF-16 码元排序、无空白", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], B: { d: 2, c: 1 } })).toBe('{"B":{"c":1,"d":2},"a":[true,null,"x"],"b":1}');
    // 按码点 U+1F600 排在 U+E000 之后；按码元 0xD83D 小于 0xE000，所以排在前面
    expect(canonicalJson({ "\ue000": 1, "😀": 2 })).toBe('{"😀":2,"\ue000":1}');
  });

  it("键顺序和空白不影响结果", () => {
    const a = JSON.parse('{ "x": 1, "y": { "q": [1, 2], "p": "s" } }');
    const b = JSON.parse('{"y":{"p":"s","q":[1,2]},"x":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("拒绝非 JSON 值", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Infinity)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
  });
});
