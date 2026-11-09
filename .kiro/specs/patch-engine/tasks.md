# Implementation Plan: patch-engine

## Overview

先 core(哈希、接口、登记表、校验、选择、算子、回执、流水线),再 adapter-wad(写回通道、`wadAdapter`、生成器),最后跑属性测试并固定回归用例。细节以 `design.md` 为准,下文"§X"指 `design.md` 的 X 节。全部任务必需,没有可选任务。

## Tasks

- [x] 1. core:哈希
  - [x] 1.1 `packages/core/src/hash.ts`:纯 TS SHA-256、手写 UTF-8、规范 JSON、`bytesHash`
    - 按 §哈希与重复应用;不用 `TextEncoder`、`crypto`
    - _Requirements: 6.1, 6.6, 8.1, 10.1_
  - [x] 1.2 `packages/core/test/vectors/sha256-nist.json`、`packages/core/test/hash.test.ts`;`core/tsconfig.json` 加 `resolveJsonModule`
    - 向量按 §Testing Strategy:FIPS 180-4 的空串、`"abc"`、448 位示例;`SHA256ShortMsg.rsp` 中 `Len` 0、8、440、448、504、512;`SHA256LongMsg.rsp` 前两条和最后一条。`msgHex`、`md` 从下载的 `.rsp` 原样复制,不手算、不用本实现生成;下载失败时停下询问用户
    - 测试用 JSON import 读取;1,000,000 个 `'a'` 在测试中生成;另测 UTF-8(代理对、孤立代理项)和规范 JSON
    - _Requirements: 6.6, 11.5_
  - [x] 1.3 `packages/adapter-wad/test/sha256-differential.test.ts`
    - **Property 16: SHA-256 与参考实现一致**
    - **Validates: Requirements 6.6, 11.5**

- [x] 2. core:接口与写回登记表
  - [x] 2.1 `packages/core/src/patch/source.ts`:§Record_Source 的全部类型,加 `Selection`、`ProposedChange`、`PlannedChange`、`PatchIssue`
    - _Requirements: 3.7, 5.2, 6.2, 10.1, 10.2, 10.4_
  - [x] 2.2 `packages/core/src/patch/restorable.ts`;`packages/core/src/internal.ts` 只再导出两个类型和 `registerRestorer`
    - 按 §写回通道
    - _Requirements: 7.5, 10.4, 10.5_

- [x] 3. core:校验、选择、算子
  - [x] 3.1 `packages/core/src/patch/validate.ts`:结构校验与 schema 校验
    - 按 §Patch(校验后),含选择器路径表;空 `where` 和非 `true` 的 `all` 为 `INVALID_PATCH`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.4, 10.2_
  - [x] 3.2 `packages/core/src/patch/select.ts`:作用域、where、pin、all 求值
    - 按 §选择器与算子
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_
  - [x] 3.3 `packages/core/src/patch/operators.ts`:`set`、`scale`、`clamp`
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 3.4 `packages/core/test/fake-source.ts`:内存假 Record_Source 与计数 `RestorableOpener`
    - 可配置 schema、同名作用域、钩子、`canRestore` 为 `false` 的字段、被拒绝的值、`restoreField` 失败的定位器;`open` 计数
    - _Requirements: 7.5, 10.1, 10.5_
  - [x] 3.5 `packages/core/test/patch-operators.test.ts`
    - **Property 6: 算子计算**
    - **Validates: Requirements 3.1, 3.2, 3.3**

