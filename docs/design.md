# NecroHex 设计文档

版本 2 · 2026-11-09 · 参赛赛道：Resurrection

## 1. 定位

NecroHex 是面向 1990 年代 WAD 地图格式的语义补丁工作台。

一份补丁描述“把哪些对象改成什么”，而不是“把哪个偏移写成什么字节”。它可以在写入前检查、写入后撤销，地图更新后还能重放，也可以复用到其他地图。AI Agent 只能通过这层补丁修改文件，碰不到裸字节。

验证载体是开源的 Freedoom。首个版本只支持 WAD，不宣称自己是通用二进制框架。

## 2. 用户与问题

| 用户 | 现在的问题 | NecroHex 提供什么 |
| :--- | :--- | :--- |
| 地图和 Mod 作者 | GUI 编辑器的产物是一份新二进制，修改难审查、难合并；上游地图重新导出后，旧修改无法自动重放 | 可读的补丁文件、字段级 Diff、下标变化后的重定位 |
| 想改造地图的玩家 | 不会用专业编辑器，也没有可以直接套用的改造配方 | 一键套用分享来的补丁，例如“鬼屋化”，并在写入前看到影响范围 |
| 使用 AI 的开发者 | 让 LLM 直接改二进制容易算错偏移、破坏引用 | 通过 MCP 暴露受约束的语义操作，所有写入都要过校验 |

用户需求目前是推断，尚未经过访谈验证。提交前至少找一位 WAD 作者或社区反馈来支撑影响力叙事，详见 [research.md](research.md)。

## 3. 差异点

现有工具已经覆盖 WAD 读写、双向二进制 Schema 和 Doom 相关 MCP。NecroHex 只押注它们之间缺少的一层：

1. **规则型选择器**：同一份补丁能作用于任意地图，例如“所有水面地板”。
2. **语义指纹重定位**：针对具体对象的修改，在下标变化后仍能找回目标，找不准就拒绝。
3. **面向 AI 的写入护栏**：MCP 不提供裸字节写入接口，语义修改也要通过结构和可玩性检查。

竞品和证据见 [research.md](research.md)。

## 4. MVP 范围

### 支持

- 解析和重建 `IWAD`、`PWAD` 容器，包括目录表、零字节标记 Lump 和地图作用域。
- 未解析的 Lump 和间隙字节原样保留。
- 可修改：`SECTORS`、`THINGS`，以及作为可选项的 `PLAYPAL`。
- 只读解析：`LINEDEFS`、`SIDEDEFS`、`VERTEXES`，用于计算指纹、绘制地图和校验引用。
- 补丁流程：选择、干跑、校验、应用、撤销、导出。
- 一个 CLI、一个 MCP Server 和一个可在线访问的工作台。

### 不做

- 不改几何拓扑，不增删顶点、线段和扇区，因此也不重建 BSP。
- 不做第二种格式，不做通用 DSL 编译器。
- 不解析贴图帧和音频，不做 `COLORMAP` 编辑。
- 不做 `LINEDEFS`、`SIDEDEFS` 的写入。
- 不在 MVP 中内嵌浏览器版游戏引擎。网页负责预览和导出，实机运行用本地引擎。
- 在线工作台不接 LLM，自然语言只走 MCP，因此评委试用不需要 API Key。
- MCP 不提供 `write_bytes` 一类接口。

## 5. 演示效果

| 改造 | 字段 | 实机效果 |
| :--- | :--- | :--- |
| 调暗照明 | `SECTORS.lightlevel` | 明亮基地变得昏暗压抑 |
| 频闪灯光 | `SECTORS.special` = 1、2、3、17 | 走廊灯光闪烁 |
| 血池 | `SECTORS.floorpic` → `BLOOD1`，`special` = 5 | 水面变成血池，踩上去扣血 |
| 替换怪物和装饰 | `THINGS.type` | 房间敌人和摆件变化 |
| 血月调色板（可选） | `PLAYPAL` | 全局色调变成暗紫和猩红 |

贴图名和 Thing 类型在 Freedoom 中的实际可用性，要在第一阶段用真实文件确认。

## 6. 补丁格式

```jsonc
// haunted-house.nhpatch.json
{
  "schemaVersion": 1,
  "name": "Haunted House",
  "target": { "format": "wad", "maps": "*" },
  "operations": [
    {
      "id": "dim-lights",
      "select": { "record": "Sector", "where": { "lightlevel": { "gte": 128 } } },
      "change": { "lightlevel": { "scale": 0.5, "clamp": [32, 255] } }
    },
    {
      "id": "blood-pools",
      "select": {
        "record": "Sector",
        "where": { "floorpic": { "in": ["FWATER1", "FWATER2", "FWATER3", "FWATER4"] } }
      },
      "change": { "floorpic": { "set": "BLOOD1" }, "special": { "set": 5 } }
    },
    {
      "id": "strobe-boss-room",
      "select": {
        "record": "Sector",
        "pin": {
          "map": "MAP01",
          "expectedIndex": 12,
          "fingerprint": {
            "tag": 7,
            "floorpic": "FLOOR4_8",
            "ceilingpic": "CEIL3_5",
            "heights": [0, 128],
            "centroid": [1024, -512],
            "bbox": [960, -576, 1088, -448],
            "area": 16384,
            "lineCount": 8
          }
        }
      },
      "change": { "special": { "set": 2 } }
    }
  ]
}
```

