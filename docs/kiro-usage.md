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
| wad-roundtrip（实现后补写） | 代码和测试先完成，之后补写 requirements、design、tasks，与先写 Spec 再实现的顺序相反。补写完成后，对七项差异逐项做决定，再按 tasks.md 的必需任务实现 | `.kiro/specs/wad-roundtrip/` 下的三份文档；按任务实现的修复和测试，回归用例集中在 `packages/adapter-wad/test/regression.test.ts` | 补写过程中靠阅读代码和内存中的临时脚本复现，发现了 `parse` 不复制输入且 `baseBuffer` 可被改写（D-5）、`setField` 可写入文件头（目录项 `filepos` 为 0 时，重新解析抛 `BAD_IDENT`，X-1）、`fieldSpan("constructor")` 返回 `NaN` 区间（F-3）、没有地图标记的裸 `SECTORS` 也能被 `setField` 写入（X-4），以及 Hexen 格式的 `THINGS` 被按 Doom 布局解释（X-3）。这些缺陷已修复，各有回归用例。CI 与 `REQUIRE_FREEDOOM`（D-8）已决定但延后，尚未实现 |

## Hooks

| Hook | 触发条件 | 动作 | 拦下过什么 |
| :--- | :--- | :--- | :--- |
| | | | |

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
| | | | | |

## 自定义 Agent 和其他实验

| 内容 | 结果 | 是否保留 |
| :--- | :--- | :--- |
| | | |

## 额度消耗

| 阶段 | 消耗 | 备注 |
| :--- | ---: | :--- |
| | | |
