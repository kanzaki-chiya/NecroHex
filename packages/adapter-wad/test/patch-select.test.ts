import { planPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RECORD_LAYOUTS, wadAdapter, WadFile, type FieldLayout } from "../src/index.ts";
import { asciiLower, profile } from "./arbitraries.ts";
import { BLOCK_HOOKS, RUNS, SAMPLES } from "./patch-helpers.ts";

type Rec = "Sector" | "Thing";
type Cond = Record<string, number | string | Array<number | string>>;

/** 参考实现：只转换 ASCII a–z 的大写比较，独立于 core 的 select.ts。 */
function upper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

function refMatch(value: number | string, cond: Cond): boolean {
  const n = (v: number | string) => (typeof v === "string" ? upper(v) : v);
  const x = n(value);
  for (const [op, v] of Object.entries(cond)) {
    if (op === "in") {
      if (!(v as Array<number | string>).some((y) => n(y) === x)) return false;
      continue;
    }
    const y = n(v as number | string);
    const ok =
      op === "eq" ? x === y : op === "ne" ? x !== y : op === "lt" ? x < y : op === "lte" ? x <= y : op === "gt" ? x > y : x >= y;
    if (!ok) return false;
  }
  return true;
}

/** 参考匹配集合：对 readRecords 逐条求值，键为 "<map>#<index>"。 */
function reference(bytes: Uint8Array, record: Rec, maps: "*" | string[], where: Record<string, Cond> | null): string[] {
  const wad = WadFile.parse(bytes);
  const out: string[] = [];
  for (const m of wad.maps) {
    if (m.format !== "doom") continue;
    if (maps !== "*" && !maps.some((n) => upper(n) === upper(m.name))) continue;
    const lump = wad.mapLump(m, RECORD_LAYOUTS[record].lump);
    if (!lump) continue;
    wad.readRecords(lump.index, record).forEach((r, i) => {
      const row = r as unknown as Record<string, number | string>;
      if (!where || Object.entries(where).every(([f, c]) => refMatch(row[f]!, c))) out.push(`${m.name}#${i}`);
    });
  }
  return out;
}

const INT_FIELDS = (record: Rec) =>
  Object.entries(RECORD_LAYOUTS[record].fields as Record<string, FieldLayout>).filter(([, l]) => l.count === 1 && l.type !== "name8").map(([f]) => f);
const NAME_FIELDS = Object.entries(RECORD_LAYOUTS.Sector.fields as Record<string, FieldLayout>).filter(([, l]) => l.type === "name8").map(([f]) => f);

/**
 * 用来"标记"匹配结果的写入：整数字段 set 0，不受 canRestore 影响。
 * Sector 用 lightlevel，不涉及 ceilingheight >= floorheight；Thing 的写入可能落在受保护的类型上，plan 放行全部拦截钩子。
 */
const MARK: Record<Rec, string> = { Sector: "lightlevel", Thing: "x" };

function input(bytes: Uint8Array) {
  const p = profile(bytes);
  const values = (record: Rec, field: string) => p.mapNames.flatMap((m) => p.records[m.toUpperCase()]![record].map((r) => r[field]!));
  const record = fc.constantFrom<Rec>("Sector", "Thing");
  const maps = fc.oneof(fc.constant<"*" | string[]>("*"), fc.subarray(p.mapNames, { minLength: 1 }));
  const intCond = (record: Rec, field: string) => {
    const vs = values(record, field) as number[];
    const v = vs.length ? fc.oneof(fc.constantFrom(...vs), fc.integer({ min: -300, max: 300 })) : fc.integer({ min: -300, max: 300 });
    return fc.oneof(
      ...(["eq", "ne", "lt", "lte", "gt", "gte"] as const).map((op) => v.map((x): Cond => ({ [op]: x }))),
      fc.array(v, { minLength: 1, maxLength: 3 }).map((xs): Cond => ({ in: xs })),
    );
  };
  const nameCond = (field: string) => {
    const vs = values("Sector", field) as string[];
    const v = vs.length ? fc.constantFrom(...vs) : fc.constant("FLAT1");
    return fc.oneof(v.map((x): Cond => ({ eq: x })), v.map((x): Cond => ({ ne: x })), fc.array(v, { minLength: 1, maxLength: 2 }).map((xs): Cond => ({ in: xs })));
  };
  const where = (record: Rec) => {
    const fields = record === "Sector" ? [...INT_FIELDS(record), ...NAME_FIELDS] : INT_FIELDS(record);
    return fc
      .subarray(fields.filter((f) => f !== MARK[record]), { minLength: 1, maxLength: 2 })
      .chain((fs) => fc.tuple(...fs.map((f) => (NAME_FIELDS.includes(f) ? nameCond(f) : intCond(record, f)))).map((cs) => Object.fromEntries(fs.map((f, i) => [f, cs[i]!]))));
  };
  return fc.record({ record, maps }).chain(({ record, maps }) =>
    fc.record({ where: fc.option(where(record), { nil: null, freq: 4 }) }).map(({ where }) => ({ bytes, record, maps, where })),
  );
}

