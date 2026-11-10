# Design Document

## Overview

`packages/web` 是一个静态网站。主线程只有 Vue 组件和纯函数的状态逻辑；解析、哈希、规划、回执和导出都在 Planner_Worker 里，由 `Session` 调用 `@necrohex/core` 和 `@necrohex/adapter-wad`。Mockup 的 `<style>` 整段搬进 `src/styles.css`，组件按 Mockup 的 DOM 拆分，`id` 和 `class` 不变。

为了让 CLI 和 Web 共用规则，先改两个已有的包：

- **adapter-wad 新增 `patch-export.ts`**：`replayChanges`、`exportPatchPwad`、`scopeMap`，从 `cli/src/ops.ts` 移来，CLI 改为调用它们。
- **adapter-wad 新增 `outline.ts`**：只读的扇区轮廓（Workbench 画地图用）。
- **adapter-wad 主入口导出 `flatNames`**：编辑器的贴图名候选列表用；是否存在仍由 adapter 的 `flat-exists` 检查判断。
- **`src/node/engine-smoke.ts` 移到 `packages/cli/src/engine-smoke.ts`**：adapter-wad 不再含 Node 模块，`./node` 子路径删除；测试和脚本一起移走。

## Architecture

```text
packages/web/
  index.html                 Mockup 的 <head>（字体链接、标题）+ #app
  vite.config.ts             vue 插件、worker.format=es、base './'、vitest 配置
  scripts/fetch-freedoom.ts  下载、校验、解压 Sample 到 public/freedoom/
  scripts/screenshots.ts     playwright-core + 本机 Edge/Chrome，截图到 out/
  src/
    sample.ts                Sample 的版本、URL、两个 SHA-256（脚本和页面共用）
    styles.css               Mockup <style> 原文 + 新控件的少量规则
    main.ts / App.vue
    components/              AppHeader、PatchPanel、MapPanel、RecordPanel、IssueCard、ExportDialog
    state/
      logic.ts               纯函数：补丁编辑、结论、分组、记录行、字节行、文件名
      constants.ts           SPECIAL 表、图例、颜色函数（来自 Mockup）
      presets.ts             预设：patches/ 的两个文件 + careless-edit 样例
      store.ts               reactive 状态 + 调用 WorkerClient
    worker/
      protocol.ts            请求、响应和视图类型
      session.ts             Session（无 DOM，可在 Node 测试）
      queue.ts               请求合并
      planner.worker.ts      Worker 入口
      client.ts              主线程的请求、防抖、过期结果丢弃
  test/                      logic、queue、session 测试
  public/freedoom/           生成的 freedoom2.wad、COPYING.txt（git 忽略）
```

依赖：`web` → `adapter-wad` → `core`，与 `cli` 平级。`web` 不依赖 `cli`。

## Patch_Export（adapter-wad/src/patch-export.ts）

```ts
export function scopeMap(wad: WadFile, scope: string): MapScope | undefined;
export function replayChanges(input: Uint8Array, changes: readonly PlannedChange[], expected?: Uint8Array): WadFile;
export function exportPatchPwad(input: Uint8Array, result: ApplyResult): PwadExport;
```

- `replayChanges`：解析输入，对每个 `unchanged === false` 的条目调用 `WadFile.setField`；给出 `expected` 时要求 `serialize()` 与它逐字节相同。条目指向的记录不可写或结果不同时抛 `WadExportError("REPLAY_MISMATCH")`。
- `exportPatchPwad`：`result.ok` 为真且有 `output`；有改动的作用域为空时抛 `WadExportError("NOTHING_TO_EXPORT")`；否则 `exportPwad(replayChanges(input, result.changes, result.output), { maps: 改动的地图名 })`。
- CLI 的 `apply` 改为调用 `exportPatchPwad`，`NOTHING_TO_EXPORT` 映射为原来的 `NOTHING_TO_WRITE`，`REPLAY_MISMATCH` 映射为 `INTERNAL`，其他 `WadExportError` 仍为 `EXPORT_REJECTED`；消息末尾仍是 “; nothing was written”。

## 扇区轮廓（adapter-wad/src/outline.ts）

`sectorOutlines(wad, map): Point[][][]`，下标即扇区下标，每个扇区若干个环，坐标是地图坐标。

1. 每条 Linedef：正面 Sidedef 的扇区得到有向边 v1→v2，背面的扇区得到 v2→v1；两面是同一扇区时都不加（内部线，填充时互相抵消）。越界的顶点、Sidedef、扇区引用跳过。
2. 每个扇区按起点坐标建邻接表，从未用过的边出发沿边走，回到起点时闭合成环；走不下去时得到一条不闭合的链，仍作为一个环输出（SVG 填充时自动闭合）。
3. 只读，不改 WadFile。

Workbench 把 y 取反后写成 `M x y L … Z` 路径，`fill-rule="evenodd"`，与 Mockup 的 `d` 同一种写法。

## Planner_Worker

### 协议（worker/protocol.ts）

| 请求 | 内容 | 响应 |
| :--- | :--- | :--- |
| `open` | `name`、`bytes`（转移）、`sample?: { sha256, version }` | `WadSummary`：名称、类型、大小、SHA-256、版本、地图列表（scope、名称、格式、可否编辑）、是否使用基础 IWAD |
| `map` | `scope` | `MapData`：边界、扇区（路径、字段）、线段、Thing、SECTORS/THINGS 的文件偏移与字节、指纹、贴图名列表 |
| `plan` | `seq`、`patch`、`scope` | `PlanView`（见下） |
| `status` | `patches[]` | 每个补丁的 `ok` |
| `receipt` | `seq`、`patch` | 回执的 `patchHash`、`inputHash`、`outputHash` 或问题列表 |
| `export` | `patch` | 成功：PWAD 字节、回执 JSON 文本、导出的地图、检查、哈希；失败：问题或错误码 |

