# Requirements Document

> **这是实现后补写的 Spec。** `wad-roundtrip` 已经在 `packages/core` 和 `packages/adapter-wad` 中实现并有测试覆盖。本文依据现有代码(`packages/core/src/span.ts`、`packages/core/src/overlay.ts`、`packages/core/src/internal.ts`、`packages/adapter-wad/src/wad.ts`、`packages/adapter-wad/src/field-codec.ts`、`packages/adapter-wad/scripts/generate-records.ts`、`packages/adapter-wad/spec/wad.records.yaml`)、现有测试(`packages/core/test`、`packages/adapter-wad/test`)和 `docs/design.md` 第 9 节(WAD 处理)编写。
>
> **以下内容在实现完成后按实际代码同步。** 补写之后,用户对七项差异做出了决定,任务 10.1 到 10.4、11.1、11.2、13.11、13.15、13.17 已经实现:`parse` 复制输入并以 `original()` 取代 `baseBuffer`、`setField` 拒绝写入文件头/目录/其他 Lump 的区间、`ByteOverlay` 移出 `@necrohex/core` 的公开入口、识别地图格式并拒绝按 Doom 布局访问非 Doom 地图、不属于任何地图作用域的 Lump 可读不可写、`fieldSpan` 对继承名称抛 `RangeError`。这些行为写在 Requirement 12 到 16 和下面对 Requirement 3、4、6、7、8、10、11 的修改中,每一条验收条目都有已存在的测试。没有测试覆盖的行为不写成验收条目,统一写入"已知限制"。仍未解决或延后的事项保留在文末"已知差异"。

## Introduction

`wad-roundtrip` 是 NecroHex 的底层能力:把 IWAD/PWAD 字节序列解析为带物理区间的结构,在不做修改时原样输出,在做字段修改时只改动被写字段的字节。它由三部分组成:

- `@necrohex/core` 中的 `Span` 工具(公开入口)和 `ByteOverlay`(写入覆盖层,只经 `@necrohex/core/internal` 提供)。
- `@necrohex/adapter-wad` 中的 `WadFile`(容器解析、地图作用域、记录读取、字段写入)。
- 由 `spec/wad.records.yaml` 生成的记录层 `src/generated/records.ts`,以及生成脚本 `scripts/generate-records.ts`。

本文覆盖 `docs/design.md` 第 10 节中的不变量 I-1(无损往返)、I-2(结构对偶)和 I-3(局部性,仅限 `setField` 写入)。

## Glossary

- **WadFile**: `@necrohex/adapter-wad` 导出的类,通过 `WadFile.parse(bytes)` 创建,持有解析结果和一个私有的 `ByteOverlay`。`parse` 在入口复制输入。
- **WadParseError**: `WadFile.parse` 抛出的错误类型,带 `code` 属性,取值为 `TOO_SHORT`、`BAD_IDENT`、`BAD_DIRECTORY`。
- **WadRecordError**: 记录接口抛出的错误类型,表示"调用参数合法,但文件结构不允许这次记录操作"。带 `code` 属性,取值为 `UNSUPPORTED_MAP_FORMAT`、`OUTSIDE_MAP_SCOPE`、`WRITE_OVERLAPS_STRUCTURE`,以及 `lumpIndex` 属性(触发错误的 Lump 下标)。参数类错误仍是 `TypeError`/`RangeError`。
- **LumpEntry**: 一个目录项的解析结果,包含 `index`、`name`、`filepos`、`size`、`entrySpan`、`nameSpan`、`dataSpan`、`isMarker`、`issues`。
- **Marker_Lump**: `size` 为 0 的 Lump,`LumpEntry.isMarker` 为 `true`。
- **LumpIssueCode**: Lump 级问题代码,取值为 `NEGATIVE_FIELD`、`DATA_OUT_OF_BOUNDS`,记录在 `LumpEntry.issues` 中。
- **Span**: 半开字节区间 `[start, end)`。
- **Gap**: 不属于 12 字节头、目录表或任何 Lump 数据的字节区间,记录在 `WadFile.regions.gaps`。
- **MapScope**: 一张地图的作用域,包含标记 Lump 下标 `markerIndex`、数据 Lump 下标列表 `dataIndices`、名称到下标的映射 `lumps`,以及地图格式 `format`。
- **MapFormat**: `MapScope.format` 的取值:`doom`、`hexen`、`udmf`。作用域含 `TEXTMAP` 为 `udmf`,否则含 `BEHAVIOR` 为 `hexen`,其余为 `doom`。只识别,不解析 Hexen 或 UDMF 的记录。
- **MAP_DATA_LUMPS**: 常量数组,包含 10 个标准 Doom 地图数据 Lump 名称:`THINGS`、`LINEDEFS`、`SIDEDEFS`、`VERTEXES`、`SEGS`、`SSECTORS`、`NODES`、`SECTORS`、`REJECT`、`BLOCKMAP`。仍然只有这 10 个名称;Doom/Hexen 路径另接受模块内部的扩展成员 `BEHAVIOR`、`SCRIPTS`,UDMF 路径使用模块内部的成员列表(`TEXTMAP`、`ZNODES`、`REJECT`、`DIALOGUE`、`BEHAVIOR`、`SCRIPTS`、`BLOCKMAP`、`ENDMAP`),这两组常量不导出。
- **original()**: `WadFile.original()`,返回解析时输入的副本,不含任何 `setField` 写入。每次调用返回新数组。取代了已删除的 `baseBuffer`。
- **ByteOverlay**: `@necrohex/core` 的类,在基础缓冲之上记录写入,`materialize()` 时克隆基础缓冲并应用写入。基础缓冲是私有字段,只能通过 `baseCopy()` 取得副本。它只经 `@necrohex/core/internal` 提供,不在 `@necrohex/core` 的公开入口中。
- **Span_Utils**: `@necrohex/core` 公开入口导出的 `span`、`spanLength`、`spansOverlap`、`mergeSpans`、`complementSpans`、`spanWithin`。
- **Record_Generator**: `packages/adapter-wad/scripts/generate-records.ts`,从 `wad.records.yaml` 生成 `src/generated/records.ts`。
- **wad.records.yaml**: `packages/adapter-wad/spec/wad.records.yaml`,记录布局的唯一来源,当前定义 `Sector`、`Thing`、`Linedef`、`Sidedef`、`Vertex`。
- **Field_Codec**: `packages/adapter-wad/src/field-codec.ts`,负责校验并编码字段新值(`encodeField`、`encodeName8`),以及读取 `name8`(`decodeName8`)。
- **setField**: `WadFile.setField(lumpIndex, record, index, field, value)`,当前唯一的 `WadFile` 字节写入入口。
- **I-1**: 不变量"无损往返":不做修改时,`serialize(parse(B))` 与 `B` 逐字节相同。
- **I-2**: 不变量"结构对偶":`parse(serialize(A))` 与 `A` 的解析结果相等。
- **I-3**: 不变量"局部性":字节变化只出现在被写字段的区间内。本文中仅指 `setField` 写入,不含回执。
- **Freedoom_Fixture**: 提交到仓库的 `fixtures/freedoom/freedoom2-map01-02.wad`(PWAD 子集)。完整 IWAD `fixtures/cache/freedoom1.wad`、`freedoom2.wad` 被 git 忽略,仅在本地存在时参与测试。

