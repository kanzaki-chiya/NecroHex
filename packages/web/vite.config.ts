import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { gzipSample } from "./scripts/gzip-sample.ts";

/** vite build 写完 dist 后生成 freedoom/freedoom2.wad.gz，供服务器的 gzip_static 使用。 */
function gzipSamplePlugin(): Plugin {
  let outDir = "";
  return {
    name: "necrohex-gzip-sample",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const r = gzipSample(outDir);
      this.info(`wrote ${r.path} (${r.size} -> ${r.gzipSize} bytes)`);
    },
  };
}

export default defineConfig({
  // 站点部署在域名根目录
  base: "/",
  plugins: [vue(), gzipSamplePlugin()],
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
