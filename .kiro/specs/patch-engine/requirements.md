# Requirements Document

## Introduction

在 `packages/core` 实现 WAD 无关的补丁引擎,`adapter-wad` 基于 `WadFile` 提供记录访问。依据 `docs/design.md` 第 6、10 节。重定位留给 relocation spec,`special` 以外的默认保护留给 guardrails spec。

## Glossary

- **Patch_Engine**: `@necrohex/core` 导出的补丁引擎。
- **Record_Source**: core 定义的按作用域、记录、下标、字段读写的接口。
- **Wad_Record_Source**: `adapter-wad` 基于 `WadFile` 的同步 Record_Source。
- **Restore_Channel**: Record_Source 上供撤销流程写回旧值的内部方法 `restoreField`。
- **Patch**: `schemaVersion` 为 1 的补丁,含 `name`、`target`、`operations`。
- **Operation**: Patch 中的一项操作。
- **Where_Selector**: 按字段条件匹配记录的选择器。
- **Pin_Selector**: 以 `map` 和 `expectedIndex` 指向一个记录的选择器,可带 `fingerprint`。
- **All_Selector**: 写作 `"all": true`、选中作用域内全部记录的选择器。
- **Dry_Run**: 不返回字节的执行方式。
- **Receipt**: 应用成功后返回的回执,每个 Receipt_Entry 对应一个被写字段。
- **Unchanged_Flag**: 计划改动和 Receipt_Entry 上的布尔字段 `unchanged`,新值等于旧值时为 `true`。
- **SHA256_Impl**: core 内的纯 TypeScript SHA-256 实现。
- **Patch_Hash**: 规范化 Patch 的 SHA-256 哈希,不受键顺序和空白影响。
- **Output_Hash**: 完整字节序列的 SHA-256 哈希。
- **Protection_Hook**: 适配层注册的具名写入检查,分拦截和警告两类。
- **Test_Suite**: core 与 adapter-wad 的测试。
- **Generated_Sample**: fast-check 生成的 WAD。
- **Freedoom_Fixture**: `fixtures/freedoom/freedoom2-map01-02.wad`。
- **NIST_Vectors**: FIPS 180-4 示例与 NIST CAVP `SHA256ShortMsg`、`SHA256LongMsg` 中的 SHA-256 测试向量。

## Requirements

### Requirement 1: 补丁校验

**User Story:** As a 地图作者, I want 错误补丁先被拒绝, so that 不产生意外写入。

#### Acceptance Criteria

1. WHEN 收到 Patch, THE Patch_Engine SHALL 在读取记录前校验 `schemaVersion`、`operations` 非空、`id` 唯一、`select` 恰含 `where`、`pin`、`all` 三者之一、`change` 非空。
2. IF 结构校验失败、记录类型或字段名未在 Record_Source 中声明、`allowProtected` 含未注册钩子、或 Patch 含原始偏移或字节, THEN THE Patch_Engine SHALL 返回 `INVALID_PATCH` 并指出 Operation `id` 和路径。
3. THE Patch_Engine SHALL 保留 Pin_Selector 的 `fingerprint`,不用于匹配。
4. IF Where_Selector 不含任何条件, THEN THE Patch_Engine SHALL 返回 `INVALID_PATCH` 并指出 Operation `id` 和路径 `select.where`。
5. IF `select.all` 的值不是 `true`, THEN THE Patch_Engine SHALL 返回 `INVALID_PATCH` 并指出 Operation `id` 和路径 `select.all`。

### Requirement 2: 选择器

**User Story:** As a 地图作者, I want 批量或精确选中记录, so that 补丁描述改哪些对象。

#### Acceptance Criteria

1. THE Patch_Engine SHALL 支持 `eq`、`ne`、`lt`、`lte`、`gt`、`gte`、`in` 条件,多个条件按"与"组合。
2. WHEN `target.maps` 为 `"*"` 或名称列表, THE Patch_Engine SHALL 在全部或列出的作用域中匹配。
3. THE Patch_Engine SHALL 在写入前按输入值求值全部选择器。
4. WHEN 比较定长名称字段, THE Patch_Engine SHALL 按不区分大小写的 ASCII 比较。
5. WHEN Where_Selector 或 All_Selector 未匹配任何记录, THE Patch_Engine SHALL 报告该 Operation 匹配数为 0,不视为错误。
6. WHEN Pin_Selector 的 `map` 存在且 `expectedIndex` 小于记录数, THE Patch_Engine SHALL 选中该记录,记为 `EXACT` 且 `fingerprintChecked: false`。
7. IF Pin_Selector 的 `map` 或 `target.maps` 列出的名称不存在,或 `expectedIndex` 超出记录数, THEN THE Patch_Engine SHALL 返回 `CONFLICT_MISSING`。
8. IF Pin_Selector 的 `map` 命中多个同名作用域, THEN THE Patch_Engine SHALL 返回 `CONFLICT_AMBIGUOUS`,不猜测。
9. WHEN Operation 使用 All_Selector, THE Patch_Engine SHALL 选中 `target.maps` 各作用域内该记录类型的全部记录。