## Requirements

### Requirement 1: 容器解析

**User Story:** As a 开发者, I want 解析 IWAD/PWAD 的头和目录, so that 后续能按物理区间定位每个 Lump。

#### Acceptance Criteria

1. WHEN 调用 `WadFile.parse` 且输入至少 12 字节并以 `IWAD` 或 `PWAD` 开头, THE WadFile SHALL 返回 `kind`、`numLumps`、`directoryOffset` 和按目录顺序排列的 `lumps`。
2. THE WadFile SHALL 把 `numLumps`、`directoryOffset`、每个目录项的 `filepos` 和 `size` 按小端 32 位有符号整数读取。
3. WHEN 解析目录项, THE WadFile SHALL 为每个 `LumpEntry` 设置 `entrySpan`(目录项 16 字节)和 `nameSpan`(目录项中的 8 字节名称)。
4. WHEN `numLumps` 为 0, THE WadFile SHALL 解析成功并返回空的 `lumps`,同时 `regions.directory` 为 `null`。
5. IF 输入长度小于 12 字节, THEN THE WadFile SHALL 抛出 `code` 为 `TOO_SHORT` 的 WadParseError。
6. IF 输入前 4 字节不是 `IWAD` 或 `PWAD`(区分大小写), THEN THE WadFile SHALL 抛出 `code` 为 `BAD_IDENT` 的 WadParseError。
7. IF `numLumps` 小于 0, THEN THE WadFile SHALL 抛出 `code` 为 `BAD_DIRECTORY` 的 WadParseError。
8. IF `numLumps` 大于 0 且 `directoryOffset` 小于 0 或 `directoryOffset + numLumps * 16` 超过输入长度, THEN THE WadFile SHALL 抛出 `code` 为 `BAD_DIRECTORY` 的 WadParseError。

### Requirement 2: 解析不拒绝历史数据

**User Story:** As a 开发者, I want 解析不拒绝非常规的历史数据, so that 无损往返对真实世界的文件成立。

#### Acceptance Criteria

1. THE WadFile SHALL 仅在 `TOO_SHORT`、`BAD_IDENT`、`BAD_DIRECTORY` 三种情形下由 `WadFile.parse` 抛出 WadParseError。
2. WHEN 目录项的 `filepos` 或 `size` 为负数, THE WadFile SHALL 在该 `LumpEntry.issues` 中记录 `NEGATIVE_FIELD`,将 `dataSpan` 置为 `null`,并继续解析。
3. WHEN 目录项的 `size` 大于 0、`filepos` 与 `size` 均不为负且 `filepos + size` 超过输入长度, THE WadFile SHALL 在该 `LumpEntry.issues` 中记录 `DATA_OUT_OF_BOUNDS`,将 `dataSpan` 置为 `null`,并继续解析。
4. WHEN 目录项的 `size` 大于 0、`filepos` 与 `size` 均不为负且数据完全位于输入内, THE WadFile SHALL 将 `dataSpan` 设为 `[filepos, filepos + size)` 且 `issues` 为空。
5. WHEN 多个 Lump 的数据区间互相重叠, THE WadFile SHALL 解析成功并保留各自的 `dataSpan`。
6. WHEN 读取记录, THE WadFile SHALL 返回字节中的原始取值,不对取值范围做校验。
7. WHEN 对任意字节输入调用 `WadFile.parse`, THE WadFile SHALL 抛出 WadParseError,或返回 `serialize()` 与输入逐字节相同的 WadFile。

### Requirement 3: 标记、原始名称与间隙保留

**User Story:** As a 开发者, I want 零字节标记 Lump、原始名称字节和间隙字节被原样保留, so that 未解析的内容在往返中不丢失。

#### Acceptance Criteria

1. WHEN 目录项的 `size` 为 0, THE WadFile SHALL 将该 `LumpEntry` 标为 `isMarker`,将 `dataSpan` 置为 `null`,且 `filepos` 为任意非负值时 `issues` 为空。
2. WHEN 解析目录项名称, THE WadFile SHALL 取到第一个 NUL 为止的字节并按 latin1 解码作为 `name`。
3. THE WadFile SHALL 通过 `nameSpan` 暴露目录项中完整的 8 个原始名称字节,包括第一个 NUL 之后的字节。
4. THE WadFile SHALL 计算 `regions`,其中 `header` 为 `[0, 12)`,`directory` 为目录表区间,`lumpData` 为全部 `dataSpan` 合并后的区间,`gaps` 为输入中不属于前三者的区间。
5. THE WadFile SHALL 使 `regions` 的 `header`、`directory`、`lumpData` 和 `gaps` 的并集等于 `[0, 输入长度)`,且 `gaps` 与其余三者不相交。
6. WHEN 调用 `serialize()`, THE WadFile SHALL 输出与 `original()` 相同的 Gap 字节和未解析 Lump 字节,除非这些字节被 `setField` 的写入区间覆盖。
7. WHEN 调用 `lumpBytes(lumpIndex)`, THE WadFile SHALL 返回该 Lump 当前的字节(含已写入的修改);若 `dataSpan` 为 `null`,返回长度为 0 的 `Uint8Array`。
8. WHEN 调用 `findLump(name, from)`, THE WadFile SHALL 从下标 `from` 起按大小写不敏感的名称比较返回第一个匹配的 `LumpEntry`,无匹配时返回 `undefined`。

