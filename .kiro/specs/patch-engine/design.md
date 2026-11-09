# Design Document

## Overview

`@necrohex/core` 中 WAD 无关的补丁引擎;`adapter-wad` 提供同步 Record_Source `wadAdapter` 和 `sector-special-nonzero` 钩子。依据 `docs/design.md` 第 6、10 节。

- 先在输入值上算好全部改动,有任一问题就不返回字节;干跑与应用共用流水线。
- core 不认识 WAD,不 import `adapter-wad`,只用 ES2023(无 `TextEncoder`、`crypto`、Node API)。
- 公开写入只接受 Patch 和 Receipt,定位为"作用域 + 记录 + 下标 + 字段";`ByteOverlay` 仍只在 `./internal`;`restoreField` 不公开(见"写回通道")。

## Architecture

新文件:core 的 `src/hash.ts`、`src/patch/{source,restorable,validate,select,operators,receipt,engine}.ts`;adapter-wad 的 `src/record-source.ts`、`src/restore-channel.ts`。调用方把 `wadAdapter` 传给引擎。

### 流水线(planPatch / applyPatch)

| 步骤 | 内容 | 失败时 |
| :--- | :--- | :--- |
| 1 | 结构校验,不打开 Record_Source | `INVALID_PATCH` |
| 2 | `adapter.open(input)`,按 `schema` 校验 | `INVALID_PATCH` |
| 3 | 校验 `options.receipts`,重复应用检测 | `INVALID_RECEIPT` / `ALREADY_APPLIED` |
| 4 | 在输入值上求值全部选择器 | `CONFLICT_MISSING` / `CONFLICT_AMBIGUOUS` |
| 5 | 计算新值,得到 `ProposedChange` 列表 | — |
| 6 | 同一字段或物理区间重叠 | `CONFLICT_FIELD` |
| 7 | `canRestore` | `VALUE_REJECTED`(`OLD_VALUE_NOT_RESTORABLE`) |
| 8 | 保护钩子 | `PROTECTED` / 警告 |
| 9 | 对未卷入 `CONFLICT_FIELD` 的条目依次 `writeField`,得到 `unchanged` | `VALUE_REJECTED` |
| 10 | 无问题且非干跑:`serialize()`、哈希、Receipt | — |

1 到 3 失败立即返回;4 到 9 收集全部问题。写入步骤 2 的副本,每个字段最多写一次。`changes` 只含写入成功的条目,`changedCount` 为其中 `unchanged === false` 的条目数。

### 撤销流程(revertPatch)

| 步骤 | 内容 | 失败时 |
| :--- | :--- | :--- |
| 1 | 按白名单校验 Receipt 结构 | `INVALID_RECEIPT` |
| 2 | `lookupRestorer(adapter)`;未登记则抛 `TypeError` | 抛出 |
| 3 | `bytesHash(input) === receipt.outputHash` | `RECEIPT_MISMATCH` |
| 4 | `openRestorable(input)`;逐条核对作用域 `id` 存在、`fieldSpan` 等于 `entry.span`、`readField` 等于 `entry.newValue` | `RECEIPT_MISMATCH`(逐条收集) |
| 5 | 3、4 全部通过后,按条目逆序 `restoreField(entry.oldValue)` | `RECEIPT_MISMATCH`(逐条收集) |
| 6 | `bytesHash(serialize()) === receipt.inputHash` | `RECEIPT_MISMATCH` |

有问题时不返回字节;`span` 只用于核对;不运行钩子。第 6 步守住 I-4,所以不单独检查 `name8` 尾部字节。

## Components and Interfaces

### Record_Source(`core/src/patch/source.ts`,经 `.` 导出)