规则：

- **选择器** 分两种：`where` 按条件匹配多个对象，可跨地图；`pin` 指向一个具体对象，要经过重定位。
- **算子** 第一版只有 `set`、`scale`、`clamp`。
- **冲突**：两个操作写同一字段时默认报错，由作者调整补丁。
- **回执**：每次应用都输出 `*.receipt.json`，记录每个字段的旧值、新值、物理偏移和重定位结果。撤销依赖回执，不依赖反向计算。
- **幂等性**：`set` 幂等；`scale` 不幂等，重复应用会继续变暗。工具通过回执识别已应用的补丁，默认拒绝重复应用。

## 7. 重定位

`pin` 的匹配结果分四级：

| 结果 | 条件 | 行为 |
| :--- | :--- | :--- |
| `EXACT` | 下标和指纹都吻合 | 应用 |
| `RELOCATED` | 下标不同，但全图只有一个候选达到高置信度 | 应用并记录 `#12 → #15` |
| `CONFLICT_AMBIGUOUS` | 有多个相近候选 | 拒绝并列出候选 |
| `CONFLICT_MISSING` | 没有合格候选 | 拒绝，事务回滚 |

- 初始阈值是 0.85 和 0.5，只是起点，要用真实 Freedoom 版本和合成样本校准。
- 几何部分有三项：边界线段去重顶点的平均（几何中心）、这些顶点的边界框，以及按 Linedef 方向求出的面积（孔洞自动扣除）。只有几何中心时分不清中心相同、大小不同的同心结构，所以加了边界框和面积。
- 对称房间容易撞指纹，宁可判为歧义，也不要猜。
- 相似度 ≥ 0.5 的记录是候选，≥ 0.85 的是高置信度候选。只有一个高置信度候选、并且第二名候选比它至少低 0.1 时才应用；有候选但不满足这一条（包括只有低于 0.85 的候选）时为 `CONFLICT_AMBIGUOUS`。
- 没有 `fingerprint` 的 `pin` 只按下标选中，回执里 `fingerprintChecked` 为 `false`。只有 `Sector` 支持指纹，其他记录带指纹为 `INVALID_PATCH`。
- 校准结果和指纹的组成见 [decisions.md](decisions.md)，真实版本的重放结果见 [relocation-report.md](relocation-report.md)。

## 8. 写入护栏

### 结构护栏

- 字段类型、取值范围和定长字符串长度。
- `ceilingheight >= floorheight`。
- 引用完整性，贴图名必须存在于当前 WAD 或指定的基础 IWAD。

结构约束只针对**新写入的值**。解析时遇到非常规的历史数据不报错，否则无损往返无法成立。

### 可玩性护栏

BSP 合法不代表关卡能玩，所以默认还要拦截或警告：

| 风险 | 规则 |
| :--- | :--- |
| 覆盖秘密房间或门类特效 | 默认不覆盖 `special != 0` 的扇区，需显式声明 |
| 玩家无法完成关卡 | 禁止替换玩家出生点（1–4、11）、传送目标（14）、钥匙（5、6、13、38、39、40） |
| 怪物卡住 | 只允许同类别替换，半径或高度变大时警告 |
| 破坏 Boss 触发 | 地图依赖的 Boss 类型默认不替换 |
| 门和升降机异常 | 带 `tag` 或被线段触发的扇区，修改高度时警告；MVP 演示不改高度 |
| 灯光特效看不出来 | 补丁之后 `special` 为 1、8 或 17 的扇区，如果邻居（双面线段另一侧的扇区）里没有亮度比它低的，警告 `sector-light-effect-invisible`，消息写出本扇区和最暗邻居的亮度。扇区和邻居都按补丁之后的亮度算；只检查补丁改了 `special`、`lightlevel` 或邻居 `lightlevel` 的扇区。只警告，不拦截 |

静态检查无法证明关卡一定能通关，所以导出物还要在真实引擎中做加载冒烟测试。报告里只能写“通过了哪些检查”，不能写“保证可玩”。

## 9. WAD 处理

### 无损往返

- 解析时保留只读的 `baseBuffer`，每个 Lump、记录和字段都记录物理区间。
- 定长字段修改只克隆缓冲并覆写脏区间，其余字节保持不变。
- 未解析的 Lump、间隙和原始名称字节都按原样引用。

### 记录布局

布局定义放在 `packages/adapter-wad/spec/wad.records.yaml`，由小型脚本生成 TypeScript 类型和读写代码。