### Requirement 4: 地图作用域

**User Story:** As a 补丁作者, I want 识别每张地图的标记 Lump 和数据 Lump, so that 后续能按地图限定作用域。

地图格式、`BEHAVIOR`/`SCRIPTS` 扩展成员和 UDMF 的识别规则见 Requirement 15。

#### Acceptance Criteria

1. WHEN 一个 Lump 的名称转为大写后匹配 `^(E[1-9]M[1-9]|MAP\d\d)$`,且其后连续的 Lump 中至少有一个名称属于 MAP_DATA_LUMPS, THE WadFile SHALL 在 `maps` 中加入一个 MapScope。
2. THE WadFile SHALL 将 MapScope 的 `name` 设为标记 Lump 的原始名称,`markerIndex` 设为标记 Lump 的下标,`dataIndices` 按目录顺序列出数据 Lump 的下标,`lumps` 以大写数据 Lump 名称为键映射到下标,`format` 设为地图格式。
3. WHEN 标记之后遇到名称不属于 MAP_DATA_LUMPS 且不属于扩展成员(`BEHAVIOR`、`SCRIPTS`)的 Lump, THE WadFile SHALL 结束当前 MapScope。
4. WHEN 标记之后遇到当前 MapScope 中已出现过的数据 Lump 名称, THE WadFile SHALL 结束当前 MapScope。
5. IF 名称匹配地图标记格式但其后没有任何 MAP_DATA_LUMPS 中的数据 Lump, THEN THE WadFile SHALL 不把该 Lump 加入 `maps`。
6. WHEN 目录中有多张地图, THE WadFile SHALL 按标记在目录中的顺序返回全部 MapScope,且同时支持 `ExMy` 和 `MAPxx` 两种命名。
7. WHEN 调用 `findMap(name)`, THE WadFile SHALL 按大小写不敏感的名称比较返回对应 MapScope,无匹配时返回 `undefined`。
8. WHEN 调用 `mapLump(map, lumpName)`, THE WadFile SHALL 按大小写不敏感的名称返回该地图内对应的 `LumpEntry`,无匹配时返回 `undefined`。

### Requirement 5: YAML 驱动的记录层生成

**User Story:** As a 开发者, I want 用 YAML 定义记录布局并生成读写代码, so that 布局只有一个来源且生成结果不会悄悄过期。

#### Acceptance Criteria

1. THE Record_Generator SHALL 从 `wad.records.yaml` 为每种记录生成 TypeScript `interface`、`<Record>Layout` 常量、`read<Record>` 函数和 `encode<Record>Field` 函数,并生成 `RecordTypes`、`RecordName`、`RECORD_LAYOUTS`、`RECORD_READERS` 和 `RECORD_BY_LUMP`。
2. THE Record_Generator SHALL 按字段在 YAML 中的声明顺序紧密排列字段偏移,`int16` 和 `uint16` 占 2 字节,`name8` 占 8 字节,`count` 为 N 时占 N 倍字节。
3. THE Record_Generator SHALL 生成按小端读取整数的 `read<Record>` 函数,并对 `count` 大于 1 的字段读出为数组。
4. IF `wad.records.yaml` 缺少顶层 `records`、记录名或字段名不是合法标识符、Lump 名称不匹配 `^[A-Z0-9_]{1,8}$`、`size` 不是正整数、记录没有字段、字段重名、字段类型未知、`count` 不是不小于 2 的整数, THEN THE Record_Generator SHALL 抛出消息以 `wad.records.yaml:` 开头的 Error。
5. IF 一条记录的字段总字节数不等于其 `size`, THEN THE Record_Generator SHALL 抛出消息以 `wad.records.yaml:` 开头的 Error。
6. WHEN 不带 `--check` 运行 Record_Generator, THE Record_Generator SHALL 创建必要的目录并写入 `src/generated/records.ts`。
7. WHERE 指定了 `--check`, THE Record_Generator SHALL 只比较生成结果与现有 `src/generated/records.ts`,不写任何文件。
8. WHERE 指定了 `--check`, WHEN 生成结果与现有文件不同或现有文件不存在, THE Record_Generator SHALL 向标准错误输出过期提示并以非零状态退出。
9. THE `@necrohex/adapter-wad` 的 `build` 脚本 SHALL 在运行 `tsc` 之前先运行 `generate:check`。
10. THE wad.records.yaml SHALL 定义 `Sector`(26 字节,`SECTORS`)、`Thing`(10 字节,`THINGS`)、`Linedef`(14 字节,`LINEDEFS`)、`Sidedef`(30 字节,`SIDEDEFS`)和 `Vertex`(4 字节,`VERTEXES`)。

### Requirement 6: 记录读取与字段区间

**User Story:** As a 开发者, I want 按记录类型读取 Lump 中的记录并定位字段的物理区间, so that 读取和写入都有明确的字节位置。

#### Acceptance Criteria

