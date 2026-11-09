import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // patch-engine 的属性测试在 300 KB 的 Freedoom 夹具上每条跑 100 次以上，默认的 5 秒不够
    testTimeout: 120_000,
  },
});
