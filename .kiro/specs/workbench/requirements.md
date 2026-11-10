# Requirements Document

## Introduction

在新包 `packages/web` 实现正式工作台：Vite + Vue 3 + TypeScript strict 的静态网站。视觉和交互以已经确认的示例 `docs/workbench-mockup/index.html`（以下称 Mockup）为准，不重新设计；Mockup 里的小型求值器 `NE` 和内嵌 JSON 数据全部换掉：WAD 在浏览器里解析，规划、检查、写入和导出只调用 `@necrohex/core` 和 `@necrohex/adapter-wad`。依据 `docs/design.md` 第 6、8、9、13 节和 `docs/workbench-mockup/README.md`。

与现有文档不一致、按本次要求处理的两点：

- 包名是 `packages/web`，不是 `docs/design.md` 第 11 节和 structure 规则里的 `workbench/`。
- 地图用 SVG 绘制（Mockup README 明确要求“用 SVG，不用 Canvas”），不是 design.md 第 13 节和 tech 规则里的 Canvas 2D。

## Glossary

- **Mockup**: `docs/workbench-mockup/index.html`，视觉规格。
- **Workbench**: `packages/web` 构建出的网站。
- **Planner_Worker**: Workbench 里运行解析、规划、导出的 Web Worker。
- **Session**: Planner_Worker 内持有当前 WAD、基础 IWAD 和 adapter 的对象，不依赖 DOM，可在 Node 中测试。
- **Sample**: 构建时下载并校验的 Freedoom 0.13.0 `freedoom2.wad`。
- **Preset**: 补丁面板里的一项补丁，来自 `patches/` 下的示例文件、内置样例或用户导入。
- **Active_Patch**: 当前补丁去掉被关闭操作后的副本，交给引擎的就是它。
- **Plan_View**: Planner_Worker 对一次 `planPatch` 结果整理出的视图，按当前地图作用域筛选改动。
- **Patch_Export**: `@necrohex/adapter-wad` 新增的导出流程：在输入上用 `WadFile.setField` 重放引擎实际改动的条目，核对与引擎输出逐字节相同，再调用 `exportPwad`，只导出有改动的地图。CLI 和 Workbench 共用。
- **Scope**: 地图作用域 id（`MAP01`，同名地图为 `MAP01@<markerIndex>`），与 `wadAdapter` 的作用域 id 相同。

## Requirements

### Requirement 1: 视觉与 DOM 与 Mockup 一致

**User Story:** As a 评委, I want 正式版和确认过的示例看起来一样, so that 设计评审的结论仍然成立。

#### Acceptance Criteria

1. THE Workbench SHALL 原样使用 Mockup `<style>` 中的 `:root` 颜色变量、三种字体（Barlow Condensed、IBM Plex Sans、JetBrains Mono，同一个 Google Fonts 链接）、全部选择器和两个断点（1100px 两栏、地图在上；700px 单栏）。
2. THE Workbench SHALL 渲染与 Mockup 相同的 DOM 结构、`id` 和 `class` 名：`header.bar`、`.mark`、`#specimen`、三个 `section.panel`、`.presets`、`.verdict`、`#pins`、`.ops`、`#issues`、`details.json`、`.mapwrap`、`svg.map`、`.maptools`、`.legend`、`.rec`、`.editor`、`.hexwrap`。
3. THE Workbench SHALL 沿用 Mockup 的界面文案（英文），只在数据来源不同时替换其中的地图名、数量和哈希。
4. THE 地图 SHALL 按 Mockup 的画法绘制：扇区按亮度 `hsl(200 9% 4–34%)` 着色，地板为 `BLOOD1` 的扇区用 `hsl(357 55% 6–30%)`，选中操作染 `--stain`，`RELOCATED` 染 `--review` 并用橙色虚线画出旧下标的轮廓，被拦下的染 `--blocked`。
5. THE 字节视图 SHALL 用 Mockup 的配色：改动的字节底色 `#e0508a`，被拦下的 `#ff3b2f`；`RELOCATED` 的记录在地图和标题上用 `#e8a33c` 标出待核对。
6. Mockup 没有的控件（导入 WAD、导入补丁、地图切换、补丁下载、导出对话框、Freedoom 许可链接）SHALL 只用 Mockup 已有的 class（`btn`、`btn small`、`note`、`label`、`pill`）和 `:root` 变量，不引入新的颜色或字体。

### Requirement 2: 内置样本

**User Story:** As a 玩家, I want 打开网页就有一张能试的地图, so that 不需要先找文件。

#### Acceptance Criteria