1. WHEN 调用 `recordCount(lumpIndex, record)`, THE WadFile SHALL 返回 `floor(Lump 大小 / 记录大小)`,不足一条记录的尾部字节不计入;`dataSpan` 为 `null` 时返回 0。
2. WHEN 调用 `readRecord` 或 `readRecords`, THE WadFile SHALL 读取包含已写入修改的当前字节并按生成的 `read<Record>` 解码。
3. WHEN 调用 `recordSpan` 或 `fieldSpan`, THE WadFile SHALL 在调用时由 Lump 的 `dataSpan`、记录大小和字段偏移计算并返回物理区间。
4. IF 传入的 Lump 名称(大写)与记录类型对应的 Lump 名称不同, THEN THE WadFile SHALL 抛出 `TypeError`。
5. IF 记录下标不是整数、为负数或超出 Lump 内完整记录的范围, THEN THE WadFile SHALL 抛出 `RangeError`。
6. IF `fieldSpan` 或 `setField` 收到的字段名不是该记录布局自有的字段(包括 `constructor`、`toString`、`__proto__` 等继承自 `Object.prototype` 的名称), THEN THE WadFile SHALL 抛出 `RangeError`,且不返回 `NaN` 区间。
7. IF 传入的 `lumpIndex` 在 `lumps` 中不存在, THEN THE WadFile SHALL 抛出 `RangeError`。

对属于非 Doom 格式地图的 Lump,六个记录接口的行为见 Requirement 15;对不属于任何地图作用域的 Lump,读取行为见 Requirement 16。

### Requirement 7: 字段写入校验

**User Story:** As a 补丁作者, I want 字段写入只校验新值且限定在 Sector 和 Thing, so that 历史数据能被读取而新写入的值保持合法。

#### Acceptance Criteria

1. WHEN 对 `Sector` 或 `Thing` 调用 `setField` 且新值通过校验并通过 Requirement 13、15、16 的结构检查, THE WadFile SHALL 把新值按小端编码写入该字段的 `fieldSpan`,并返回被写入的 Span。
2. WHEN `setField` 写入成功, THE WadFile SHALL 使后续 `readRecord` 返回新值,同时 `original()` 的内容保持不变。
3. THE WadFile SHALL 只改写目标字段的字节,同一记录中的其他字段和相邻记录的字节保持不变。
4. IF `setField` 的记录类型不是 `Sector` 或 `Thing`, THEN THE WadFile SHALL 抛出消息为 `<record> records are read-only` 的 Error,且不改变任何字节。
5. IF `int16` 或 `uint16` 字段的新值不是整数, THEN THE Field_Codec SHALL 抛出 `TypeError`。
6. IF `int16` 字段的新值不在 -32768 到 32767 之间,或 `uint16` 字段的新值不在 0 到 65535 之间, THEN THE Field_Codec SHALL 抛出 `RangeError`。
7. IF `name8` 字段的新值不是字符串, THEN THE Field_Codec SHALL 抛出 `TypeError`。
8. IF `name8` 字段的新值长度小于 1 或大于 8,或包含码点不在 0x21 到 0x7e 之间的字符, THEN THE Field_Codec SHALL 抛出 `RangeError`。
9. WHEN `name8` 字段的新值通过校验, THE Field_Codec SHALL 以 NUL 填充到 8 字节,且字段原有的 8 个字节被整体重写。
10. IF `setField` 因校验失败或结构拒绝(Requirement 13、15、16)而抛出异常, THEN THE WadFile SHALL 保持 `dirtySpans()` 和 `serialize()` 的结果与调用前相同。
11. THE WadFile SHALL 仅通过 `setField` 向 `ByteOverlay` 写入字节,且不在公共 API 中暴露接收原始偏移和字节的写入方法。

### Requirement 8: ByteOverlay 与 Span 工具

**User Story:** As a 开发者, I want 写入覆盖层保持基础缓冲不变, so that 序列化结果可以精确定位到被写入的字节。

`ByteOverlay` 只经 `@necrohex/core/internal` 提供(见 Requirement 14)。

#### Acceptance Criteria

1. WHEN 调用 `ByteOverlay.write(offset, bytes)` 且 `offset` 是非负整数并满足 `offset + bytes.length` 不超过基础缓冲长度, THE ByteOverlay SHALL 记录一份 `bytes` 的副本并返回 `[offset, offset + bytes.length)`。
2. IF `offset` 不是非负整数或 `offset + bytes.length` 超过基础缓冲长度, THEN THE ByteOverlay SHALL 抛出 `RangeError` 且不记录任何写入。
3. WHEN 调用 `ByteOverlay.read(offset, length)`, THE ByteOverlay SHALL 返回基础缓冲与全部已写入内容叠加后的字节,后写入的内容覆盖先写入的内容。
4. IF `read` 的区间超出基础缓冲或 `offset`、`length` 为负数, THEN THE ByteOverlay SHALL 抛出 `RangeError`。
5. WHEN 调用 `ByteOverlay.materialize()`, THE ByteOverlay SHALL 返回基础缓冲的克隆并应用全部写入,每次调用返回新的数组,且基础缓冲不被修改。
6. WHEN 调用 `ByteOverlay.dirtySpans()`, THE ByteOverlay SHALL 返回全部写入区间合并后按起点排序的 Span 列表。
7. WHEN 没有任何写入, THE ByteOverlay SHALL 使 `dirty` 为 `false`,`dirtySpans()` 返回空数组,`materialize()` 返回与基础缓冲内容相同的副本。
8. WHEN 调用 `mergeSpans`, THE Span_Utils SHALL 丢弃空区间,合并重叠或相邻的区间,并返回按起点排序的新数组。
9. WHEN 调用 `complementSpans(total, covered)`, THE Span_Utils SHALL 返回 `[0, total)` 中未被 `covered` 覆盖的区间,并把越界区间截断到 `[0, total)`。

### Requirement 9: 不变量 I-1 无损往返

**User Story:** As a 开发者, I want 不变量 I-1 成立, so that 不做修改时输出与输入逐字节相同。

#### Acceptance Criteria