```typescript
export type FieldValue = number | string;
export type FieldKind = "int" | "name" | "other";      // other: 不可选择、不可修改
export interface RecordSchema {
  readonly [record: string]: { readonly writable: boolean; readonly fields: Readonly<Record<string, FieldKind>> };
}
export interface RecordLocator { readonly scope: string; readonly record: string; readonly index: number } // scope 为作用域 id
export type WriteOutcome =
  | { ok: true; span: Span; unchanged: boolean } | { ok: false; reason: string; message: string };
export interface RecordReader {
  readonly schema: RecordSchema;
  scopes(): readonly { id: string; name: string }[];   // 目录顺序; name 可重复, id 唯一
  recordCount(scope: string, record: string): number;  // 缺该 Lump 时为 0
  readField(loc: RecordLocator, field: string): FieldValue;
  fieldSpan(loc: RecordLocator, field: string): Span;
}
export interface RecordSource extends RecordReader {
  canRestore(loc: RecordLocator, field: string): boolean;
  writeField(loc: RecordLocator, field: string, value: FieldValue): WriteOutcome;   // 完整校验
  serialize(): Uint8Array;
}
export interface ProtectionHook {
  readonly name: string; readonly severity: "block" | "warn";
  check(change: ProposedChange, reader: RecordReader): string | null; // 触发时返回说明
}
export interface RecordAdapter {
  readonly format: string; readonly hooks: readonly ProtectionHook[];
  open(input: Uint8Array): RecordSource;               // 必须复制输入
}
```

**`unchanged` 的定义**:新值编码后的字节与目标字段当前字节逐字节相同时为 `true`。整数等价于数值相等;`encodeName8` 不改大小写并补 NUL,所以 `"door"` 写到 `DOOR` 上为 `false`,写到 `door` 加全零尾部上为 `true`。钩子在写入前运行,`ProposedChange` 不含 `unchanged`。

### 写回通道(`core/src/patch/restorable.ts`,内部)

```typescript
export interface RestorableRecordSource extends RecordSource {
  restoreField(loc: RecordLocator, field: string, value: FieldValue): WriteOutcome; // 只做类型域检查
}
export type RestorableOpener = (input: Uint8Array) => RestorableRecordSource;
const restorers = new WeakMap<RecordAdapter, RestorableOpener>();         // 模块私有
export function registerRestorer(a: RecordAdapter, o: RestorableOpener): void; // 已登记则抛错
export function lookupRestorer(a: RecordAdapter): RestorableOpener | undefined; // 只由 engine.ts import
```

`internal.ts` 只再导出两个类型和 `registerRestorer`;`lookupRestorer` 不经任何入口。adapter-wad 一侧:

- `WadFile` 新增私有 `#writeEncoded`(可写记录、`fieldSpan`、`OUTSIDE_MAP_SCOPE`、`WRITE_OVERLAPS_STRUCTURE` 检查后写入)。`setField` 经 `encodeField`、私有 `#restoreField` 经未导出的 `encodeRestoreValue` 调用它;后者只检查类型域:`int16`/`uint16` 为范围内整数,`name8` 为长 0 到 8、码元 `0x01`–`0xFF` 的字符串,latin1 写入补 NUL。
- 静态初始化块把调用 `#restoreField` 的闭包交给 `restore-channel.ts` 的 `installRestore`(只接受一次);该模块导出 `restoreWadField`,不经任何入口。
- `record-source.ts` 的未导出 `openRestorable` 返回带 `restoreField` 的数据源,模块末尾 `registerRestorer(wadAdapter, openRestorable)`。

选这个机制的原因:

- 符号键可经 `Object.getOwnPropertySymbols` 取到;adapter-wad 的 `./internal` 子路径任何包都能导入。
- 登记表只能登记、不能取回,同一 adapter 只接受首次登记,`wadAdapter` 在模块求值完前不外泄。
- 唯一取回点 `revertPatch` 不把 `RestorableRecordSource` 交出。

### 引擎 API(`core/src/patch/engine.ts`,经 `.` 导出)