### Requirement 3: 算子

**User Story:** As a 地图作者, I want 用算子描述新值, so that 补丁表达意图而非字节。

#### Acceptance Criteria

1. WHEN 字段变更为 `set`, THE Patch_Engine SHALL 以给定值为新值。
2. WHEN 字段变更含 `scale`, THE Patch_Engine SHALL 按"旧值乘系数、`Math.floor`、再应用 `clamp`(若有)"计算新值。
3. WHEN 字段变更只含 `clamp: [min, max]`, THE Patch_Engine SHALL 把旧值限制在 `[min, max]` 内。
4. IF `clamp` 的 `min` 大于 `max`, 或 `scale`、`clamp` 用于非整数字段, THEN THE Patch_Engine SHALL 返回 `INVALID_PATCH`。
5. IF Record_Source 拒绝编码新值(超出类型范围或名称超长), THEN THE Patch_Engine SHALL 返回 `VALUE_REJECTED`,指出 Operation、记录和字段。
6. IF 目标 `name8` 字段在第一个 NUL 之后含非零字节, THEN THE Patch_Engine SHALL 返回 `VALUE_REJECTED`,`reason` 为 `OLD_VALUE_NOT_RESTORABLE`,并指出作用域、记录下标和字段名,且不写入该字段。
7. WHEN 计算出的新值等于旧值, THE Patch_Engine SHALL 照常写入该字段并生成计划改动。

### Requirement 4: 冲突与事务

**User Story:** As a 地图作者, I want 出错时整份不写, so that 没有半成品。

#### Acceptance Criteria

1. IF 两个 Operation 写同一记录的同一字段或物理区间重叠, THEN THE Patch_Engine SHALL 返回 `CONFLICT_FIELD` 并列出两个 `id`。
2. IF 存在任一错误、冲突或未 opt-in 的拦截, THEN THE Patch_Engine SHALL 返回全部问题且不返回输出字节。
3. THE Patch_Engine SHALL 不修改输入字节,输出为新字节序列。

### Requirement 5: 干跑

**User Story:** As a 玩家, I want 预览改动, so that 决定是否应用。

#### Acceptance Criteria

1. WHEN 以 Dry_Run 执行, THE Patch_Engine SHALL 返回与应用相同的计划改动、问题、警告和匹配数,不返回字节。
2. WHEN 以 Dry_Run 执行, THE Patch_Engine SHALL 在每个计划改动上给出 Unchanged_Flag,并返回 Unchanged_Flag 为 `false` 的计划改动数。

### Requirement 6: 回执

**User Story:** As a 地图作者, I want 每次应用都有回执, so that 改动可审查、可撤销。

#### Acceptance Criteria

1. WHEN 应用成功, THE Patch_Engine SHALL 返回含 Patch_Hash、输入和输出的 Output_Hash 及 Receipt_Entry 列表的 Receipt。
2. THE Patch_Engine SHALL 在每个 Receipt_Entry 中记录 Operation `id`、作用域、记录类型、下标、字段、新旧值、物理区间、选择结果和 Unchanged_Flag。
3. THE Patch_Engine SHALL 接受经 JSON 往返后的 Receipt 用于撤销和重复应用检测。
4. THE Patch_Engine SHALL 为新值等于旧值的写入生成 Receipt_Entry。
5. WHEN 应用成功, THE Patch_Engine SHALL 在结果中返回 Unchanged_Flag 为 `false` 的 Receipt_Entry 数。
6. THE Patch_Engine SHALL 用 SHA256_Impl 计算 Patch_Hash 和 Output_Hash,以小写十六进制表示。

### Requirement 7: 撤销

**User Story:** As a 玩家, I want 用回执撤销补丁, so that 得到原文件。

#### Acceptance Criteria