1. WHEN 未调用 `setField` 就调用 `serialize()`, THE WadFile SHALL 返回与传给 `WadFile.parse` 时的输入逐字节相同的 `Uint8Array`。
2. THE WadFile SHALL 使 I-1 对生成样本、Freedoom_Fixture 以及本地存在的完整 Freedoom IWAD 成立。
3. WHEN 调用 `serialize()`, THE WadFile SHALL 返回一个新数组,调用方修改该数组不影响 `original()` 或后续的 `serialize()` 结果。
4. WHEN 输入中的 Lump 目录项被损坏但仍满足 Requirement 1 的容器条件, THE WadFile SHALL 使 `serialize()` 与输入逐字节相同。
5. WHEN 没有调用 `setField`, THE WadFile SHALL 使 `dirtySpans()` 返回空数组。

### Requirement 10: 不变量 I-2 结构对偶

**User Story:** As a 开发者, I want 不变量 I-2 成立, so that 写入后重新解析得到同样的结构。

被接受的写入不触碰头、目录或其他 Lump 的字节(Requirement 13),所以 I-2 不再需要"被写区间不得与头或目录相交"的额外前提;相交的写入被拒绝,且不留痕迹。

#### Acceptance Criteria

1. WHEN 对一个 WadFile A 调用被接受的 `setField` 若干次后将 `A.serialize()` 重新传给 `WadFile.parse`, THE WadFile SHALL 返回与 A 的 Lump 目录、地图作用域和区域划分相等的结果。
2. WHEN 对一个 WadFile A 调用被接受的 `setField` 若干次后将 `A.serialize()` 重新传给 `WadFile.parse`, THE WadFile SHALL 使重新解析得到的各记录与 A 通过 `readRecords` 读到的各记录相等。

### Requirement 11: 不变量 I-3 局部性

**User Story:** As a 开发者, I want 不变量 I-3 在 setField 写入下成立, so that 字节变化可以精确地限定在被写字段内。

#### Acceptance Criteria

1. WHEN 只通过 `setField` 写入后调用 `serialize()`, THE WadFile SHALL 返回与输入等长的数组。
2. WHEN 只通过 `setField` 写入后调用 `serialize()`, THE WadFile SHALL 使输出与输入不同的每个字节下标都落在某次被接受的 `setField` 返回的 Span 内。
3. WHEN 只通过 `setField` 写入后调用 `serialize()`, THE WadFile SHALL 使输出与输入不同的字节下标不落在 `regions.gaps` 中。
4. WHEN 只通过 `setField` 写入, THE WadFile SHALL 使 `dirtySpans()` 返回的区间所覆盖的字节集合,等于各次成功的 `setField` 返回的 Span 所覆盖的字节集合的并集(`dirtySpans()` 会合并相邻区间,例如 `[32,34)` 与 `[34,36)` 合并为 `[32,36)`,所以单个区间可以跨越多个返回的 Span)。
5. WHEN `setField` 被接受, THE WadFile SHALL 使返回的 Span 不与 `regions.header`、`regions.directory` 以及被写 Lump 以外的任一 Lump 的数据区间相交;被拒绝的调用不贡献 Span。

### Requirement 12: 缓冲所有权与 original()

**User Story:** As a 开发者, I want `WadFile` 不与调用方共享缓冲, so that I-1 不依赖调用方在解析之后不修改输入。

#### Acceptance Criteria

1. WHEN 调用 `WadFile.parse(bytes)`, THE WadFile SHALL 复制 `bytes`,使调用方此后对输入数组的修改不影响 `serialize()`、`original()` 和 `lumpBytes()`。验证:`regression.test.ts`("D-5")、`roundtrip.test.ts`(Property 1 目标段)。
2. WHEN 输入是 `Uint8Array` 的子类(例如 Node `Buffer`), THE WadFile SHALL 同样复制,使调用方此后对该 `Buffer` 的修改不影响 `serialize()`。验证:`regression.test.ts`("D-5" Buffer 用例)。
3. WHEN 调用 `original()`, THE WadFile SHALL 返回解析时输入的逐字节副本,且不含任何 `setField` 写入。验证:`records.test.ts`(写入用例中 `original()` 不变)、`roundtrip.test.ts`(局部性用例)。
4. WHEN 调用 `serialize()` 或 `original()`, THE WadFile SHALL 返回新数组,调用方修改返回值不影响之后的 `serialize()` 和 `original()`。验证:`regression.test.ts`("D-5")、`roundtrip.test.ts`。
5. THE WadFile SHALL 不再提供 `baseBuffer`,公共 API 不暴露指向内部缓冲的引用。验证:`regression.test.ts`("D-5" 中 `"baseBuffer" in wad` 为 `false`)。

### Requirement 13: 写入重叠拒绝

**User Story:** As a 玩家, I want 共享补丁套到不可信的 WAD 上时不会改写文件头、目录或别的 Lump, so that 结构损坏不会悄悄发生。

#### Acceptance Criteria

1. IF `setField` 的目标字段 Span 与 `regions.header`、`regions.directory` 或被写 Lump 以外任一 Lump 的非空 `dataSpan` 相交, THEN THE WadFile SHALL 抛出 `WadRecordError`,`code` 为 `WRITE_OVERLAPS_STRUCTURE`,且不写入。验证:`roundtrip.test.ts`(I-2 目标段)、`regression.test.ts`("X-1")、`freedoom.test.ts`(`filepos = 0` 的例子)。
2. WHEN `setField` 因写入重叠被拒绝, THE WadFile SHALL 使 `dirtySpans()` 与 `serialize()` 的结果与调用前相同。验证:同上。
3. THE WadFile SHALL 按半开区间判断相交,目标字段与头或目录首尾相接不算相交。验证:`roundtrip.test.ts`("边界"用例)。
4. THE WadFile SHALL 只比较目标字段 Span,而不是被写 Lump 的整个数据区间:与别的 Lump 重叠的 Lump 上,不落在重叠处的字段仍可写入。验证:`regression.test.ts`("X-1" 重叠 Lump 用例)。
5. WHEN 解析数据区间指向头、目录或其他 Lump 的文件, THE WadFile SHALL 解析成功且不为这些目录项新增 `issues`。验证:`regression.test.ts`("X-1")。
6. WHEN `setField` 同时存在参数类错误(新值越界、记录下标越界)与写入重叠, THE WadFile SHALL 先报告 `TypeError`/`RangeError`。验证:`regression.test.ts`("X-1" 参数类错误用例)。
7. WHEN 被接受的 `setField` 之后将 `serialize()` 重新传给 `parse`, THE WadFile SHALL 得到与写入后的 WadFile 相等的结构摘要和各记录(Requirement 10)。验证:`roundtrip.test.ts`(I-2 目标段)。