1. WHEN 运行 `dev` 或 `build`, THE 构建脚本 SHALL 从 Freedoom 的 GitHub 发行页下载 `freedoom-0.13.0.zip`（或使用 `NECROHEX_FREEDOOM_ZIP` 指向的本地文件），校验 zip 的 SHA-256 与官方 CHECKSUM 一致，解出 `freedoom2.wad` 和 `COPYING.txt`，再校验 `freedoom2.wad` 的 SHA-256；任一校验失败时构建失败，不留下未校验的文件。
2. THE 仓库 SHALL NOT 包含下载的 zip 或 WAD；它们只在被 git 忽略的目录里。
3. THE 构建产物 SHALL 带上 Freedoom 的 `COPYING.txt`，页面上有指向它的链接。
4. WHEN Workbench 启动, THE Planner_Worker SHALL 读取 Sample、计算 SHA-256 并与构建时的期望值比较；不一致时显示错误，不打开该文件。
5. WHEN Sample 打开, THE Workbench SHALL 默认显示 MAP01，并能切换到文件里任一张 Doom 格式的地图；Hexen 和 UDMF 地图列出但不可选，并说明原因。

### Requirement 3: 导入

**User Story:** As a 地图作者, I want 用自己的 WAD 和补丁, so that 工作台不只能看样本。

#### Acceptance Criteria

1. WHEN 用户选择一个 `.wad` 文件, THE Workbench SHALL 在 Planner_Worker 里解析它；解析失败（`WadParseError`）时显示原因，保留之前打开的文件。
2. WHEN 打开的文件是 PWAD 且 Sample 已载入, THE Session SHALL 用 Sample 作为基础 IWAD 创建 adapter（与 CLI 的 `--iwad` 相同），新贴图名在其中查找；界面注明基础 IWAD。
3. WHEN 用户选择一个 `*.nhpatch.json`（或 `.json`）文件, THE Workbench SHALL 把它作为新的 Preset 加入列表并选中；JSON 解析失败时显示原因，不加入。
4. THE Workbench SHALL 把导入补丁的结构和内容问题交给引擎判断，按引擎返回的 `INVALID_PATCH` 等问题显示，不自己校验补丁。

### Requirement 4: 地图视图

**User Story:** As a 地图作者, I want 在地图上看到补丁影响了哪里, so that 能快速核对。

#### Acceptance Criteria

1. THE 地图 SHALL 支持滚轮缩放、拖动平移、`Fit` 复位和点击选中扇区或 Thing，行为与 Mockup 相同。
2. THE 地图 SHALL 提供 `Before` / `After` 切换；补丁被拒绝时 `After` 不可用。
3. THE After 视图 SHALL 用 Patch_Export 的重放结果（`replayChanges` 得到的 SECTORS、THINGS 字节）读出新值，不在 Web 里另算新值。
4. WHEN pin 的结果是 `RELOCATED`, THE 地图 SHALL 用虚线画出 `expectedIndex` 对应扇区的轮廓。
5. THE 扇区轮廓 SHALL 由 `@necrohex/adapter-wad` 新增的只读几何函数根据 LINEDEFS、SIDEDEFS、VERTEXES 计算，按 even-odd 规则填充。

### Requirement 5: 补丁面板

**User Story:** As a 地图作者, I want 在写入前看到结论和原因, so that 不会写出坏文件。

#### Acceptance Criteria

1. THE 预设列表 SHALL 至少包含 `patches/haunted-house.nhpatch.json`（默认选中）、`patches/relocation-demo.nhpatch.json` 和 Mockup 的样例 `careless-edit`，每项显示引擎对当前文件的结论（`ready` / `rejected`），被编辑过的显示 `edited`。
2. THE 操作列表 SHALL 支持开关每个操作，并对只改一个字段、不是 pin 的操作提供 Mockup 的数值控件（`scale` 滑块、`set` 的文本、数字或 special 下拉框）。
3. THE 补丁面板 SHALL 显示结论（可以写入或被拒绝、当前地图改动的字段数、其他目标地图）、每个 pin 的结果（`#expectedIndex → #index`、相似度、`RELOCATED` 标为待核对）、拒绝原因卡片和警告卡片，全部来自引擎结果。
4. THE 警告 SHALL 包括 adapter 的全部 warn 类钩子，其中有 `sector-light-effect-invisible`；haunted-house 在 Sample 上的这条警告必须出现。
5. WHEN 结论为 ready 且补丁未被编辑, THE 结论 SHALL 显示引擎回执的 `outputHash` 前缀。
6. THE 补丁 JSON SHALL 可以复制（剪贴板不可用时选中文本），也可以下载为 `<名称>.nhpatch.json`。
7. WHEN 用户点击 pin、原因卡片或警告卡片, THE Workbench SHALL 选中并缩放到对应记录；记录在另一张地图时先切换地图。

