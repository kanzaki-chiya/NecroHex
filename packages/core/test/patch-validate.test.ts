import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyPatch, planPatch } from "../src/index.ts";
import { encodeModel, makeFake, sampleModel } from "./fake-source.ts";

type Json = Record<string, unknown>;

const condition = fc.oneof(
  fc.record({ lightlevel: fc.record({ gte: fc.integer({ min: 0, max: 255 }) }) }),
  fc.record({ floorpic: fc.record({ eq: fc.constantFrom("FLAT1", "nukage1") }) }),
);
const select = fc.oneof(
  condition.map((where) => ({ record: "Sector", where })),
  fc.record({ map: fc.constantFrom("MAP01", "MAP02"), expectedIndex: fc.integer({ min: 0, max: 2 }) }).map((pin) => ({ record: "Sector", pin })),
  fc.constant({ record: "Sector", all: true }),
);
const change = fc.oneof(
  fc.constant({ lightlevel: { scale: 0.5, clamp: [32, 255] } }),
  fc.constant({ lightlevel: { clamp: [10, 20] } }),
  fc.constant({ tag: { set: 3 } }),
  fc.constant({ floorpic: { set: "BLOOD1" } }),
);
/** 合法补丁：1 到 3 个操作，id 唯一。 */
const validPatch: fc.Arbitrary<Json> = fc.array(fc.record({ select, change }), { minLength: 1, maxLength: 3 }).map((ops) => ({
  schemaVersion: 1,
  name: "p",
  target: { format: "fake", maps: "*" },
  operations: ops.map((o, i) => ({ id: `op${i}`, ...o })),
}));

interface Expected {
  path: string;
  operationId?: string;
  /** 结构类变异不打开 Record_Source。 */
  structural: boolean;
}
type Mutation = (p: Json, n: number) => Expected | null;

const ops = (p: Json) => p.operations as Json[];
const opAt = (p: Json, n: number) => ops(p)[n % ops(p).length]!;
const indexOf = (p: Json, n: number) => n % ops(p).length;

const MUTATIONS: Record<string, Mutation> = {
  "删顶层必需键": (p, n) => {
    const k = ["schemaVersion", "name", "target", "operations"][n % 4]!;
    delete p[k];
    return { path: "/" + k, structural: true };
  },
  "删操作必需键": (p, n) => {
    const i = indexOf(p, n);
    const k = ["id", "select", "change"][n % 3]!;
    const op = opAt(p, n);
    const id = op.id as string;
    delete op[k];
    return { path: `/operations/${i}/${k}`, ...(k === "id" ? {} : { operationId: id }), structural: true };
  },
  "重复 id": (p, n) => {
    if (ops(p).length < 2) return null;
    const i = 1 + (n % (ops(p).length - 1));
    ops(p)[i]!.id = "op0";
    return { path: `/operations/${i}/id`, operationId: "op0", structural: true };
  },
  "选择器不是恰好一种": (p, n) => {
    const op = opAt(p, n);
    const s = op.select as Json;
    if ("all" in s) s.where = { tag: { eq: 1 } };
    else if (n % 2 === 0) s.all = true;
    else {
      delete s.where;
      delete s.pin;
    }
    return { path: `/operations/${indexOf(p, n)}/select`, operationId: op.id as string, structural: true };
  },
  "空 where": (p, n) => {
    const op = opAt(p, n);
    op.select = { record: "Sector", where: {} };
    return { path: `/operations/${indexOf(p, n)}/select/where`, operationId: op.id as string, structural: true };
  },
  "空字段条件": (p, n) => {
    const op = opAt(p, n);
    op.select = { record: "Sector", where: { lightlevel: {} } };
    return { path: `/operations/${indexOf(p, n)}/select/where/lightlevel`, operationId: op.id as string, structural: true };
  },
  "all 不是 true": (p, n) => {
    const op = opAt(p, n);
    op.select = { record: "Sector", all: [false, "true", 1, null][n % 4] };
    return { path: `/operations/${indexOf(p, n)}/select/all`, operationId: op.id as string, structural: true };
  },
  "加 offset": (p, n) => {
    const where = n % 3;
    if (where === 0) {
      p.offset = 12;
      return { path: "/offset", structural: true };
    }
    const op = opAt(p, n);
    if (where === 1) {
      op.offset = 12;
      return { path: `/operations/${indexOf(p, n)}/offset`, operationId: op.id as string, structural: true };
    }
    const ch = op.change as Record<string, Json>;
    const field = Object.keys(ch)[0]!;
    ch[field]!.bytes = [1, 2];
    return { path: `/operations/${indexOf(p, n)}/change/${field}/bytes`, operationId: op.id as string, structural: true };
  },
  "未知字段": (p, n) => {
    const op = opAt(p, n);
    (op.change as Json).nosuchfield = { set: 1 };
    return { path: `/operations/${indexOf(p, n)}/change/nosuchfield`, operationId: op.id as string, structural: false };
  },
  "反向 clamp": (p, n) => {
    const op = opAt(p, n);
    op.change = { lightlevel: { clamp: [200, 100] } };
    return { path: `/operations/${indexOf(p, n)}/change/lightlevel/clamp`, operationId: op.id as string, structural: true };
  },
  "名称用 scale": (p, n) => {
    const op = opAt(p, n);
    op.change = { floorpic: { scale: 2 } };
    return { path: `/operations/${indexOf(p, n)}/change/floorpic/scale`, operationId: op.id as string, structural: false };
  },
};

describe("Feature: patch-engine, Property 7: 校验先于读取", () => {
  it("合法补丁本身通过校验", () => {
    fc.assert(
      fc.property(validPatch, (p) => {
        const fake = makeFake();
        const r = planPatch(encodeModel(sampleModel()), p, fake.adapter);
        expect(r.issues.filter((i) => i.code === "INVALID_PATCH")).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it.each(Object.keys(MUTATIONS))("%s：INVALID_PATCH，operationId 和 path 正确", (name) => {
    fc.assert(
      fc.property(validPatch, fc.nat(1000), fc.boolean(), (p, n, dry) => {
        const mutated = JSON.parse(JSON.stringify(p)) as Json;
        const want = MUTATIONS[name]!(mutated, n);
        fc.pre(want !== null);
        const fake = makeFake();
        const input = encodeModel(sampleModel());
        const r = dry ? planPatch(input, mutated, fake.adapter) : applyPatch(input, mutated, fake.adapter);
        expect(r.ok).toBe(false);
        expect("output" in r && r.output !== undefined).toBe(false);
        expect(r.issues).toHaveLength(1);
        const issue = r.issues[0]!;
        expect(issue.code).toBe("INVALID_PATCH");
        expect(issue.path).toBe(want!.path);
        expect(issue.operationId).toBe(want!.operationId);
        if (want!.structural) expect(fake.counts.open).toBe(0);
        expect(fake.counts.writeField).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