### Requirement 14: ByteOverlay 的内部子路径

**User Story:** As a 开发者, I want 接收裸偏移和字节的写入接口不出现在 core 的公开入口, so that 上层包不会无意中绕过 `setField` 的校验。

#### Acceptance Criteria

1. THE `@necrohex/core` 公开入口 SHALL 不导出 `ByteOverlay`。验证:`packages/core/test/public-api.test.ts`、`regression.test.ts`("D-6")。
2. THE `@necrohex/core` 公开入口 SHALL 继续导出 `span`、`spanLength`、`spansOverlap`、`mergeSpans`、`complementSpans`、`spanWithin`。验证:`packages/core/test/public-api.test.ts`。
3. THE `@necrohex/core` SHALL 通过子路径 `@necrohex/core/internal` 提供 `ByteOverlay`,`package.json` 的 `exports` 只有 `.` 和 `./internal` 两个键。验证:`packages/adapter-wad/test/core-exports.test.ts`、`regression.test.ts`("D-6")。
4. THE `@necrohex/adapter-wad` 的公开入口 SHALL 不导出 `ByteOverlay`。验证:`regression.test.ts`("D-6")。

### Requirement 15: 地图格式与 UNSUPPORTED_MAP_FORMAT

**User Story:** As a 补丁作者, I want 非 Doom 格式的地图被识别并拒绝按 Doom 布局访问, so that Hexen 的 20 字节 `Thing` 不会被当作 10 字节记录读写。

#### Acceptance Criteria

1. THE WadFile SHALL 为每个 MapScope 设置 `format`:作用域含 `TEXTMAP` 为 `udmf`,否则含 `BEHAVIOR` 为 `hexen`,其余为 `doom`。验证:`scope.test.ts`、`map-format.test.ts`。
2. WHEN 地图标记之后出现 `BEHAVIOR` 或 `SCRIPTS`, THE WadFile SHALL 把它们加入作用域;只含 `BEHAVIOR`/`SCRIPTS` 而没有 MAP_DATA_LUMPS 成员的候选标记不成图;只含 `SCRIPTS` 不含 `BEHAVIOR` 的地图仍是 `doom`。验证:`scope.test.ts`。
3. WHEN 一个 Lump 之后紧跟名称为 `TEXTMAP` 的 Lump, THE WadFile SHALL 把它识别为 UDMF 地图的标记(名称不受 `ExMy`/`MAPxx` 限制,不要求大小为 0),作用域从 `TEXTMAP` 起收集 `TEXTMAP`、`ZNODES`、`REJECT`、`DIALOGUE`、`BEHAVIOR`、`SCRIPTS`、`BLOCKMAP`、`ENDMAP`,在收集到 `ENDMAP`(含)、遇到其他名称或重复名称时结束。验证:`scope.test.ts`。
4. WHEN UDMF 作用域缺少 `ENDMAP`, THE WadFile SHALL 仍把它识别为 `udmf`,并在第一个非成员或重复名称处结束。验证:`scope.test.ts`。
5. WHEN 输入中不出现 `BEHAVIOR`、`SCRIPTS`、`TEXTMAP`, THE WadFile SHALL 使 `maps` 的 `name`、`markerIndex`、`dataIndices`、`lumps` 与引入格式识别之前的规则逐项相同,且 `format` 为 `doom`。验证:`freedoom.test.ts`(夹具与本地 IWAD 的 `legacyMaps` 比较)。
6. IF 调用 `recordCount`、`recordSpan`、`fieldSpan`、`readRecord`、`readRecords` 或 `setField` 时 `lumpIndex` 属于任一 `format` 为 `hexen` 或 `udmf` 的 MapScope 的 `dataIndices`, THEN THE WadFile SHALL 抛出 `WadRecordError`,`code` 为 `UNSUPPORTED_MAP_FORMAT`,不返回 0,也不降级为告警。验证:`map-format.test.ts`、`regression.test.ts`("X-3")、`freedoom.test.ts`(Hexen 变体)。
7. THE WadFile SHALL 在 Lump 下标存在、Lump 名称与记录类型相符之后才检查地图格式,所以名称与记录类型不符时仍抛 `TypeError`。验证:`map-format.test.ts`。
8. WHEN 一个 Lump 属于非 Doom 格式的地图, THE WadFile SHALL 使 `serialize()`、`original()`、`lumpBytes()`、`maps`、`regions`、`dirtySpans()` 照常工作,I-1 成立,被拒绝的 `setField` 不留痕迹。验证:`map-format.test.ts`、`regression.test.ts`("X-3")。
9. WHEN 一个 Lump 属于 `format` 为 `doom` 的地图, THE WadFile SHALL 使六个记录接口的行为与引入格式识别之前相同。验证:`map-format.test.ts`(doom 对照)、`freedoom.test.ts`、`records.test.ts`。

### Requirement 16: 不属于任何地图作用域的 Lump 可读不可写

**User Story:** As a 补丁作者, I want 写入只发生在已识别的 Doom 地图内, so that 记录大小和字段偏移有依据,不会按猜测写入。

#### Acceptance Criteria