function plan(bytes: Uint8Array, record: Rec, maps: "*" | string[], where: Record<string, Cond> | null, extraOps: unknown[] = []) {
  const select = where ? { record, where } : { record, all: true };
  const ops = [...extraOps, { id: "sel", select, change: { [MARK[record]]: { set: 0 } } }];
  return planPatch(bytes, { schemaVersion: 1, name: "s", target: { format: "wad", maps }, allowProtected: BLOCK_HOOKS, operations: ops }, wadAdapter);
}

const keys = (r: ReturnType<typeof plan>, id = "sel") => r.changes.filter((c) => c.operationId === id).map((c) => `${c.scope}#${c.index}`);

/** 名称条件里的字符串把 ASCII A–Z 改成小写（latin1 的非 ASCII 字母不在大小写规则内，保持不变）。 */
function lowerNames(where: Record<string, Cond>): Record<string, Cond> {
  const low = (x: number | string) => (typeof x === "string" ? asciiLower(x) : x);
  return Object.fromEntries(
    Object.entries(where).map(([f, c]) => [f, Object.fromEntries(Object.entries(c).map(([op, v]) => [op, Array.isArray(v) ? v.map(low) : low(v)]))]),
  );
}

describe.each(SAMPLES)("Feature: patch-engine, Property 4: 选择器与参考模型一致（%s）", (_label, sample) => {
  it("匹配集合等于参考实现；all 的匹配数为各作用域 recordCount 之和；0 匹配不是问题", () => {
    fc.assert(
      fc.property(sample.chain(input), ({ bytes, record, maps, where }) => {
        const r = plan(bytes, record, maps, where);
        expect(r.issues).toEqual([]);
        const want = reference(bytes, record, maps, where);
        expect(keys(r)).toEqual(want);
        expect(r.matches).toEqual([{ operationId: "sel", count: want.length }]);
        if (!where) {
          const src = wadAdapter.open(bytes);
          const scopes = src.scopes().filter((s) => maps === "*" || maps.some((n) => upper(n) === upper(s.name)));
          expect(want.length).toBe(scopes.reduce((n, s) => n + src.recordCount(s.id, record), 0));
          expect(r.changes.every((c) => c.selection.kind === "ALL")).toBe(true);
        } else {
          expect(r.changes.every((c) => c.selection.kind === "WHERE")).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("名称条件改大小写不改变结果", () => {
    fc.assert(
      fc.property(sample.chain(input), ({ bytes, record, maps, where }) => {
        fc.pre(where !== null);
        expect(keys(plan(bytes, record, maps, lowerNames(where!)))).toEqual(keys(plan(bytes, record, maps, where)));
      }),
      { numRuns: RUNS },
    );
  });

  it("前一操作的写入不影响后一操作的匹配", () => {
    fc.assert(
      fc.property(sample.chain(input), fc.integer({ min: -32768, max: 32767 }), ({ bytes, record, maps, where }, v) => {
        fc.pre(where !== null);
        // 前一操作把后一操作 where 里的每个字段都改掉（只改整数字段；名称字段改成固定名）
        const change = Object.fromEntries(Object.keys(where!).map((f) => [f, { set: NAME_FIELDS.includes(f) ? "ZZZZ" : v }]));
        const first = { id: "first", select: { record, all: true }, change };
        const r = plan(bytes, record, maps, where, [first]);
        expect(r.matches.find((m) => m.operationId === "sel")!.count).toBe(reference(bytes, record, maps, where).length);
      }),
      { numRuns: RUNS },
    );
  });
});