```typescript
export interface ApplyOptions { readonly allowReapply?: boolean; readonly receipts?: readonly unknown[] }
export function planPatch(input: Uint8Array, patch: unknown, adapter: RecordAdapter, options?: ApplyOptions): PlanResult;
export function applyPatch(input: Uint8Array, patch: unknown, adapter: RecordAdapter, options?: ApplyOptions): ApplyResult;
export function revertPatch(input: Uint8Array, receipt: unknown, adapter: RecordAdapter): RevertResult;
export function patchHash(patch: unknown): string;     // 先校验结构, 再规范化
export function bytesHash(bytes: Uint8Array): string;  // "sha256:<64 位小写十六进制>", 实现在 src/hash.ts
interface PlanResult { ok: boolean; issues: PatchIssue[]; warnings: PatchIssue[];
  matches: { operationId: string; count: number }[]; changes: PlannedChange[]; changedCount: number }
interface ApplyResult extends PlanResult { output?: Uint8Array; receipt?: Receipt }
interface RevertResult { ok: boolean; issues: PatchIssue[]; output?: Uint8Array }
```

### Wad_Record_Source(`adapter-wad/src/record-source.ts`)

- `open` 复制输入并 `WadFile.parse`;`scopes()` 只列 Doom 格式的 `MapScope`,`id` 在名称唯一时为名称,否则为 `<name>@<markerIndex>`。
- `schema` 由 `RECORD_LAYOUTS` 推导:单值 `int16`/`uint16` 为 `int`,`name8` 为 `name`,其余 `other`;`Sector`、`Thing` 可写。
- `writeField`、`restoreField` 先读出当前字节再写;编码错误为 `reason: "ENCODE"`,`WadRecordError` 为其 `code`;成功时比较字节得到 `unchanged`。
- `canRestore`:`name8` 第一个 NUL 后有非零字节时为 `false`,其余为 `true`。
- 钩子 `sector-special-nonzero`(`block`):`Sector.special` 且旧值非零。

## Data Models

### Patch(校验后)

```typescript
interface Patch {
  schemaVersion: 1; name: string; target: { format: string; maps: "*" | string[] };
  allowProtected?: string[];  // 已注册的钩子名
  operations: { id: string; select: Selector; change: Record<string, Change> }[];
}
type Selector =
  | { record: string; where: Record<string, Condition> }
  | { record: string; pin: { map: string; expectedIndex: number; fingerprint?: unknown } }
  | { record: string; all: true };
type Condition = Partial<Record<"eq" | "ne" | "lt" | "lte" | "gt" | "gte", FieldValue>> & { in?: FieldValue[] };
type Change = { set: FieldValue } | { scale: number; clamp?: [number, number] } | { clamp: [number, number] };
```

结构校验用白名单,未列出的键(如 `offset`、`bytes`)为 `INVALID_PATCH`,`path` 为 JSON Pointer;`target.format` 须等于 `adapter.format`。选择器路径:

| 情况 | `path` |
| :--- | :--- |
| `where`、`pin`、`all` 不是恰好一个 | `/operations/N/select` |
| `where` 为 `{}` | `/operations/N/select/where` |
| `where` 某字段条件为 `{}` | `/operations/N/select/where/<field>` |
| `all` 不是字面量 `true`(`false`、`"true"`、`1`、`null` 等) | `/operations/N/select/all` |

schema 校验:记录已声明,被改记录可写,字段 kind 为 `int` 或 `name`,大小比较和 `scale`/`clamp` 只用于 `int`,值类型与 kind 一致,`clamp` 要求 `min <= max`,`scale` 有限。

### 选择器与算子

- **作用域**:`"*"` 为全部;名称和 `pin.map` 不区分大小写,不存在为 `CONFLICT_MISSING`;`pin.map` 命中多个同名作用域为 `CONFLICT_AMBIGUOUS`;`pin` 下标越界为 `CONFLICT_MISSING`。
- **where**:`int` 数值比较;`name` 把 ASCII `a`–`z` 转大写后比较,只支持 `eq`、`ne`、`in`。全部条件为"与"。
- **all**:各作用域下标 `0` 到 `recordCount - 1`;缺该 Lump 时匹配 0 条。
- **新值**:`set` 为给定值;`scale` 为 `Math.floor(old * k)`,有 `clamp` 再限制;只有 `clamp` 为 `min(max(old, lo), hi)`。范围检查交给 `writeField`;等于旧值照常写入。
- **旧值可写回**:`canRestore` 为 `false` 时报 `VALUE_REJECTED`、`reason: "OLD_VALUE_NOT_RESTORABLE"`,带 `operationId`、`locator`、`field`,`message` 写明作用域、记录下标和字段名(如 `MAP01 Sector #12 floorpic`;字段名一律用 `wad.records.yaml` 中的名称);不写入该条目。
- 顺序:操作 → 作用域 → 下标 → `change` 字段。