1. WHEN 一个记录 Lump 不属于任何 MapScope 的 `dataIndices`, THE WadFile SHALL 使 `recordCount`、`recordSpan`、`fieldSpan`、`readRecord`、`readRecords` 仍按 Lump 名对应的 Doom 布局工作,行为与引入作用域检查之前相同,不抛 `WadRecordError`。验证:`regression.test.ts`("X-4")、`records.test.ts`(裸 Lump 的读取用例)、`map-format.test.ts`(UDMF 之后的 `THINGS`)。
2. IF `setField` 的目标 Lump 不属于任何 MapScope(没有地图标记的裸 Lump,或作用域被未识别 Lump 提前截断后落在作用域之外的数据 Lump), THEN THE WadFile SHALL 抛出 `WadRecordError`,`code` 为 `OUTSIDE_MAP_SCOPE`,且不写入。验证:`regression.test.ts`("X-4")、`map-format.test.ts`。
3. WHEN `setField` 因 `OUTSIDE_MAP_SCOPE` 被拒绝, THE WadFile SHALL 使 `dirtySpans()` 与 `serialize()` 的结果与调用前相同。验证:`regression.test.ts`("X-4")。
4. WHEN `setField` 同时存在参数类错误(新值非法、记录下标越界、Lump 名称与记录类型不符)与 `OUTSIDE_MAP_SCOPE`, THE WadFile SHALL 先报告 `TypeError`/`RangeError`。验证:`regression.test.ts`("X-4" 参数类错误用例)。
5. WHEN 同样的 `SECTORS` 字节位于 `MAP01` 的作用域内, THE WadFile SHALL 接受 `setField` 并使 `readRecord` 读到新值。验证:`regression.test.ts`("X-4" 对照)、`records.test.ts`(写入用例)。

## 已知限制

下列行为是已实现的设计选择,没有直接的测试覆盖,所以不写成验收条目。

- **约定级隔离(Requirement 14)。** `@necrohex/core/internal` 对任何依赖 `@necrohex/core` 的包在技术上都可解析,相对路径导入也不受 `exports` 约束。测试只能发现误用,不能阻止有意绕过。没有扫描 `cli`、`mcp-server`、`workbench` 源码是否出现 `@necrohex/core/internal`(这些包尚不存在,该扫描是任务 10.3 的可选子项,未执行)。
- **地图识别是名称启发式(Requirement 4、15)。** 不能保证识别所有来源的 WAD。作用域被成员列表之外的 Lump(例如某些源端口的 `GL_*`、`LEAFS`、`LIGHTMAP`)提前截断时,其后的数据 Lump 落在作用域之外,从"可读可写"变成"可读不可写"(`OUTSIDE_MAP_SCOPE`)。误判的方向是拒绝写入,而不是错误写入。
- **孤立记录 Lump 的读取仍按 Doom 布局(Requirement 16)。** 名为 `THINGS` 的孤立 Lump 若实际是 Hexen 的 20 字节记录,读取会得到错误的条数和内容。这是只读风险,不改变任何字节。
- **只识别,不解析。** Hexen 和 UDMF 的记录、`TEXTMAP` 文本都不解析。缺少 `ENDMAP` 的 UDMF 作用域不被拒绝,是否拒绝导出留给 `wad-export`。
- **同一 Lump 落入多个作用域的规则是防御性的。** 按现有扫描规则,每个数据 Lump 只跟随最近的标记,构造不出这种输入,所以"任一非 Doom 作用域则拒绝"这条规则没有测试。
- **检查顺序"作用域检查先于重叠检查"没有直接测试。** 实现按这个顺序,但只有可选任务 13.18(Property 14 的属性测试)会断言它;"X-1" 回归用例特意让 `SECTORS` 在作用域内,避免两个检查互相掩盖。
- **写入重叠检查是对 Lump 数线性扫描。** 每次 `setField` 为 O(Lump 数)。`original()` 每次调用是一次 O(n) 拷贝,不适合热路径。

## 范围外

以下内容不属于 `wad-roundtrip`,本文不对其提出要求:

- 完整 WAD/PWAD 的导出(含"PWAD 必须包含标记 Lump 和该地图全部数据 Lump"的规则),属于 `wad-export`。当前只有 `WadFile.serialize()`,它输出与输入同样布局的字节。
- 补丁格式、补丁应用和回执(receipt),属于 `semantic-patch`。因此 I-3 在本文中只针对 `setField`,不涉及"回执记录的区间"。
- 撤销(I-4)和重定位(I-5)。
- 几何修改、BSP 重建、贴图与音频解析、`COLORMAP` 编辑。
- `LINEDEFS` 和 `SIDEDEFS` 的写入。`Linedef`、`Sidedef`、`Vertex` 只提供读取。
- Hexen 和 UDMF 的记录解析。
- MCP、CLI 和工作台对这些能力的封装。
- CI 配置和 `REQUIRE_FREEDOOM`(决定 6,延后到 `wad-export` 完成之后)。

## 验证依据

| 要求 | 测试 |
| :--- | :--- |
| Requirement 1、2 | `packages/adapter-wad/test/roundtrip.test.ts`(异常数据)、`scope.test.ts`(空目录、零字节标记) |
| Requirement 3 | `scope.test.ts`(间隙、原始名称)、`roundtrip.test.ts`(区域铺满、原始名称可读) |
| Requirement 4 | `scope.test.ts`(地图作用域)、`freedoom.test.ts` |
| Requirement 5 | `records.test.ts`(`generated/records.ts` 与 YAML 同步、记录大小) |
| Requirement 6 | `records.test.ts`(读取、尾部余字节、Lump 名称与记录类型不符)、`regression.test.ts`("F-3") |
| Requirement 7 | `records.test.ts`(字段写入、越界与类型错误、只读记录类型)、`field-write-name8.test.ts`(`name8` 写入与非法名称)、`roundtrip.test.ts`(`Thing` 全部字段) |
| Requirement 8 | `packages/core/test/overlay.test.ts` |
| Requirement 9 | `roundtrip.test.ts`(I-1)、`freedoom.test.ts`(PWAD 子集与本地 IWAD) |
| Requirement 10 | `roundtrip.test.ts`(I-2 目标段、`Thing` 全部字段)、`field-write-name8.test.ts` |
| Requirement 11 | `roundtrip.test.ts`(局部性、`Thing` 全部字段)、`freedoom.test.ts`(I-3)、`field-write-name8.test.ts` |
| Requirement 12 | `roundtrip.test.ts`(Property 1 目标段)、`regression.test.ts`("D-5")、`records.test.ts` |
| Requirement 13 | `roundtrip.test.ts`(I-2 目标段、边界)、`regression.test.ts`("X-1")、`freedoom.test.ts` |
| Requirement 14 | `packages/core/test/public-api.test.ts`、`packages/adapter-wad/test/core-exports.test.ts`、`regression.test.ts`("D-6") |
| Requirement 15 | `scope.test.ts`、`map-format.test.ts`、`freedoom.test.ts`、`regression.test.ts`("X-3") |
| Requirement 16 | `regression.test.ts`("X-4")、`map-format.test.ts`、`records.test.ts` |

