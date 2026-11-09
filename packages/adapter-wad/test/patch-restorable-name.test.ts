import { applyPatch, planPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RECORD_LAYOUTS, wadAdapter, WadFile, type FieldLayout } from "../src/index.ts";
import { name8TailWad, validName8 } from "./arbitraries.ts";
import { FIXTURE, RUNS } from "./patch-helpers.ts";

const NAME_FIELDS = Object.entries(RECORD_LAYOUTS.Sector.fields as Record<string, FieldLayout>).filter(([, l]) => l.type === "name8").map(([f]) => f);

/** Freedoom 夹具的变体：MAP01 某个扇区的 name8 字段第一个 NUL 之后放一个非零字节。 */
const fixtureTail = fc
  .record({ pick: fc.nat(), field: fc.constantFrom(...NAME_FIELDS), nulAt: fc.integer({ min: 0, max: 6 }), tail: fc.integer({ min: 1, max: 255 }), tailAt: fc.nat() })
  .map(({ pick, field, nulAt, tail, tailAt }) => {
    const wad = WadFile.parse(FIXTURE);
    const map = wad.findMap("MAP01")!;
    const lump = wad.mapLump(map, "SECTORS")!.index;
    const index = pick % wad.recordCount(lump, "Sector");
    const s = wad.fieldSpan(lump, "Sector", index, field as "floorpic");
    const out = FIXTURE.slice();
    out[s.start + nulAt] = 0;
    out[s.start + nulAt + 1 + (tailAt % (7 - nulAt))] = tail;
    return { bytes: out, map: map.name, index, field };
  });

describe.each([
  ["生成样本", name8TailWad],
  ["Freedoom 夹具", fixtureTail],
] as const)("Feature: patch-engine, Property 13: 不可无损写回的旧名称被拒绝（%s）", (_label, sample) => {
  it("结果含 OLD_VALUE_NOT_RESTORABLE，定位正确，changes 不含该字段", () => {
    fc.assert(
      fc.property(sample, validName8, fc.boolean(), ({ bytes, map, index, field }, value, viaAll) => {
        const select = viaAll ? { record: "Sector", all: true } : { record: "Sector", pin: { map, expectedIndex: index } };
        const patch = { schemaVersion: 1, name: "n", target: { format: "wad", maps: [map] }, operations: [{ id: "pic", select, change: { [field]: { set: value } } }] };
        for (const r of [planPatch(bytes, patch, wadAdapter), applyPatch(bytes, patch, wadAdapter)]) {
          expect(r.ok).toBe(false);
          expect((r as { output?: unknown }).output).toBeUndefined();
          const issue = r.issues.find((i) => i.reason === "OLD_VALUE_NOT_RESTORABLE" && i.locator?.index === index);
          expect(issue).toBeDefined();
          expect(issue).toMatchObject({ code: "VALUE_REJECTED", operationId: "pic", locator: { scope: map, record: "Sector", index }, field });
          expect(issue!.message).toContain(map);
          expect(issue!.message).toContain(`#${index}`);
          expect(issue!.message).toContain(field);
          expect(r.changes.some((c) => c.index === index && c.field === field)).toBe(false);
        }
      }),
      { numRuns: RUNS },
    );
  });
});
