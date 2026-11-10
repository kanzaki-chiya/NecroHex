import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 相对路径，站点可以放在任意子目录下
  base: "./",
  plugins: [vue()],
  resolve: {
    alias: { "@patches": fileURLToPath(new URL("../../patches", import.meta.url)) },
  },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 800 },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
