/**
 * patch-engine 属性测试的公共部分：两类样本（生成样本、Freedoom 夹具）和常用断言工具。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RecordAdapter, RecordSource } from "@necrohex/core";
import fc from "fast-check";
import { afterAll, expect } from "vitest";
import { wadAdapter } from "../src/index.ts";
import { mapWad } from "./arbitraries.ts";

export const FIXTURE_PATH = resolve(import.meta.dirname, "../fixtures/freedoom/freedoom2-map01-02.wad");
export const FIXTURE: Uint8Array = new Uint8Array(readFileSync(FIXTURE_PATH));

/**
 * 每个属性都在这两类样本上运行。Freedoom 夹具每次给出同一个数组（profile 按实例缓存），
 * 所以 FIXTURE_COPY 留一份副本，afterAll 核对引擎从未修改过它。
 */
export const SAMPLES: ReadonlyArray<readonly [string, fc.Arbitrary<Uint8Array>]> = [
  ["生成样本", mapWad.map((m) => m.bytes)],
  ["Freedoom 夹具", fc.constant(FIXTURE)],
];

const FIXTURE_COPY: Uint8Array = FIXTURE.slice();

afterAll(() => {
  expect(sameBytes(FIXTURE, FIXTURE_COPY), "the shared Freedoom fixture array was modified").toBe(true);
});

export const RUNS = 100;

/** 计数 open 的 wadAdapter 包装（不登记写回通道，只用于 plan / apply）。 */
export function countingAdapter(): { adapter: RecordAdapter; opens: () => number } {
  let n = 0;
  const adapter: RecordAdapter = {
    format: wadAdapter.format,
    hooks: wadAdapter.hooks,
    open(input: Uint8Array): RecordSource {
      n++;
      return wadAdapter.open(input);
    },
  };
  return { adapter, opens: () => n };
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function jsonCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 统计 fc.assert 中满足条件的运行次数，防止属性因前提总不成立而空转。 */
export class Hits {
  n = 0;
  hit(): void {
    this.n++;
  }
}