### PlannedChange 与 Receipt

```typescript
type Selection = { kind: "WHERE" } | { kind: "ALL" }
  | { kind: "EXACT"; expectedIndex: number; fingerprintChecked: false };
interface ProposedChange {
  operationId: string; scope: string; record: string; index: number; field: string;
  oldValue: FieldValue; newValue: FieldValue; span: Span; selection: Selection;
}
interface PlannedChange extends ProposedChange { unchanged: boolean }
interface Receipt {
  receiptVersion: 1; patchName: string; patchHash: string; inputHash: string; outputHash: string;
  allowedProtections: string[];   // 本次实际放行的钩子
  entries: PlannedChange[];       // Receipt_Entry, 含 unchanged: true 的条目
}
```

Receipt 只含 JSON 原生类型;白名单校验要求哈希匹配 `^sha256:[0-9a-f]{64}$`、`unchanged` 为布尔值、`selection.kind` 合法。

### 哈希与重复应用

- `bytesHash` 为纯 TypeScript SHA-256。`patchHash` 对校验后的 Patch 取规范 JSON(键按 UTF-16 码元排序,无空白),手写 UTF-8 编码后哈希;`name`、`fingerprint` 计入。
- 某个 `options.receipts` 项的 `patchHash`、`outputHash` 分别等于 `patchHash(patch)`、`bytesHash(input)` 时为 `ALREADY_APPLIED`;`allowReapply: true` 跳过。

## Error Handling

```typescript
type PatchIssueCode = "INVALID_PATCH" | "INVALID_RECEIPT" | "VALUE_REJECTED" | "CONFLICT_FIELD"
  | "CONFLICT_MISSING" | "CONFLICT_AMBIGUOUS" | "PROTECTED" | "ALREADY_APPLIED" | "RECEIPT_MISMATCH";
interface PatchIssue {
  code: PatchIssueCode | "WARNING"; message: string; operationId?: string; operationIds?: string[];
  path?: string; locator?: RecordLocator; field?: string; hook?: string; reason?: string;
}
```

触发条件见两张流程表和数据模型。另:`allowProtected` 含未注册钩子为 `INVALID_PATCH`;`CONFLICT_FIELD` 带 `operationIds`;`restoreField` 拒绝时的 `RECEIPT_MISMATCH` 带 `locator`、`field`、`reason`,`message` 写明作用域、下标和字段名。有问题时无 `output`、`receipt`。

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

9.2、10.1、10.3、10.4、11.5、11.7 用例子或冒烟测试;11.4 是流程要求。B 为生成样本或 Freedoom 夹具,P 为生成补丁。

### Property 1: I-3 局部性

*For any* B 和 P,应用成功时输出与 B 等长,不同字节都在某条目的 `span` 内,`span` 等于其 `fieldSpan`,条目含 6.2 的全部字段。

**Validates: Requirements 11.1, 6.2**

### Property 2: I-4 可撤销

*For any* B 和 P,应用成功时 `revertPatch(output, JSON.parse(JSON.stringify(receipt)), wadAdapter)` 与 B 逐字节相同。

**Validates: Requirements 11.2, 7.1, 7.3, 6.3**

### Property 3: set 幂等

*For any* B 和只含 `set` 的 P(且没有操作的 `where` 读取另一个操作写入的字段),应用得到 O 后,以 `allowReapply` 再应用仍得 O;P 把某个 `Sector.special` 设为非零值且未 opt-in 时,再应用只允许因 `sector-special-nonzero` 报 `PROTECTED`,opt-in 后仍得 O。

