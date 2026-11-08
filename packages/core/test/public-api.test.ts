import { describe, expect, it } from "vitest";
import * as pub from "../src/index.ts";
import * as internal from "../src/internal.ts";

describe("@necrohex/core 公开入口", () => {
  it("不导出 ByteOverlay（它接收裸偏移和字节，只经 ./internal 提供）", () => {
    expect("ByteOverlay" in pub).toBe(false);
    expect(typeof internal.ByteOverlay).toBe("function");
  });

  it("仍导出 Span 工具", () => {
    for (const name of ["span", "mergeSpans", "complementSpans", "spansOverlap", "spanLength", "spanWithin"]) {
      expect(typeof (pub as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