1. WHEN 撤销且 Receipt 与输入相符, THE Patch_Engine SHALL 经 Restore_Channel 把每个 Receipt_Entry 的旧值写回对应字段并返回新字节。
2. IF 输入的 Output_Hash 不等于 Receipt 的输出哈希、Receipt_Entry 的区间或新值与输入不符、或撤销结果哈希不等于输入哈希, THEN THE Patch_Engine SHALL 返回 `RECEIPT_MISMATCH` 且不返回输出字节。
3. THE Patch_Engine SHALL 只依据 Receipt 中的旧值撤销,不做反向计算。
4. IF 撤销或重复应用检测收到的 Receipt 结构不合法, THEN THE Patch_Engine SHALL 返回 `INVALID_RECEIPT` 且不返回输出字节。
5. THE Patch_Engine SHALL 仅在 Receipt 的输出哈希以及全部 Receipt_Entry 的区间和新值核对通过后调用 Restore_Channel。
6. THE Restore_Channel SHALL 执行与新值写入相同的只读、作用域、格式和结构重叠检查,对旧值只做类型域检查(整数范围、`name8` 长度和码点)。
7. IF Restore_Channel 拒绝写回某个旧值, THEN THE Patch_Engine SHALL 返回 `RECEIPT_MISMATCH`,指出作用域、记录下标和字段名,且不返回输出字节。

### Requirement 8: 重复应用

**User Story:** As a 玩家, I want 识别已应用的补丁, so that `scale` 不被叠加。

#### Acceptance Criteria

1. IF 调用方传入的某个 Receipt 的 Patch_Hash 与当前相同且输出哈希等于输入的 Output_Hash, THEN THE Patch_Engine SHALL 返回 `ALREADY_APPLIED`。
2. WHERE 调用方显式设置 `allowReapply`, THE Patch_Engine SHALL 跳过重复应用检测。

### Requirement 9: 保护钩子

**User Story:** As a 开发者, I want 默认保护和 opt-in, so that AI 代理受限。

#### Acceptance Criteria

1. WHEN 计划写入触发拦截类 Protection_Hook 且 Patch 未 opt-in, THE Patch_Engine SHALL 返回 `PROTECTED`,指出钩子名、Operation 和记录。
2. WHEN 计划写入触发警告类 Protection_Hook, THE Patch_Engine SHALL 报告警告并继续。
3. THE Wad_Record_Source SHALL 注册拦截类 Protection_Hook,拦截对 `special` 非零的 Sector 写入 `special`。

### Requirement 10: 分层与公开接口

**User Story:** As a 开发者, I want core 与 WAD 解耦, so that 依赖保持单向。

#### Acceptance Criteria

1. THE Patch_Engine SHALL 只经 Record_Source 读写记录,core 不依赖 DOM、Node 文件系统或 adapter-wad。
2. THE Patch_Engine SHALL 只接受 Patch 和 Receipt 作为写入描述。
3. THE `@necrohex/core` 公开入口 SHALL 保持不导出 `ByteOverlay`。
4. THE `@necrohex/core` 公开入口和 `@necrohex/adapter-wad` 公开入口 SHALL 保持不导出 Restore_Channel,也不导出任何可直接调用 `restoreField` 的函数或对象方法。
5. THE Patch_Engine SHALL 只在撤销流程中调用 Restore_Channel。

### Requirement 11: 属性测试

**User Story:** As a 开发者, I want 属性测试守住不变量, so that 补丁不越界、可撤销。

#### Acceptance Criteria

1. THE Test_Suite SHALL 在 Generated_Sample 和 Freedoom_Fixture 上验证 I-3:输出中与输入不同的字节都落在某个 Receipt_Entry 的区间内。
2. THE Test_Suite SHALL 在两类样本上验证 I-4:应用后按 Receipt 撤销,结果与输入逐字节相同。
3. THE Test_Suite SHALL 在两类样本上验证只含 `set` 的 Patch 以 `allowReapply` 应用两次与一次结果相同。
4. WHEN 属性测试发现反例, THE Test_Suite SHALL 把该反例保留为回归测试。
5. THE Test_Suite SHALL 用 NIST_Vectors 验证 SHA256_Impl,至少包括空串、`"abc"`、448 位两块消息 `"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"`、1,000,000 个 `'a'`,以及从 CAVP 短消息和长消息文件中选取的向量。
6. THE Test_Suite SHALL 在两类样本上验证:Unchanged_Flag 为 `true` 的 Receipt_Entry 区间内输出字节与输入相同,且实际改变条目数等于 Unchanged_Flag 为 `false` 的条目数。
7. THE Test_Suite SHALL 验证 `@necrohex/core` 和 `@necrohex/adapter-wad` 的公开入口不暴露 Restore_Channel。
8. THE Test_Suite SHALL 验证不含条件的 Where_Selector 和值不为 `true` 的 `select.all` 返回 `INVALID_PATCH`。
