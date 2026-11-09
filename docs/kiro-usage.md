# Kiro 使用记录

提交说明的素材。只记录真实发生的事，没有用到的功能不写。提交时再整理成英文。

## 使用的产品

- Kiro 版本：
- 用过的形态（IDE、CLI、Web、Crew）及差异：

## 起步说明

`.kiro/steering/` 的初始版本和 `docs/` 下的设计文档是在开发开始前，用 Claude Code 根据原始设计整理的。后续改动和全部功能开发的来源，按下面的记录填写。

## Specs

| Spec | 工作流 | 产出 | 过程中修正了什么 |
| :--- | :--- | :--- | :--- |
| wad-roundtrip（实现后补写） | 代码和测试先完成，之后补写 requirements、design、tasks，与先写 Spec 再实现的顺序相反。补写完成后，对七项差异逐项做决定，再按 tasks.md 的必需任务实现。点 tasks.md 中的任务按钮执行时报错 “Could not locate tasks.md”，之后改用 Default 模式，让 Agent 按 tasks.md 执行 | `.kiro/specs/wad-roundtrip/` 下的三份文档；按任务实现的修复和测试，回归用例集中在 `packages/adapter-wad/test/regression.test.ts` | 补写过程中靠阅读代码和内存中的临时脚本复现，发现了 `parse` 不复制输入且 `baseBuffer` 可被改写（D-5）、`setField` 可写入文件头（目录项 `filepos` 为 0 时，重新解析抛 `BAD_IDENT`，X-1）、`fieldSpan("constructor")` 返回 `NaN` 区间（F-3）、没有地图标记的裸 `SECTORS` 也能被 `setField` 写入（X-4），以及 Hexen 格式的 `THINGS` 被按 Doom 布局解释（X-3）。这些缺陷已修复，各有回归用例。CI 与 `REQUIRE_FREEDOOM`（D-8）已决定但延后，尚未实现 |
| patch-engine | 先写 requirements、design、tasks，再在一次对话中让 Agent 按 tasks.md 依次实现，完成一项勾选一项 | `.kiro/specs/patch-engine/` 下的三份文档；core 的 `src/hash.ts`、`src/patch/`，adapter-wad 的 `record-source.ts`、`restore-channel.ts`；16 条属性测试和回归用例 | 开工前把 design.md 中的示例字段名 `floorTexture` 改成记录布局里的 `floorpic`。Property 3（`set` 幂等）的属性测试找到两个反例，design.md 的 Property 3 因此加了前提，详见下面"属性测试捕获的 Bug" |

## Hooks

| Hook | 触发条件 | 动作 | 拦下过什么 |
| :--- | :--- | :--- | :--- |
| Regenerate WAD records（`.kiro/hooks/regenerate-records.json`） | PostFileSave，路径匹配 `wad\.records\.yaml$` | `pnpm --filter @necrohex/adapter-wad generate` | 还没有拦下过问题。2026-11-09 在实现写入护栏的会话里用 Kiro 的 createHook 创建，Kiro 提示下次会话开始才生效，所以这次会话里没有触发过。手动运行同一条命令，生成的 `records.ts` 与已提交的版本相同 |
| Typecheck on save（`.kiro/hooks/typecheck-on-save.json`） | PostFileSave，路径匹配 `packages[\\/][^\\/]+[\\/]src[\\/].*\.ts$` | `pnpm -r typecheck` | 还没有拦下过问题。与上一条同时创建，同样在这次会话里没有触发过。手动运行通过。matcher 也匹配 `src/generated/records.ts`，不匹配 `test/` 和 `scripts/` |

## Steering

| 文件 | 起了什么作用 | 真实案例 |
| :--- | :--- | :--- |
| | | |

## MCP

| 工具 | 在开发中如何使用 |
| :--- | :--- |
| | |

## 属性测试捕获的 Bug

| 日期 | 不变量 | 触发样本 | 根因 | 修复提交 |
| :--- | :--- | :--- | :--- | :--- |
| 2026-11-09 | patch-engine Property 3（I-4 的 `set` 幂等） | 生成样本，缩减 6 次：`op0` 选 `where x ne -202 且 angle 在 [-202, 0]` 改 `flags`，`op1` 选 `all` 把 `x` 设为 23402。第一次应用 `op0` 匹配 0 条，对输出再应用匹配 1 条，`flags` 被改 | 不是引擎缺陷。选择器按当前输入求值，后一操作读取前一操作写入的字段时，第二次会选中新记录，属性本身写得过宽 | 未改引擎。design.md 的 Property 3 加上"没有跨操作读取"的前提，测试相应过滤；回归用例 `P3-1`。与 patch-engine 实现同一次提交 |
| 2026-11-09 | patch-engine Property 3（I-4 的 `set` 幂等） | Freedoom 夹具，缩减 24 次：`pin MAP01 #0`，`special` 设为 1、`tag` 设为 -32768。再应用时报 `PROTECTED` | `sector-special-nonzero` 按规则拦截"旧值非零"的 `special`，第一次写入的 1 在第二次就是旧值 | 保护不放宽。Property 3 改为：未 opt-in 时只允许这条 `PROTECTED`，opt-in 后结果与第一次相同；回归用例 `P3-2`。与 patch-engine 实现同一次提交 |

加入写入护栏后，已有的属性测试和回归用例有 15 条失败，都不是护栏或引擎的缺陷，而是测试里的写入落在了新规则上。护栏没有放宽，只调整了测试：

| 日期 | 不变量 | 触发样本 | 根因 | 修复提交 |
| :--- | :--- | :--- | :--- | :--- |
| 2026-11-09 | patch-engine Property 4（选择器）、Property 5（pin） | 生成样本：用来标记匹配结果的 `floorheight` 设为 0，扇区原天花板低于 0，报 `CEILING_BELOW_FLOOR`；Freedoom 夹具：标记写入 `Thing.x` 落在玩家出生点上，报 `PROTECTED` | 标记写入本身触发了 `sector-heights` 和 `thing-player-start` | Sector 的标记字段改为 `lightlevel`，补丁放行全部拦截钩子。与写入护栏同一次提交 |
| 2026-11-09 | patch-engine Property 8（事务性）的 special 注入 | Freedoom 夹具：opt-in `sector-special-nonzero` 后，补丁的其余操作写到玩家出生点，仍有 `PROTECTED` | 断言写成了“opt-in 后没有任何 `PROTECTED`” | 断言改为只看 `sector-special-nonzero` 这一条。同一次提交 |
| 2026-11-09 | 回归用例 P3-1、PE-3、PE-4 和 record-source 的 unchanged 用例 | 写入 `BLOOD1`、`CEIL1`、`door` 的固定样本里没有 Flat，报 `UNKNOWN_FLAT`；P3-1 把类型设为 -32768，报 `UNKNOWN_THING_TYPE` | 样本不带 Flat，也没有基础 IWAD | PE-3、PE-4 和 unchanged 用例改用带这些 Flat 的基础 IWAD；P3-1 去掉与选择器语义无关的 `type` 写入。同一次提交 |

## 自定义 Agent 和其他实验

| 内容 | 结果 | 是否保留 |
| :--- | :--- | :--- |
| | | |

## 额度消耗

| 阶段 | 消耗 | 备注 |
| :--- | ---: | :--- |
| | | |
