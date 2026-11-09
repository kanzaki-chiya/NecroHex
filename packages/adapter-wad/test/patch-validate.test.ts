import { applyPatch, planPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { patchFor } from "./arbitraries.ts";
import { countingAdapter, jsonCopy, RUNS, SAMPLES, sameBytes } from "./patch-helpers.ts";

type Json = Record<string, unknown>;

interface Expected {
  path: string;
  operationId?: string;
  /** 结构类变异不打开 Record_Source；schema 类变异要打开后才能判断。 */
  structural: boolean;
}

const ops = (p: Json) => p.operations as Json[];
const at = (p: Json, n: number) => n % ops(p).length;
const op = (p: Json, n: number) => ops(p)[at(p, n)]!;
const base = (p: Json, n: number) => `/operations/${at(p, n)}`;
const firstChangeField = (o: Json) => Object.keys(o.change as Json)[0]!;
const intField = (record: string) => (record === "Sector" ? "lightlevel" : "angle");

const MUTATIONS: Record<string, (p: Json, n: number) => Expected | null> = {
  // 结构类
  "删顶层必需键": (p, n) => {
    const k = ["schemaVersion", "name", "target", "operations"][n % 4]!;
    delete p[k];
    return { path: "/" + k, structural: true };
  },
  "删操作必需键": (p, n) => {
    const o = op(p, n);
    const k = ["id", "select", "change"][n % 3]!;
    const id = o.id as string;
    delete o[k];
    return { path: `${base(p, n)}/${k}`, ...(k === "id" ? {} : { operationId: id }), structural: true };
  },
  "重复 id": (p, n) => {
    if (ops(p).length < 2) return null;
    const i = 1 + (n % (ops(p).length - 1));
    ops(p)[i]!.id = "op0";
    return { path: `/operations/${i}/id`, operationId: "op0", structural: true };
  },
  "选择器不是恰好一种": (p, n) => {
    const o = op(p, n);
    const s = o.select as Json;
    if ("all" in s) s.pin = { map: "MAP01", expectedIndex: 0 };
    else s.all = true;
    return { path: `${base(p, n)}/select`, operationId: o.id as string, structural: true };
  },
  "空 where": (p, n) => {
    const o = op(p, n);
    o.select = { record: (o.select as Json).record, where: {} };
    return { path: `${base(p, n)}/select/where`, operationId: o.id as string, structural: true };
  },
  "空字段条件": (p, n) => {
    const o = op(p, n);
    o.select = { record: (o.select as Json).record, where: { tag: {} } };
    return { path: `${base(p, n)}/select/where/tag`, operationId: o.id as string, structural: true };
  },
  "all 不是 true": (p, n) => {
    const o = op(p, n);
    o.select = { record: (o.select as Json).record, all: [false, "true", 1, null][n % 4] };
    return { path: `${base(p, n)}/select/all`, operationId: o.id as string, structural: true };
  },
  "加 offset 或 bytes": (p, n) => {
    const o = op(p, n);
    switch (n % 4) {
      case 0:
        p.offset = 1024;
        return { path: "/offset", structural: true };
      case 1:
        o.bytes = [0, 1];
        return { path: `${base(p, n)}/bytes`, operationId: o.id as string, structural: true };
      case 2:
        (o.select as Json).offset = 12;
        return { path: `${base(p, n)}/select/offset`, operationId: o.id as string, structural: true };
      default: {
        const f = firstChangeField(o);
        ((o.change as Json)[f] as Json).offset = 4;
        return { path: `${base(p, n)}/change/${f}/offset`, operationId: o.id as string, structural: true };
      }
    }
  },
  "反向 clamp": (p, n) => {
    const o = op(p, n);
    const f = intField((o.select as Json).record as string);
    o.change = { [f]: { clamp: [100, 10] } };
    return { path: `${base(p, n)}/change/${f}/clamp`, operationId: o.id as string, structural: true };
  },
  // schema 类
  "未知记录类型": (p, n) => {
    const o = op(p, n);
    o.select = { record: "Seg", all: true };
    return { path: `${base(p, n)}/select/record`, operationId: o.id as string, structural: false };
  },
  "只读记录": (p, n) => {
    const o = op(p, n);
    o.select = { record: "Linedef", all: true };
    o.change = { tag: { set: 1 } };
    return { path: `${base(p, n)}/select/record`, operationId: o.id as string, structural: false };
  },
  "未知字段（change）": (p, n) => {
    const o = op(p, n);
    (o.change as Json).floorTexture = { set: "BLOOD1" };
    return { path: `${base(p, n)}/change/floorTexture`, operationId: o.id as string, structural: false };
  },
  "未知字段（where）": (p, n) => {
    const o = op(p, n);
    o.select = { record: (o.select as Json).record, where: { brightness: { gte: 1 } } };
    return { path: `${base(p, n)}/select/where/brightness`, operationId: o.id as string, structural: false };
  },
  "名称用 scale": (p, n) => {
    const o = op(p, n);
    o.select = { record: "Sector", all: true };
    o.change = { floorpic: { scale: 2 } };
    return { path: `${base(p, n)}/change/floorpic/scale`, operationId: o.id as string, structural: false };
  },
  "名称用大小比较": (p, n) => {
    const o = op(p, n);
    o.select = { record: "Sector", where: { ceilingpic: { lt: "F" } } };
    o.change = { tag: { set: 1 } };
    return { path: `${base(p, n)}/select/where/ceilingpic/lt`, operationId: o.id as string, structural: false };
  },
  "值类型与字段不符": (p, n) => {
    const o = op(p, n);
    const f = intField((o.select as Json).record as string);
    o.change = { [f]: { set: "bright" } };
    return { path: `${base(p, n)}/change/${f}/set`, operationId: o.id as string, structural: false };
  },
  "target.format 不符": (p) => {
    (p.target as Json).format = "udmf";
    return { path: "/target/format", structural: true };
  },
};

describe.each(SAMPLES)("Feature: patch-engine, Property 7: 校验先于读取（%s）", (_label, sample) => {
  it.each(Object.keys(MUTATIONS))("%s：INVALID_PATCH，operationId 和 path 正确", (name) => {
    fc.assert(
      fc.property(
        sample.chain((bytes) => patchFor(bytes).map((patch) => ({ bytes, patch }))),
        fc.nat(1000),
        fc.boolean(),
        ({ bytes, patch }, n, dry) => {
          const mutated = jsonCopy(patch);
          const want = MUTATIONS[name]!(mutated, n);
          fc.pre(want !== null);
          const { adapter, opens } = countingAdapter();
          const before = bytes.slice();
          const r = dry ? planPatch(bytes, mutated, adapter) : applyPatch(bytes, mutated, adapter);
          expect(r.ok).toBe(false);
          expect((r as { output?: unknown }).output).toBeUndefined();
          expect(r.issues).toHaveLength(1);
          expect(r.issues[0]).toMatchObject({ code: "INVALID_PATCH", path: want!.path });
          expect(r.issues[0]!.operationId).toBe(want!.operationId);
          expect(opens()).toBe(want!.structural ? 0 : 1);
          expect(sameBytes(bytes, before)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
