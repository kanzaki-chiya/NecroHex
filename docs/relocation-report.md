# 重定位报告：Haunted House

由 `packages/adapter-wad/scripts/relocation-report.ts` 生成，不要手工编辑。在 `packages/adapter-wad` 下重新生成：

```text
node scripts/relocation-report.ts fixtures/cache/freedoom-0.12.1/freedoom2.wad 0.12.1 fixtures/cache/freedoom-0.13.0/freedoom2.wad 0.13.0 ../../patches/haunted-house.nhpatch.json ../../docs/relocation-report.md
```

两个 WAD 取自 GitHub 上 freedoom/freedoom 的发行版 v0.12.1 和 v0.13.0（`freedoom-<版本>.zip`），放在 `fixtures/cache/` 下，不提交。下载和校验情况见 `docs/decisions.md`。

所有 pin 都经补丁引擎的 `planPatch` 解析（干跑，不写文件）。报告只列出检查结果，不说明地图可以通关。

## 输入

| 版本 | 文件 | SHA-256 |
| :--- | :--- | :--- |
| Freedoom 0.12.1 | `freedoom2.wad` | `729f100448d0b48e12ecc8004e096a9ea6df024467d962f002bb286805be3a8e` |
| Freedoom 0.13.0 | `freedoom2.wad` | `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b` |

重定位阈值：高置信度 0.85，候选下限 0.5，唯一候选与第二名至少差 0.1。指纹权重：centroid 0.4，lineCount 0.1，heights 0.2，floorpic 0.1，ceilingpic 0.1，tag 0.1；几何中心相距 32 个单位及以上得 0。

## 目标地图在两个版本之间的差异

| 地图 | 扇区数（0.12.1 → 0.13.0） | 线段数 | 顶点数 | 有差异的 Lump |
| :--- | :--- | :--- | :--- | :--- |
| MAP01 | 198 → 211 | 1069 → 1274 | 1008 → 1189 | THINGS、LINEDEFS、SIDEDEFS、VERTEXES、SECTORS |
| MAP02 | 247 → 227 | 1176 → 1123 | 1126 → 1051 | THINGS、LINEDEFS、SIDEDEFS、VERTEXES、SECTORS |

## 补丁重放：每个 pin 的结果

### Freedoom 0.13.0

干跑通过：没有问题，625 个字段会改变。

| 操作 | 地图 | expectedIndex | 结果 | 选中 | 相似度 | 校验了指纹 | 候选（相似度 ≥ 下限） |
| :--- | :--- | ---: | :--- | :--- | ---: | :--- | :--- |
| `strobe-start-map01` | MAP01 | 0 | EXACT | #0 | 1 | 是 | #0（1）、#187（0.5625） |

### Freedoom 0.12.1

干跑被拒绝，不会写出任何字节：CONFLICT_MISSING 1 条。

| 操作 | 地图 | expectedIndex | 结果 | 选中 | 相似度 | 校验了指纹 | 候选（相似度 ≥ 下限） |
| :--- | :--- | ---: | :--- | :--- | ---: | :--- | :--- |
| `strobe-start-map01` | MAP01 | 0 | CONFLICT_MISSING | — | — | 是 | 无 |

`strobe-start-map01` 在 0.12.1 上 #0 的指纹：`{"tag":0,"floorpic":"AQF001","ceilingpic":"FLOOR5_2","heights":[0,128],"centroid":[-149,-69],"lineCount":13}`

`strobe-start-map01` 补丁里的指纹：`{"tag":0,"floorpic":"SLIME14","ceilingpic":"FLOOR5_2","heights":[0,128],"centroid":[-143,-104],"lineCount":16}`

## 跨版本重定位

把一张地图的每个扇区都当作一个带指纹的 pin（指纹取自源版本，`expectedIndex` 为源版本的下标），在另一个版本上解析。

“对照”是一个独立于指纹的判断：扇区全部边界线段的坐标完全相同，并且这组线段在两个版本里都只属于这一个扇区。有对照的 pin 可以自动核对选得对不对；几何改过的扇区没有对照，被应用时无法自动判断对错，单独计数。

补丁的第一张目标地图 MAP01 在两个版本之间有差异，直接用它测试。

### MAP01

| 方向 | pin 数 | EXACT | RELOCATED | CONFLICT_AMBIGUOUS | CONFLICT_MISSING | 有对照 | 对照一致 | 选错 | 有对照但拒绝 | 无对照但应用 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.12.1 → 0.13.0 | 198 | 72 | 4 | 82 | 40 | 74 | 57（77.0%） | 0 | 17 | 19 |
| 0.13.0 → 0.12.1 | 211 | 74 | 6 | 89 | 42 | 74 | 57（77.0%） | 0 | 17 | 23 |

0.12.1 → 0.13.0 的全部 RELOCATED（4 个）：

| 源下标 | 目标下标 | 相似度 | 对照 |
| ---: | ---: | ---: | :--- |
| #19 | #42 | 1 | 一致 |
| #23 | #205 | 0.9321 | 无对照 |
| #59 | #11 | 0.9 | 一致 |
| #104 | #183 | 0.9292 | 无对照 |

0.13.0 → 0.12.1 的全部 RELOCATED（6 个）：

| 源下标 | 目标下标 | 相似度 | 对照 |
| ---: | ---: | ---: | :--- |
| #11 | #59 | 0.9 | 一致 |
| #42 | #19 | 1 | 一致 |
| #47 | #115 | 0.85 | 无对照 |
| #183 | #104 | 0.9292 | 无对照 |
| #198 | #89 | 0.9 | 无对照 |
| #205 | #23 | 0.9321 | 无对照 |

### 全部同名地图

32 张地图，两个方向分别统计。

| 方向 | pin 数 | EXACT | RELOCATED | CONFLICT_AMBIGUOUS | CONFLICT_MISSING | 有对照 | 对照一致 | 选错 | 有对照但拒绝 | 无对照但应用 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.12.1 → 0.13.0 | 11313 | 5333 | 1402 | 2988 | 1590 | 6498 | 6159（94.8%） | 0 | 339 | 576 |
| 0.13.0 → 0.12.1 | 10323 | 5329 | 1366 | 1605 | 2023 | 6498 | 6160（94.8%） | 0 | 338 | 535 |

有对照的 pin 没有一个被重定位到错误的扇区。

## 没有验证的内容

- 没有对照、但被应用的 pin（上表最后一列）是否选对，没有逐个核对。它们多半是几何被改过的扇区，指纹仍高度相似。
- 对照本身是启发式：边界线段完全相同的两个扇区被视为同一个扇区，没有人工确认。
- 这里只做干跑，没有把跨版本重定位后的结果导出并放进引擎运行。