- [x] 4. core:回执与流水线
  - [x] 4.1 `packages/core/src/patch/receipt.ts`:生成与白名单校验
    - 按 §PlannedChange 与 Receipt
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.4_
  - [x] 4.2 `packages/core/src/patch/engine.ts`:`planPatch`、`applyPatch`、`revertPatch`、`patchHash`、`bytesHash`
    - 按 §流水线、§撤销流程、§Error Handling;`restoreField` 只在撤销步骤 3、4 全部通过后调用
    - _Requirements: 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 6.1, 6.5, 6.6, 7.1, 7.2, 7.3, 7.5, 7.7, 8.1, 8.2, 9.1, 9.2, 10.2, 10.5_
  - [x] 4.3 `packages/core/src/index.ts`:导出五个引擎函数和公开类型,不导出 `restorable.ts` 的内容
    - _Requirements: 10.2, 10.3, 10.4_
  - [x] 4.4 `packages/core/test/engine.test.ts`:例子测试
    - 钩子 `warn`/`block`/`allowProtected`、`OLD_VALUE_NOT_RESTORABLE` 的 `message`、`ALREADY_APPLIED`、`INVALID_RECEIPT`、`CONFLICT_FIELD`、各 `RECEIPT_MISMATCH` 分支、未登记 adapter 抛 `TypeError`、重复登记抛错、缺 Lump 时 `all` 匹配 0、`unchanged` 与 `changedCount`
    - _Requirements: 2.5, 2.9, 3.6, 3.7, 4.1, 5.2, 6.5, 7.2, 7.4, 8.1, 8.2, 9.1, 9.2_
  - [x] 4.5 `packages/core/test/patch-validate.test.ts`
    - **Property 7: 校验先于读取**
    - **Validates: Requirements 1.1, 1.2, 1.4, 1.5, 3.4, 10.2, 11.8**
  - [x] 4.6 `packages/core/test/patch-restore-channel.test.ts`
    - **Property 14: 写回通道只在核对通过后由撤销调用**
    - **Validates: Requirements 7.5, 7.7, 10.5**
  - [x] 4.7 修改 `packages/core/test/public-api.test.ts` 和 `packages/adapter-wad/test/core-exports.test.ts`
    - core 两个入口的导出名按 §Testing Strategy;扫描 `core/src` 无 `adapter-wad`、`node:`、`TextEncoder`、`crypto`,`lookupRestorer` 只在 `restorable.ts`、`engine.ts`
    - _Requirements: 10.1, 10.3, 10.4, 10.5, 11.7_

- [x] 5. Checkpoint - core
  - 运行 `pnpm --filter @necrohex/core typecheck`、`build`、`test`。Ensure all tests pass, ask the user if questions arise.

- [x] 6. adapter-wad:写回通道与 Wad_Record_Source
  - [x] 6.1 `packages/adapter-wad/src/restore-channel.ts`:`installRestore`、`restoreWadField`
    - 按 §写回通道;只 `import type` `WadFile`;不从 `index.ts` 导出
    - _Requirements: 7.6, 10.4_
  - [x] 6.2 `packages/adapter-wad/src/wad.ts`:`#writeEncoded`、`#restoreField`、`encodeRestoreValue`、静态初始化块
    - 按 §写回通道;`setField` 行为和错误码不变
    - _Requirements: 7.3, 7.6, 10.4_
  - [x] 6.3 `packages/adapter-wad/src/record-source.ts`:`wadAdapter`、`openRestorable`、登记;`src/index.ts` 只再导出 `wadAdapter`
    - 按 §Wad_Record_Source、§写回通道
    - _Requirements: 3.5, 3.6, 3.7, 6.4, 7.6, 9.3, 10.1, 10.4_
  - [x] 6.4 `packages/adapter-wad/test/record-source.test.ts`:单元测试
    - schema 推导、同名作用域 `id`、`canRestore`、钩子、`unchanged` 的 `door`/`DOOR` 例子、`reason` 转换
    - _Requirements: 3.6, 3.7, 9.3, 10.1_
  - [x] 6.5 `packages/adapter-wad/test/patch-entry.test.ts`:adapter-wad 公开入口
    - 按 §Testing Strategy 的公开入口条目
    - _Requirements: 10.4, 11.7_
  - [x] 6.6 `packages/adapter-wad/test/arbitraries.ts`:`patchFor`、只含 `set` 的变体、`dupMapWad`、`name8` 尾部非零变体
    - _Requirements: 2.8, 3.6, 3.7, 11.1, 11.2, 11.3, 11.6_

