import { applyPatch } from "@necrohex/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { patchFor } from "./arbitraries.ts";
import { Hits, RUNS, SAMPLES } from "./patch-helpers.ts";

describe.each(SAMPLES)("Feature: patch-engine, Property 12: unchanged 与 changedCount（%s）", (_label, sample) => {
  it("span 内字节有变化当且仅当 unchanged 为 false；unchanged 条目仍在回执中；changedCount 为 false 条目数", () => {
    const ok = new Hits();
    const both = new Hits();
    fc.assert(
      fc.property(sample.chain((bytes) => patchFor(bytes, { validOnly: true }).map((patch) => ({ bytes, patch }))), ({ bytes, patch }) => {
        const r = applyPatch(bytes, patch, wadAdapter);
        if (!r.ok) return;
        ok.hit();
        const out = r.output!;
        const entries = r.receipt!.entries;
        expect(entries).toEqual(r.changes);
        for (const e of entries) {
          let differs = false;
          for (let i = e.span.start; i < e.span.end; i++) if (out[i] !== bytes[i]) differs = true;
          expect(differs, `${e.scope} ${e.record} #${e.index} ${e.field}`).toBe(!e.unchanged);
        }
        expect(r.changedCount).toBe(entries.filter((e) => !e.unchanged).length);
        if (entries.some((e) => e.unchanged) && entries.some((e) => !e.unchanged)) both.hit();
      }),
      // 两种条目同时出现的运行在 Freedoom 夹具上只占约 6%（2026-11-09 连跑 60 次：每 100 次均值 5.8、最小 1），
      // 100 次运行时一次都不出现的概率约 0.25%。属性不变，只把运行次数加到 3 倍，这个概率降到 1e-7 以下。
      { numRuns: 3 * RUNS },
    );
    expect(ok.n).toBeGreaterThan(0);
    // 生成器约一半 set 取旧值，两种条目应同时出现过
    expect(both.n).toBeGreaterThan(0);
  });
});
