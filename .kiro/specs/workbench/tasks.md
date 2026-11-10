# Implementation Plan: workbench

## Overview

先改 adapter-wad 和 cli（移走 Node 代码、共享导出逻辑、几何），再建 `packages/web`：构建脚本、Worker、状态逻辑、组件，最后测试、截图和导出验证。"§X" 指 `design.md` 的 X 节。

## Tasks

- [x] 1. adapter-wad 不含 Node 模块
  - [x] 1.1 `src/node/engine-smoke.ts` 移到 `packages/cli/src/engine-smoke.ts`，`test/engine-smoke.test.ts` 移到 `packages/cli/test/`，`scripts/engine-smoke.ts` 移到 `packages/cli/scripts/`
    - 删除 adapter-wad 的 `./node` 导出；`patch-entry.test.ts` 改为只检查主入口，`exports` 恰为 `.`；cli 的 `imports.test.ts` 去掉 `@necrohex/adapter-wad/node`，并扫描 `packages/web/src`
    - 更新 `fixtures/README.md` 和 `docs/decisions.md` 中的路径
    - _Requirements: 8.2, 8.3, 8.4_
- [x] 2. 共享导出逻辑和几何
  - [x] 2.1 `src/patch-export.ts`：`scopeMap`、`replayChanges`、`exportPatchPwad`，`WadExportError` 增加 `REPLAY_MISMATCH`；主入口导出它们和 `flatNames`
    - 按 §Patch_Export
    - _Requirements: 7.1, 7.2_
  - [x] 2.2 `cli/src/ops.ts` 的 `apply` 和 `verify` 改用它们，错误码映射不变；`apply-export.test.ts` 改从 adapter-wad 导入 `replayChanges`
    - _Requirements: 7.1, 8.3_
  - [x] 2.3 `src/outline.ts`：`sectorOutlines`
    - 按 §扇区轮廓
    - _Requirements: 4.5_
  - [x] 2.4 `test/patch-export.test.ts`、`test/outline.test.ts`
    - _Requirements: 7.1, 4.5_
- [x] 3. `packages/web` 骨架
  - [x] 3.1 `package.json`、`tsconfig.json`（应用）、`tsconfig.node.json`（脚本、测试、配置）、`vite.config.ts`、`index.html`；`.gitignore` 忽略 `public/freedoom/` 和 `.cache/`
    - 依赖：vue、vite（与 vitest 同一主版本）、@vitejs/plugin-vue、vue-tsc、playwright-core（Apache-2.0，只用于截图脚本）
    - _Requirements: 8.1_
  - [x] 3.2 `src/sample.ts`、`scripts/fetch-freedoom.ts`：下载或使用 `NECROHEX_FREEDOOM_ZIP`，校验 zip，解出 `freedoom2.wad`、`COPYING.txt`，校验 WAD；`dev`、`build` 先运行它
    - _Requirements: 2.1, 2.2, 2.3_
- [x] 4. Planner_Worker
  - [x] 4.1 `worker/protocol.ts`、`worker/session.ts`
    - 按 §Planner_Worker
    - _Requirements: 2.4, 2.5, 3.1, 3.2, 4.3, 5.4, 5.5, 7.1–7.5, 9.1_
  - [x] 4.2 `worker/queue.ts`、`worker/planner.worker.ts`、`worker/client.ts`
    - 按 §请求合并；防抖 150 ms
    - _Requirements: 9.1, 9.2, 9.3_
- [x] 5. 状态逻辑
  - [x] 5.1 `state/constants.ts`、`state/presets.ts`、`state/logic.ts`
    - 逐个对照 Mockup 的 `renderPatch`、`renderMap`、`renderRecord`、`renderEditor`、`opControl`、`loadPreset`
    - _Requirements: 1.3, 5.1–5.7, 6.1–6.5_
  - [x] 5.2 `state/store.ts`
    - _Requirements: 2.5, 3.1, 3.3, 9.2_
- [x] 6. 组件
  - [x] 6.1 `styles.css`（Mockup `<style>` 原文）、`App.vue`、`AppHeader.vue`
    - _Requirements: 1.1, 1.2, 1.6, 2.3, 3.1, 3.3_
  - [x] 6.2 `PatchPanel.vue`、`IssueCard.vue`
    - _Requirements: 5.1–5.7_
  - [x] 6.3 `MapPanel.vue`
    - _Requirements: 1.4, 4.1–4.4_
  - [x] 6.4 `RecordPanel.vue`
    - _Requirements: 1.5, 6.1–6.5_
  - [x] 6.5 `ExportDialog.vue`
    - _Requirements: 7.2–7.5_
- [x] 7. Web 测试
  - [x] 7.1 `test/logic.test.ts`、`test/queue.test.ts`、`test/session.test.ts`
    - 按 §Testing Strategy
    - _Requirements: 10.1_
- [x] 8. 检查
  - [x] 8.1 五个包的 typecheck、build、test
    - _Requirements: 8.3, 10.4_
- [x] 9. 浏览器验证
  - [x] 9.1 `scripts/screenshots.ts`：1440 和 390 宽度截图；同一预设下 Mockup 与正式版的 1440 截图并排拼成一张，存到 `out/`
    - _Requirements: 10.2_
  - [x] 9.2 在浏览器里用 haunted-house 导出 PWAD 和回执到 `out/`，用 `verify_output` 验证
    - _Requirements: 10.3_
  - [x] 9.3 把截图比较中发现的差异和原因补进报告；在 `docs/kiro-usage.md` 记下这次 Spec 实际改变了什么
    - _Requirements: 10.2_