两个前提来自属性测试找到的反例,见 `regression.test.ts` 的 P3-1、P3-2:选择器按当前输入求值,跨操作读取时第二次会选中新记录;第一次写入的非零 `special` 在第二次是"旧值非零"。

**Validates: Requirements 11.3, 8.2**

### Property 4: 选择器与参考模型一致

*For any* B、`target.maps` 和非空 where 或 `all: true`,匹配集合等于对 `readRecords` 逐条求值的参考实现;`all: true` 匹配数为各作用域 `recordCount` 之和,kind 为 `ALL`;名称条件改大小写不改变结果;前一操作的写入不影响后一操作;0 匹配不是问题。

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.9**

### Property 5: pin 只按下标

*For any* 作用域、`expectedIndex`、`fingerprint`:下标在范围内时恰好选中该记录,selection 为 `EXACT`、`fingerprintChecked: false`;越界或作用域不存在为 `CONFLICT_MISSING`;`dupMapWad` 上为 `CONFLICT_AMBIGUOUS`。换 `fingerprint` 不改变匹配,但改变 Patch_Hash。

**Validates: Requirements 2.6, 2.7, 2.8, 1.3**

### Property 6: 算子计算

*For any* 整数旧值、有限 k、`lo <= hi`,新值分别为 `v`、`clamp(floor(old*k))`、`min(max(old, lo), hi)`。

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 7: 校验先于读取

*For any* 合法补丁的单处变异(删必需键、重复 `id`、选择器不是恰好一种、空 `where` 或空字段条件、`all` 非 `true`、加 `offset`、未知字段、反向 `clamp`、名称用 `scale`),结果为 `INVALID_PATCH`,`operationId` 正确,`path` 符合路径表;结构类变异不打开 Record_Source。

**Validates: Requirements 1.1, 1.2, 1.4, 1.5, 3.4, 10.2, 11.8**

### Property 8: 事务性

*For any* B 和 P,B 不变;有问题(越界值、超长名称、同字段双写、未 opt-in 覆盖非零 `special`)时无字节和回执,问题含对应代码和 `id`;加 `allowProtected: ["sector-special-nonzero"]` 后 `PROTECTED` 消失。

**Validates: Requirements 3.5, 4.1, 4.2, 4.3, 9.1, 9.3**

### Property 9: 干跑等价

*For any* B 和 P,`planPatch` 与 `applyPatch` 的 `ok`、`issues`、`warnings`、`matches`、`changes`、`changedCount` 深相等,`planPatch` 不含字节。

**Validates: Requirements 5.1, 5.2**

### Property 10: 回执哈希与重复应用

*For any* 成功应用,三个哈希等于 `bytesHash(B)`、`bytesHash(output)`、`patchHash(P)`;重排键或改空白不改变 Patch_Hash;带回执对 output 再应用为 `ALREADY_APPLIED`。

**Validates: Requirements 6.1, 6.6, 8.1**

### Property 11: 回执不匹配

*For any* 成功应用,改 output 任一字节后撤销为 `RECEIPT_MISMATCH`;破坏 Receipt 结构后撤销或用作 `options.receipts` 为 `INVALID_RECEIPT`;均无字节。

**Validates: Requirements 7.2, 7.4**

### Property 12: unchanged 与 changedCount

*For any* B 和 P(约一半 `set` 取旧值),应用成功时条目 `span` 内字节有变化当且仅当 `unchanged === false`;`unchanged: true` 的条目仍在 Receipt 中;`changedCount` 为 `false` 条目数。

**Validates: Requirements 3.7, 5.2, 6.4, 6.5, 11.6**

### Property 13: 不可无损写回的旧名称被拒绝

*For any* B 和 `name8` 字段,第一个 NUL 后放非零字节再写该字段,结果含 `OLD_VALUE_NOT_RESTORABLE` 及正确的 `operationId`、`locator`、`field`,`message` 含作用域名、下标和字段名;`changes` 不含该字段。

