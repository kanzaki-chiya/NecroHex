/**
 * 写回通道的类型域检查。lookupRestorer 不经任何入口导出，这里按相对路径导入 core 的源码；
 * vitest 把工作区符号链接解析到真实路径，所以它与 record-source.ts 经 @necrohex/core/internal 用到的是同一个模块实例。
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { lookupRestorer } from "../../core/src/patch/restorable.ts";
import { buildWad, RECORD_LAYOUTS, wadAdapter, WadFile, WadRecordError, type FieldLayout } from "../src/index.ts";
import { restoreWadField } from "../src/restore-channel.ts";
import { mapWad, placedMapWad } from "./arbitraries.ts";
import { FIXTURE, RUNS } from "./patch-helpers.ts";

const opener = lookupRestorer(wadAdapter);

type Rec = "Sector" | "Thing";
const FIELDS = (["Sector", "Thing"] as const).flatMap((record) =>
  Object.entries(RECORD_LAYOUTS[record].fields as Record<string, FieldLayout>).map(([field, layout]) => ({ record: record as Rec, field, layout })),
);

/** 类型域内的值：整数全范围；名称长 0 到 8、码元 0x01–0xFF（含空串和非 ASCII）。 */
function inDomain(layout: FieldLayout): fc.Arbitrary<number | string> {
  if (layout.type === "int16") return fc.oneof(fc.integer({ min: -32768, max: 32767 }), fc.constantFrom(-32768, 32767, 0));
  if (layout.type === "uint16") return fc.oneof(fc.integer({ min: 0, max: 65535 }), fc.constantFrom(0, 65535));
  return fc.oneof(
    fc.array(fc.integer({ min: 1, max: 255 }), { maxLength: 8 }).map((cs) => String.fromCharCode(...cs)),
    fc.constantFrom("", "\u00ff\u00e9", "a b\u0001", "ABCDEFGH"),
  );
}

function outOfDomain(layout: FieldLayout): fc.Arbitrary<unknown> {
  if (layout.type === "int16") return fc.oneof(fc.constantFrom(-32769, 32768, 1.5, Number.NaN, "1"), fc.integer({ min: 32768, max: 1e6 }));
  if (layout.type === "uint16") return fc.oneof(fc.constantFrom(-1, 65536, 0.5, "1"), fc.integer({ min: 65536, max: 1e6 }));
  return fc.constantFrom("ABCDEFGHI", "AB\0C", "\u0100", "😀", 7);
}

describe("Feature: patch-engine, Property 15: 旧值写回只做类型域检查", () => {
  it("wadAdapter 已登记写回通道", () => {
    expect(opener).toBeDefined();
  });

  describe.each([
    ["生成样本", mapWad.map((m) => m.bytes)],
    ["Freedoom 夹具", fc.constant(FIXTURE)],
  ] as const)("%s", (_label, sample) => {
    it("类型域内的值写回成功，readField 返回该值", () => {
      fc.assert(
        fc.property(
          sample,
          fc.constantFrom(...FIELDS).chain((f) => inDomain(f.layout).map((v) => ({ ...f, v }))),
          fc.nat(),
          (bytes, { record, field, v }, pick) => {
            const src = opener!(bytes);
            const scope = src.scopes()[0]!;
            const loc = { scope: scope.id, record, index: pick % src.recordCount(scope.id, record) };
            const r = src.restoreField(loc, field, v);
            expect(r).toMatchObject({ ok: true });
            expect(src.readField(loc, field)).toBe(v);
          },
        ),
        { numRuns: RUNS },
      );
    });

    it("越界整数、长度 9、含 NUL 或码元大于 0xFF 的名称被拒绝，不留痕迹", () => {
      fc.assert(
        fc.property(
          sample,
          fc.constantFrom(...FIELDS).chain((f) => outOfDomain(f.layout).map((v) => ({ ...f, v }))),
          fc.nat(),
          (bytes, { record, field, v }, pick) => {
            const src = opener!(bytes);
            const scope = src.scopes()[0]!;
            const loc = { scope: scope.id, record, index: pick % src.recordCount(scope.id, record) };
            const r = src.restoreField(loc, field, v as never);
            expect(r).toMatchObject({ ok: false, reason: "ENCODE" });
            const out = src.serialize();
            expect(out.length).toBe(bytes.length);
            expect(out.every((b, i) => b === bytes[i])).toBe(true);
          },
        ),
        { numRuns: RUNS },
      );
    });
  });

  it("只读记录与 writeField 以相同 reason 被拒绝", () => {
    fc.assert(
      fc.property(mapWad, fc.constantFrom("Linedef", "Sidedef", "Vertex"), (m, record) => {
        const src = opener!(m.bytes);
        const field = Object.keys(RECORD_LAYOUTS[record as "Vertex"].fields)[0]!;
        const loc = { scope: src.scopes()[0]!.id, record, index: 0 };
        fc.pre(src.recordCount(loc.scope, record) > 0);
        const a = src.writeField(loc, field, 0);
        const b = src.restoreField(loc, field, 0);
        expect(a.ok).toBe(false);
        expect(b.ok).toBe(false);
        expect((b as { reason: string }).reason).toBe((a as { reason: string }).reason);
      }),
      { numRuns: RUNS },
    );
  });

  it("与结构重叠的字段与 writeField 以相同 reason 被拒绝", () => {
    fc.assert(
      fc.property(placedMapWad, fc.constantFrom(...FIELDS.filter((f) => f.record === "Sector" && f.layout.type !== "name8")), fc.nat(), (m, { field }, pick) => {
        const src = opener!(m.bytes);
        const loc = { scope: src.scopes()[0]!.id, record: "Sector", index: pick % m.sectorCount };
        const a = src.writeField(loc, field, 1);
        const b = src.restoreField(loc, field, 1);
        expect(b.ok).toBe(a.ok);
        if (!a.ok) expect((b as { reason: string }).reason).toBe(a.reason);
      }),
      { numRuns: RUNS },
    );
  });

  it("作用域外的 Lump：restoreWadField 与 setField 都抛 OUTSIDE_MAP_SCOPE", () => {
    const sectors = new Uint8Array(26);
    const wad = WadFile.parse(buildWad({ kind: "PWAD", lumps: [{ name: "SECTORS", data: sectors }] }));
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof WadRecordError ? e.code : String(e);
      }
      return "no error";
    };
    expect(code(() => wad.setField(0, "Sector", 0, "lightlevel", 1))).toBe("OUTSIDE_MAP_SCOPE");
    expect(code(() => restoreWadField(wad, 0, "Sector", 0, "lightlevel", 1))).toBe("OUTSIDE_MAP_SCOPE");
    expect(wad.dirtySpans()).toEqual([]);
  });
});