下列要求目前没有直接的测试,依据代码阅读得出:Requirement 1 的 `numLumps` 为 0 且 `directoryOffset` 任意的情形(`scope.test.ts` 的空目录用例由 `buildWad` 生成,`directoryOffset` 实际为 12,但该用例没有断言此值,只断言 `lumps` 为空且 `regions.directory` 为 `null`;`roundtrip.test.ts` 中 `directoryOffset` 为 0 的用例针对的是错误码,不是空目录成功解析)、Requirement 5 的 YAML 校验各分支和 `--check` 的退出状态、Requirement 8 的 `read` 越界与 `mergeSpans`/`complementSpans` 的截断行为。`Thing` 写入和 `fieldSpan` 未知字段名已分别由 `roundtrip.test.ts`(任务 13.15)和 `regression.test.ts`("F-3")覆盖,不再属于缺口。`Sector` 的 `floorheight`、`ceilingheight`、`tag` 字段没有属性测试,由同一代码路径保证;补测是可选任务 13.5。

## 已知差异

编号沿用同目录 `design.md` 的"已知差异与风险"。

### 已解决的差异

1. **D-5 `parse` 不复制输入缓冲,`baseBuffer` 没有只读保护。** 已修复(任务 10.1):`parse` 入口复制输入,`baseBuffer` 删除,改用 `original()`,`ByteOverlay` 的基础缓冲是私有字段。见 Requirement 12。
2. **X-1、X-2 `setField` 可写入头或目录,I-2 缺少前提。** 已修复(任务 10.2):相交的写入抛 `WRITE_OVERLAPS_STRUCTURE`。见 Requirement 13、10。
3. **D-6 `@necrohex/core` 导出裸偏移写入接口。** 已修复(任务 10.3),但只是约定级隔离:`ByteOverlay` 只经 `@necrohex/core/internal` 提供,子路径与相对路径导入仍可绕过。见 Requirement 14 和"已知限制"。
4. **D-9、X-3 `MAP_DATA_LUMPS` 只含 10 个标准 Lump,记录布局只按 Lump 名判断。** 已修复(任务 11.1、11.2):作用域含 `BEHAVIOR`、`SCRIPTS` 并识别 UDMF,`MapScope.format` 区分格式,非 Doom 地图的记录访问抛 `UNSUPPORTED_MAP_FORMAT`。见 Requirement 15。识别是名称启发式,见"已知限制"。
5. **X-4 `setField` 不要求 Lump 属于某个 MapScope。** 已修复(任务 10.4):不属于任何作用域的 Lump 可读不可写。见 Requirement 16。
6. **F-3 `fieldSpan` 对继承自 `Object.prototype` 的字段名返回 `NaN` 区间。** 已修复(任务 13.11):用自有属性判断。见 Requirement 6.6。
7. **F-1、F-2、F-4(本文曾有的措辞偏差)。** 已在任务 15.1 到 15.3 中更正;`baseBuffer` 的相关表述随任务 10.1 删除。

### 尚未解决的差异

1. **D-1 `PLAYPAL` 没有记录定义。** `docs/design.md` 第 9 节在记录布局表后写了 `PLAYPAL`(14 组 256 色 RGB,10752 字节),但 `wad.records.yaml` 和生成代码中没有 `PLAYPAL` 记录或常量,它只作为未解析 Lump 原样保留。已决定为后续可选,不属于本 Spec。
2. **D-2 记录和字段的物理区间不是在解析时记录的。** 设计文档写"每个 Lump、记录和字段都记录物理区间"。实际上只有 `LumpEntry` 的 `entrySpan`、`nameSpan`、`dataSpan` 在解析时存储;记录和字段的区间由 `recordSpan`/`fieldSpan` 按需计算(Requirement 6.3)。
3. **D-3 完整 WAD/PWAD 导出不在当前实现中。** 当前只有 `WadFile.serialize()`,属于 `wad-export`。
4. **D-4 I-3 只覆盖 `setField`。** 设计文档写的是"字节变化只出现在回执记录的区间内"。回执属于 `semantic-patch`,当前 I-3 以被接受的 `setField` 返回的 Span 为准。
5. **D-7 `scopeMaps` 不检查标记 Lump 的大小为 0。** 地图作用域只依据名称正则和后续数据 Lump 判断。一个名为 `MAP01` 且有数据的 Lump 只要后面紧跟数据 Lump 名称,也会被当作地图标记。UDMF 路径同样不要求标记大小为 0。
6. **D-8 整包 Freedoom IWAD 测试依赖被 git 忽略的 `fixtures/cache/`。** CI 中没有 cache 时,`freedoom.test.ts` 里针对 `freedoom1.wad`、`freedoom2.wad` 的用例会被 `it.skipIf` 跳过。已决定使用 GitHub Actions、固定版本 Freedoom 加 SHA-256、`REQUIRE_FREEDOOM=1`,延后到 `wad-export` 完成之后,目前仓库没有 CI 配置。
7. **D-10 属性测试覆盖的字段较窄(剩余部分)。** `Thing` 全部字段(任务 13.15)和 `Sector` 的 `name8` 字段(任务 13.17)已有属性测试。`Sector` 的 `floorheight`、`ceilingheight`、`tag` 没有属性测试(可选任务 13.5);没有断言 `dirtySpans()` 为空或并集相等(可选任务 13.1)。