### PlanView

- `ok`、`patchHash`（结构不合法时为 null）、`checks`；
- `pins`、`issues`、`warnings`：引擎结果原样整理，`operationId` 记为 `op`，CONFLICT_FIELD 的 `operationIds` 保留；
- `changes`：当前 Scope 中 `unchanged === false` 的条目（`op`、`record`、`index`、`field`、`oldValue`、`newValue`、`kind`、`span`）；
- `changedByMap`：每张地图改动的字段数；
- `after`：`ok` 时当前 Scope 重放后的 SECTORS、THINGS 字节（`replayChanges`），否则为 null。

### Session

- `open`：`WadFile.parse`（失败抛 `WadParseError`）；`bytesHash`；给了 `sample` 时哈希必须相等，否则拒绝；Sample 的字节另存为基础 IWAD。PWAD 且有基础 IWAD 时 `createWadAdapter({ baseIwad })`，否则 `createWadAdapter()`。作用域列表来自 `adapter.open(bytes).scopes()`。
- `plan`：`planPatch(input, patch, adapter)`；ok 时 `replayChanges(input, r.changes)` 取当前 Scope 的两个 Lump。
- `receipt`：`applyPatch`，只返回哈希。
- `export`：`applyPatch` → `exportPatchPwad`；回执文本与 CLI 相同（`JSON.stringify(receipt, null, 2) + "\n"`）。不改 `input`。

### 请求合并（worker/queue.ts）

Worker 收到消息先入队，用 `setTimeout(0)` 排空。排空时：同类 `plan` 只保留 `seq` 最大的一个；`receipt` 的 `seq` 小于已收到的最大 plan `seq` 时直接回复 `stale`；其余请求按顺序处理。主线程按 `seq` 丢弃过期的 plan 和 receipt 结果。

## 主线程状态

`store.ts` 用 `reactive` 保存与 Mockup `state` 相同的字段：`preset`、`patch`、`off`、`after`、`focus`、`sel`，另加 `scope`、`wad`（WadSummary）、`map`（MapData，`shallowRef`）、`plan`（PlanView，`shallowRef`）、`receipt`、`busy`、`error`。所有派生计算在 `logic.ts`：

| 函数 | Mockup 对应 |
| :--- | :--- |
| `activePatch` | `activePatch()` |
| `isEdited` | `isEdited()` |
| `indexPlan` | `evaluate()` 里的 `byKey`、`blocked` |
| `verdictView` | `renderPatch` 的结论 |
| `opRows`、`opControl` | 操作列表和数值控件 |
| `issueGroups` | 原因和警告卡片的分组、`strip` |
| `recordView` | `renderRecord` 的字段行和原因 |
| `hexRows` | `renderRecord` 的字节行 |
| `editorOperation`、`upsertOperation`、`removeOperation` | `renderEditor` 的 `apply` / `remove` |
| `initialSelection` | `loadPreset` 的选中逻辑 |
| `exportFileName`、`patchFileName` | 新增 |

这些函数只做显示和补丁 JSON 的编辑，不判断补丁能否写入。

## 与 Mockup 的已知差异

| 差异 | 原因 |
| :--- | :--- |
| haunted-house 多出一条 `sector-light-effect-invisible` 警告 | Mockup 生成于这个钩子之前；正式版用真实引擎 |
| 结论里的回执哈希是 Sample 上实际算出的 `outputHash` | Mockup 内嵌的值来自旧的补丁结果 |
| 顶栏多 `Open WAD`、`Open patch`，`Export PWAD` 可用 | 本轮新功能 |
| 地图面板标题多一个地图下拉框 | 可以切换地图 |
| 补丁 JSON 多一个 `Download` 按钮 | 本轮新功能 |
| Freedoom 版本是指向 `COPYING.txt` 的链接 | 许可文件随站点发布 |
| 加载中和出错时的提示 | Mockup 数据内嵌，没有加载过程 |

截图比较后发现的其他差异补在任务 9 的报告里。

## Testing Strategy

- `test/logic.test.ts`：补丁编辑（开关、数值、编辑器生成的 pin 和 where、加目标地图、删除）、`isEdited`、结论文案、原因分组、记录行、字节行（偏移、粉红标记）、文件名清理。
- `test/queue.test.ts`：合并 plan、丢弃过期 receipt、其他请求保序。
- `test/session.test.ts`：用 `packages/adapter-wad/fixtures/freedoom/freedoom2-map01-02.wad`：打开、地图数据（扇区数、轮廓闭合）、规划 haunted-house（含 `sector-light-effect-invisible`）、重放字节与 `applyPatch` 输出一致、导出 PWAD 与 CLI 的 `apply` 产物逐字节相同、拒绝的补丁不导出、Sample 哈希不符时拒绝。
- adapter-wad：`test/outline.test.ts`（Freedoom 夹具上每个有边界线段的扇区都得到闭合环；内部线不产生边）、`test/patch-export.test.ts`（重放一致、无改动时 `NOTHING_TO_EXPORT`、`modified` 标志）。
- 现有测试全部保留；引擎冒烟测试移到 cli。
- 截图：`scripts/screenshots.ts`。
