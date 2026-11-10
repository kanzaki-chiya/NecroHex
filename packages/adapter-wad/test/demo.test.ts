import { describe, expect, it } from "vitest";
import { buildIdleDemo } from "../src/index.ts";

describe("演示录像", () => {
  it("v1.9 头、每 tic 4 字节零输入、结束标记", () => {
    const d = buildIdleDemo({ map: "MAP07", tics: 3 });
    expect([...d]).toEqual([109, 2, 1, 7, 0, 0, 0, 0, 0, 1, 0, 0, 0, ...new Array(12).fill(0), 0x80]);
    expect([...buildIdleDemo({ map: "e2m4", tics: 1, skill: 4 }).subarray(0, 4)]).toEqual([109, 4, 2, 4]);
  });

  it("拒绝无法写进录像头的参数", () => {
    expect(() => buildIdleDemo({ map: "MAP00", tics: 1 })).toThrow(RangeError);
    expect(() => buildIdleDemo({ map: "START", tics: 1 })).toThrow(RangeError);
    expect(() => buildIdleDemo({ map: "MAP01", tics: 0 })).toThrow(RangeError);
    expect(() => buildIdleDemo({ map: "MAP01", tics: 1, skill: 5 })).toThrow(RangeError);
  });
});