| 记录 | 字节数 | 字段 |
| :--- | :--- | :--- |
| `Sector` | 26 | `floorheight`、`ceilingheight`、`floorpic[8]`、`ceilingpic[8]`、`lightlevel`、`special`、`tag` |
| `Thing` | 10 | `x`、`y`、`angle`、`type`、`flags` |
| `Linedef` | 14 | `v1`、`v2`、`flags`、`special`、`tag`、`sidenum[2]` |
| `Sidedef` | 30 | `textureoffset`、`rowoffset`、`toptexture[8]`、`bottomtexture[8]`、`midtexture[8]`、`sector` |
| `Vertex` | 4 | `x`、`y` |

`PLAYPAL` 是 14 组 256 色 RGB，共 10752 字节。

### 导出

提供两种产物：

- **完整 WAD**：对原文件原地修改，用于验证字节局部性。
- **PWAD**：加载到基础 IWAD 之上使用。修改某张地图时，必须写入标记 Lump 和该地图的全部数据 Lump，不能只放改动的 Lump。

## 10. 验证

用 `vitest` + `fast-check`，同时跑生成样本和真实 Freedoom 样本。

| 编号 | 不变量 |
| :--- | :--- |
| I-1 | 无损往返：不做修改时，`serialize(parse(B))` 与 `B` 逐字节相同 |
| I-2 | 结构对偶：`parse(serialize(A))` 等于 `A` |
| I-3 | 局部性：字节变化只出现在回执记录的区间内 |
| I-4 | 可撤销：应用后再按回执撤销，文件与原文件逐字节相同；`set` 额外满足幂等 |
| I-5 | 重定位：对扇区做重排后，选择器解析出的目标等于重排后的原目标 |

此外还有：

- **真实版本测试**：用 Freedoom 的两个发行版验证跨版本重放，并记录真实命中率。
- **引擎冒烟测试**：导出的 PWAD 要在一个开源引擎中载入目标地图并运行若干 tic。引擎用安装在仓库之外的 DSDA-Doom，按生成的无输入演示录像以 `-timedemo` 无窗口回放，原因见 [decisions.md](decisions.md)。

## 11. 架构

纯 TypeScript 的 `pnpm` Monorepo，核心逻辑同时运行于 Web Worker、CLI 和 MCP Server。

```text
NecroHex/
├── .kiro/
│   ├── steering/          # 项目约束
│   ├── specs/             # 由 Kiro 生成的功能 Spec
│   └── hooks/             # 校验和代码生成 Hook
├── docs/
├── packages/
│   ├── core/              # 字节缓冲、补丁引擎、重定位、校验，零 DOM 和文件系统依赖
│   ├── adapter-wad/       # 记录布局、WAD 解析和导出、几何计算、Freedoom 样本
│   ├── cli/               # inspect、plan、apply、revert、export
│   ├── mcp-server/        # MCP 工具
│   └── web/               # Vue 3 + Vite 工作台，地图用 SVG
└── patches/               # 示例补丁
```

依赖方向：`web`、`cli`、`mcp-server` → `adapter-wad` → `core`。

## 12. MCP 工具

| 工具 | 作用 | 写入 |
| :--- | :--- | :--- |
| `inspect_wad` | 列出地图、Lump 和记录数量 | 否 |
| `query_entities` | 按条件查询扇区和 Thing | 否 |
| `plan_patch` | 校验补丁并干跑，返回匹配数量、Diff、警告和拒绝原因 | 否 |
| `apply_patch` | 应用已通过干跑的补丁，输出新文件和回执 | 是，不覆盖源文件 |
| `verify_output` | 校验不变量，并按配置运行引擎冒烟测试 | 否 |

## 13. 工作台

视觉方向是“暗黑解剖台”，恐怖元素要服务功能：受影响的区域像被标本染色一样高亮，拒绝的修改用醒目的红色标记。

主界面三块：

- **地图**：SVG 绘制扇区、线段和 Thing，支持修改前后切换（视觉规格见 `docs/workbench-mockup/`）。
- **补丁**：选择预设或导入补丁，查看匹配结果、警告和拒绝原因。
- **字节**：选中地图对象后，定位并高亮对应的 Hex 区间。联动先做地图到 Hex 的单向。

内置 Freedoom 样本和预设补丁，打开就能试，并支持导出 PWAD。

## 14. 主要风险

| 风险 | 应对 |
| :--- | :--- |
| 真实版本之间下标很少漂移，重定位缺少真实案例 | 演示重心转向跨地图复用，重定位只作安全能力展示 |
| 用户需求证据不足 | 提交前找社区反馈，并用具体补丁示例说明价值 |
| “死技术”叙事被质疑，因为 WAD 模组社区仍活跃 | 强调二进制地图格式缺少现代、安全的编辑流程 |
| 第三方商标和授权 | 视频和页面避开 DOOM 名称与 logo；引擎不进 MIT 仓库；保留 Freedoom 的 BSD 声明 |
| 工期不足 | 按 [roadmap.md](roadmap.md) 的判断点和砍功能顺序执行 |