- [x] 7. adapter-wad:属性测试与回归(文件在 `packages/adapter-wad/test/`,生成样本和 Freedoom 夹具都跑)
  - [x] 7.1 `patch-locality.test.ts`
    - **Property 1: I-3 局部性**
    - **Validates: Requirements 11.1, 6.2**
  - [x] 7.2 `patch-revert.test.ts`
    - **Property 2: I-4 可撤销**
    - **Validates: Requirements 11.2, 7.1, 7.3, 6.3**
  - [x] 7.3 `patch-idempotent.test.ts`
    - **Property 3: set 幂等**
    - **Validates: Requirements 11.3, 8.2**
  - [x] 7.4 `patch-select.test.ts`
    - **Property 4: 选择器与参考模型一致**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.9**
  - [x] 7.5 `patch-pin.test.ts`
    - **Property 5: pin 只按下标**
    - **Validates: Requirements 2.6, 2.7, 2.8, 1.3**
  - [x] 7.6 `patch-validate.test.ts`(另加 schema 类变异)
    - **Property 7: 校验先于读取**
    - **Validates: Requirements 1.1, 1.2, 1.4, 1.5, 3.4, 10.2, 11.8**
  - [x] 7.7 `patch-selector-shape.test.ts`:Freedoom 夹具上 `where: {}`、空字段条件、`all` 为 `false`/`"true"`/`1`/`null` 的固定例子
    - _Requirements: 1.4, 1.5, 11.8_
  - [x] 7.8 `patch-transaction.test.ts`
    - **Property 8: 事务性**
    - **Validates: Requirements 3.5, 4.1, 4.2, 4.3, 9.1, 9.3**
  - [x] 7.9 `patch-dryrun.test.ts`
    - **Property 9: 干跑等价**
    - **Validates: Requirements 5.1, 5.2**
  - [x] 7.10 `patch-receipt-hash.test.ts`
    - **Property 10: 回执哈希与重复应用**
    - **Validates: Requirements 6.1, 6.6, 8.1**
  - [x] 7.11 `patch-receipt-mismatch.test.ts`
    - **Property 11: 回执不匹配**
    - **Validates: Requirements 7.2, 7.4**
  - [x] 7.12 `patch-unchanged.test.ts`
    - **Property 12: unchanged 与 changedCount**
    - **Validates: Requirements 3.7, 5.2, 6.4, 6.5, 11.6**
  - [x] 7.13 `patch-restorable-name.test.ts`
    - **Property 13: 不可无损写回的旧名称被拒绝**
    - **Validates: Requirements 3.6**
  - [x] 7.14 `patch-restore-domain.test.ts`:按相对路径导入 `lookupRestorer`,先断言 opener 不是 `undefined`
    - **Property 15: 旧值写回只做类型域检查**
    - **Validates: Requirements 7.6**
  - [x] 7.15 `regression.test.ts`:固定 1.3、7.1–7.14 的反例为具名用例
    - 另加:非零 `special` 为 `PROTECTED`;同名地图 pin 为 `CONFLICT_AMBIGUOUS`;`OLD_VALUE_NOT_RESTORABLE`;空串和非 ASCII 的历史 `name8` 经应用和撤销不变;越界整数写回被拒绝
    - _Requirements: 11.4, 2.8, 3.6, 7.6, 9.3_

- [x] 8. Checkpoint - core 与 adapter-wad
  - 对两个包运行 `typecheck`、`build`(含 `generate:check`)、`test`。Ensure all tests pass, ask the user if questions arise.

- [x] 9. 记录开发事件
  - [x] 9.1 仅当某条属性测试改变了开发方向时,在 `docs/kiro-usage.md` 记录属性编号、反例、改动和回归用例
    - _Requirements: 11.4_

## Notes

- core 的 `tsconfig` 不含 Node 类型,所以需要 `node:crypto`、`node:fs` 的测试(1.3、4.7 的一部分)放在 adapter-wad;它们在 5 中不运行,在 8 中运行。
- 7.14 依赖 vitest 把工作区符号链接解析到真实路径(默认行为),使相对路径导入和 `@necrohex/core/internal` 指向同一个 `restorable.ts` 模块实例。
- 同一文件的任务分在不同波次:`core-exports.test.ts` 只由 4.7 改,`regression.test.ts` 只由 7.15 改,`wad.ts` 只由 6.2 改,adapter-wad 的 `index.ts` 只由 6.3 改。
- 不手工编辑 `src/generated/records.ts`;夹具只用 Freedoom 或自制数据。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.3"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.1", "3.2", "3.5"] },
    { "id": 2, "tasks": ["3.4", "4.1"] },
    { "id": 3, "tasks": ["4.2"] },
    { "id": 4, "tasks": ["4.3"] },
    { "id": 5, "tasks": ["1.3", "4.4", "4.5", "4.6", "4.7"] },
    { "id": 6, "tasks": ["5"] },
    { "id": 7, "tasks": ["6.1"] },
    { "id": 8, "tasks": ["6.2"] },
    { "id": 9, "tasks": ["6.3"] },
    { "id": 10, "tasks": ["6.4", "6.5", "6.6"] },
    { "id": 11, "tasks": ["7.1", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10", "7.11", "7.12", "7.13", "7.14"] },
    { "id": 12, "tasks": ["7.15"] },
    { "id": 13, "tasks": ["8"] },
    { "id": 14, "tasks": ["9.1"] }
  ]
}
```