**Validates: Requirements 3.6**

### Property 14: 写回通道只在核对通过后由撤销调用

*For any* 计数假 adapter 上的成功应用:应用和干跑中 `restoreField` 调用 0 次;改任一条 `newValue`、`span` 或 `outputHash` 后撤销,调用 0 次且为 `RECEIPT_MISMATCH`;某条 `restoreField` 失败时为 `RECEIPT_MISMATCH`,带该条 `locator`、`field`,无字节。

**Validates: Requirements 7.5, 7.7, 10.5**

### Property 15: 旧值写回只做类型域检查

*For any* 可写字段和类型域内的 v(整数全范围;名称长 0 到 8、码元 `0x01`–`0xFF`,含空串和非 ASCII),`restoreField` 成功且 `readField` 返回 v;越界整数、长度 9、含 `\0` 或码元大于 `0xFF` 的名称被拒绝;只读记录和作用域外 Lump 与 `writeField` 以相同 `reason` 被拒绝。

**Validates: Requirements 7.6**

### Property 16: SHA-256 与参考实现一致

*For any* 0 到 300 字节的数组(长度偏向 55、56、63、64、119、120、127、128),`bytesHash` 的十六进制部分等于 `node:crypto` 的结果。

**Validates: Requirements 6.6, 11.5**

## Testing Strategy

- **生成器**:复用 `mapWad`、`validValue`;新增 `patchFor`(where/pin/all、少量越界值、约一半 `set` 取旧值、随机 `allowProtected`)、`dupMapWad`、`name8` 尾部非零变体。每个属性至少 100 次。
- **位置**:纯逻辑在 `core/test`(内存假 source);WAD 属性在 `adapter-wad/test/patch-*.test.ts`,两类样本都跑。Property 15 按相对路径导入 `lookupRestorer`。
- **SHA-256 向量**(`core/test/vectors/sha256-nist.json`,JSON import):
  - FIPS 180-4 示例(NIST CSRC "Examples with Intermediate Values"):
    - 空串 → `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
    - `"abc"` → `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`
    - `"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"` → `248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1`
    - 1,000,000 个 `'a'`(测试中生成)→ `cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0`
  - CAVP `shabytetestvectors.zip`:`SHA256ShortMsg.rsp` 中 `Len` 为 0、8、440、448、504、512 的条目;`SHA256LongMsg.rsp` 前两条和最后一条。每条含 `source`、`msgHex`、`md`,从 `.rsp` 原样复制,注明来源 URL。
- **公开入口**:core `.` 无 `ByteOverlay`、`restoreField`、`registerRestorer`、`lookupRestorer`;`./internal` 无 `restoreField`、`lookupRestorer`;adapter-wad 无 `restoreField`、`installRestore`、`restoreWadField`、`openRestorable`;导出值及原型链(含符号键)、`open()` 返回值、`WadFile.prototype` 无 `restoreField`;`wadAdapter` 自有键恰为 `format`、`open`、`hooks`,无符号键;`exports` 恰为 `.`、`./node`。
- **例子与冒烟**:`warn` 钩子继续;未登记 adapter 撤销抛 `TypeError`;重复登记抛错;`all: true` 缺 Lump 匹配 0;core `tsconfig` 无 DOM、Node 类型。
- **标签**:`Feature: patch-engine, Property N: <标题>`;反例固定为 `regression.test.ts` 具名用例。

## Design Decisions

- 全选须写 `all: true`;空 `where` 多为失误,按"拒绝猜测"报 `INVALID_PATCH`。
- 新值等于旧值仍写入并记入 Receipt,以 `unchanged` 标出,另给 `changedCount`。
- 写回通道 = core 内部登记表 + adapter-wad 未导出模块。
- 撤销不检查 `name8` 尾部:真回执已过 `canRestore`,伪造回执由撤销步骤 3、4、6 拦下。
- `pin.fingerprint` 只保存,留给 relocation spec。
- SHA-256 自写,不加依赖,用 NIST 向量和 `node:crypto` 验证。
