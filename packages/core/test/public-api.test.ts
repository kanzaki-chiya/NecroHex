import { describe, expect, it } from "vitest";
import * as pub from "../src/index.ts";
import * as internal from "../src/internal.ts";

const SPAN_TOOLS = ["span", "mergeSpans", "complementSpans", "spansOverlap", "spanLength", "spanWithin"];
const ENGINE = ["applyPatch", "bytesHash", "patchHash", "planPatch", "revertPatch"];

describe("@necrohex/core 公开入口", () => {
  it("不导出 ByteOverlay（它接收裸偏移和字节，只经 ./internal 提供）", () => {
    expect("ByteOverlay" in pub).toBe(false);
    expect(typeof internal.ByteOverlay).toBe("function");
  });

  it("仍导出 Span 工具", () => {
    for (const name of SPAN_TOOLS) {
      expect(typeof (pub as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("导出值恰为 Span 工具、五个引擎函数、只读查询、重定位阈值和重定位分级函数", () => {
    expect(Object.keys(pub).sort()).toEqual([...SPAN_TOOLS, ...ENGINE, "queryRecords", "RELOCATION_THRESHOLDS", "classifyPin"].sort());
    expect(typeof pub.classifyPin).toBe("function");
    expect(Object.isFrozen(pub.RELOCATION_THRESHOLDS)).toBe(true);
    for (const name of ENGINE) expect(typeof (pub as Record<string, unknown>)[name], name).toBe("function");
  });

  it("不导出写回通道", () => {
    for (const name of ["restoreField", "registerRestorer", "lookupRestorer", "restorers"]) expect(name in pub, name).toBe(false);
  });
});

describe("@necrohex/core/internal", () => {
  it("导出值恰为 ByteOverlay 和 registerRestorer", () => {
    expect(Object.keys(internal).sort()).toEqual(["ByteOverlay", "registerRestorer"]);
  });

  it("不导出 restoreField 和 lookupRestorer", () => {
    expect("restoreField" in internal).toBe(false);
    expect("lookupRestorer" in internal).toBe(false);
  });
});