### Requirement 6: 记录面板

**User Story:** As a 地图作者, I want 看到一条记录的字段、改动和真实字节, so that 知道补丁到底写了什么。

#### Acceptance Criteria

1. THE 记录面板 SHALL 列出选中记录的全部字段和新旧值；被拦下的字段标红并列出原因卡片，警告列出警告卡片。
2. THE 扇区编辑器 SHALL 生成 `edit-sector-<index>` 操作，选择器是带 `map`、`expectedIndex` 和由 adapter 计算的指纹的 pin；THE Thing 编辑器 SHALL 生成 `edit-thing-<index>` 操作，按坐标和类型用 `where` 选中。
3. WHEN 编辑器为不在 `target.maps` 中的地图生成操作, THE Workbench SHALL 把该地图加入 `target.maps`（`"*"` 不变）。
4. THE 字节视图 SHALL 显示记录在文件里的真实偏移和前后各 8 字节，改动的字节标粉，被拦下字段的字节标红，记录外的字节变暗。
5. THE 字段布局（偏移、长度）SHALL 取自 adapter-wad 生成的 `SectorLayout`、`ThingLayout`，记录解码用生成的 `readSector`、`readThing`。

### Requirement 7: 导出 PWAD

**User Story:** As a 玩家, I want 下载一个能加载的 PWAD, so that 在本地引擎里玩。

#### Acceptance Criteria

1. THE CLI 的 `apply` 和 Workbench 的导出 SHALL 调用同一个 Patch_Export（`applyPatch` 成功后 `exportPatchPwad`），只导出有改动的地图，每张带标记和全部数据 Lump。
2. WHEN 补丁被拒绝或没有任何字节改变, THE 导出 SHALL 不产生文件并显示原因。
3. THE 导出对话框 SHALL 让用户修改文件名（默认由补丁名生成，补全 `.wad`，去掉路径分隔符和保留字符），并提供同名的 `.receipt.json` 回执下载。
4. THE 导出结果 SHALL 列出导出的地图、导出检查、回执的三个哈希，以及“这些是静态检查，不说明地图可以通关”的说明。
5. THE 导出 SHALL NOT 修改已打开的源文件字节；之后的规划仍以源文件为输入。

### Requirement 8: 引擎边界

**User Story:** As a 开发者, I want Web 和 CLI 用同一套规则, so that 两边结论不会不同。

#### Acceptance Criteria

1. THE Web 包 SHALL 只经 `@necrohex/core`、`@necrohex/adapter-wad` 的公开入口规划、检查和写入，不导入 `@necrohex/core/internal`，不含选择器、算子、护栏或编码规则的副本。
2. THE `@necrohex/core` 和 `@necrohex/adapter-wad` 的 `src` SHALL NOT 导入 Node 专有模块；adapter-wad 现有的 `src/node/engine-smoke.ts`（`node:child_process` 等）移到 `packages/cli`，`./node` 子路径删除。
3. WHEN 上述移动完成, THE 现有测试 SHALL 全部继续通过（引擎冒烟测试随代码移到 cli）。
4. THE `packages/cli/test/imports.test.ts` SHALL 同时扫描 `packages/web/src`。

### Requirement 9: 响应

**User Story:** As a 用户, I want 拖滑块时界面不卡, so that 能边调边看。

#### Acceptance Criteria

1. THE 解析、哈希、规划、回执和导出 SHALL 在 Planner_Worker 中运行，主线程不调用 `planPatch` 或 `applyPatch`。
2. WHEN 用户连续编辑数值, THE Workbench SHALL 防抖（150 ms）后才发出规划请求；开关、预设切换立即发出。
3. THE Planner_Worker SHALL 合并排队中的规划请求，只处理最新的一个；回执请求在有更新的规划请求时丢弃；主线程丢弃过期结果。

### Requirement 10: 验证

**User Story:** As a 维护者, I want 有测试和截图, so that 能确认这轮的结果。

#### Acceptance Criteria

1. THE Web 包 SHALL 用 vitest 测试状态逻辑（补丁编辑、结论、分组、字节行、文件名、请求队列）和 Session（用 Freedoom 夹具规划、重放、导出）。
2. THE 截图脚本 SHALL 用真实浏览器在 1440 和 390 宽度下截图，并在 1440 宽度下用同一预设截取 Mockup，结果存到 `out/`（不提交）。
3. WHEN 用 haunted-house 从 Workbench 导出 PWAD 和回执, THE `verify_output`（或 `necrohex verify`）SHALL 对它们报告结果。
4. THE `core`、`adapter-wad`、`cli`、`mcp-server`、`web` 的 typecheck、build 和测试 SHALL 通过。
