# Kiro Spec 起始提示

按顺序在 Kiro 中新建 Feature Spec，把对应段落作为起始描述，由 Kiro 生成 `requirements.md`、`design.md` 和 `tasks.md`。生成后要结合 [design.md](design.md) 审查，不要直接接受。

Kiro 的属性测试 Correctness 功能只在 IDE 中可用，这几个 Spec 建议在 IDE 里做。

## 1. wad-roundtrip

> 为 NecroHex 构建 WAD 容器层和记录层。解析 IWAD 和 PWAD 文件、Lump 目录表、零字节标记 Lump 和地图作用域。所有未解析的 Lump 和间隙字节都要原样保留。根据 `packages/adapter-wad/spec/wad.records.yaml` 生成记录类型和读取代码。不做修改时，序列化结果必须与输入逐字节相同，并用 fast-check 和真实的 Freedoom 样本验证。详见 `docs/design.md` 第 9 节。

## 2. wad-export

提前到第 2 个，是为了赶上 11-12 的判断点。这一步用手工改动的数据验证，不依赖补丁引擎。

> 实现完整 WAD 和 PWAD 的导出。修改某张地图的 PWAD，必须包含该地图的标记 Lump 和全部数据 Lump。添加引擎冒烟测试：载入目标地图并运行若干 tic。详见 `docs/design.md` 第 9 节。

## 3. semantic-patch

> 在 `packages/core` 中构建补丁引擎。支持 `where` 和 `pin` 选择器，以及 `set`、`scale`、`clamp` 算子，并实现干跑、冲突报错、回执和基于回执的撤销。变化的字节必须全部落在回执列出的区间内，默认拒绝重复应用已记录的补丁。详见 `docs/design.md` 第 6 节和第 10 节。

## 4. guardrails

护栏是不能砍的底线，所以排在重定位前面。

> 实现结构护栏和可玩性护栏。这些检查只针对新写入的值，解析时绝不能拒绝非常规的历史数据。默认保护玩家出生点、传送目标、钥匙、Boss 类型和已有的扇区特效。报告中说明通过了哪些检查，不能声称地图一定可玩。详见 `docs/design.md` 第 8 节。

## 5. relocation

> 为 `pin` 选择器添加语义指纹，以及 `EXACT`、`RELOCATED`、`CONFLICT_AMBIGUOUS`、`CONFLICT_MISSING` 四种结果。遇到相似候选时绝不猜测。添加针对扇区重排的属性测试，并生成一份在两个真实 Freedoom 发行版之间重放补丁的报告。详见 `docs/design.md` 第 7 节。

## 6. cli-and-mcp

> 基于同一个引擎构建轻量 CLI 和 MCP Server，提供 `inspect_wad`、`query_entities`、`plan_patch`、`apply_patch` 和 `verify_output`。不能提供任何写入裸字节的工具，`apply_patch` 不能覆盖源文件。详见 `docs/design.md` 第 12 节。

## 7. workbench

> 用 Vue 3 构建工作台，包含 Canvas 2D 地图视图、带预设的补丁面板，以及能高亮所选地图对象对应字节的 Hex 面板。解析和补丁操作在 Web Worker 中运行。内置一个小型 Freedoom 样本，让网站无需上传文件或 API Key 就能使用。详见 `docs/design.md` 第 13 节。

## 计划中的 Hook

在对应脚本可运行后，再用 Kiro 创建。文件放在 `.kiro/hooks/`，格式遵循[官方文档](https://kiro.dev/docs/hooks/)。

| Hook | 触发 | 动作 |
| :--- | :--- | :--- |
| 代码生成 | 保存 `wad.records.yaml` | 重新生成记录类型和读写代码 |
| 核心回归 | 保存 `core` 或 `adapter-wad` 的代码 | 运行相关单元测试和 I-1、I-3 |
| 裸字节检查 | 保存 `mcp-server` 的代码 | 检查是否出现按偏移写字节的接口 |
| 提交前检查 | Agent 完成任务时 | 运行静态检查，并提醒更新 `docs/kiro-usage.md` |
