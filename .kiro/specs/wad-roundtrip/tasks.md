# Implementation Plan: wad-roundtrip

> **这是实现后补写的 Spec:** 第一部分中已实现并通过测试的任务按现状标记为已完成(`[x]`),第二部分中尚未实现的缺口任务保持未完成(`[ ]`)。本阶段(规划)不执行任何任务,也不修改任何代码。
>
> **本次更新(设计决定已落实为任务):** 用户已对七项差异做出决定(D-5、X-1、D-6、X-3/D-9、D-1、D-8,以及决定 7:X-4),决定内容写在同目录 `design.md`(标【目标】,尚未实现)。第二部分中对应的任务已从"先决定再实现"改写为具体的实现任务,不再保留备选项。`requirements.md` 的 F-1、F-2、F-4 三处修正已完成(任务 15.1、15.2、15.3)。
>
> **本次更新(决定 7 与文档同步):** (1) 决定 7(不属于任何地图作用域的记录 Lump 可读不可写)落实为必需任务 10.4,并相应调整 10.2、11.2、13.15、13.17 和 6.3 的现状说明;新增可选任务 13.18(Property 14 的属性测试)。(2) 15.12(按已实现的行为同步 `requirements.md` 与 `design.md` 的状态标记)改为必需任务,排在全部必需代码任务之后、15.13 之前;原 15.4 并入 15.12 后删除。(3) 原 14.2 已由 10.4 取代,删除。两处删除的说明见 Notes。

## Overview

- 第一部分按模块列出 `packages/core` 和 `packages/adapter-wad` 中已经存在的实现和测试。只有 `design.md` 确认已存在并通过测试(`pnpm --filter @necrohex/core test` 3 个用例,`pnpm --filter @necrohex/adapter-wad test` 36 个用例,`generate:check`,`pnpm -r typecheck`)的内容才标为完成。第一部分描述的是**现状**;已决定的变更不改写第一部分,只在被引用处标注"见 10.x、11.x"。
- 第二部分依据 `design.md` 的"已知差异与风险"(D-1 到 D-10、F-1 到 F-4、X-1 到 X-14)和"现状下的覆盖缺口",每个缺口一个任务。分为:已决定的必需修复(10、11,以及 13.11)与用户要求本轮完成的必需补测(13.15、13.17)、补测(13)、尚未决定的低优先级改进(14)、文档与流程(15,其中 15.12、15.13 为必需)。
- 已决定的任务以"决定:……(见 `design.md`)"开头,写清要做什么和验收条件。任务中的类名、方法名、错误码、子路径名、常量名沿用 `design.md` 的"设计阶段建议",**名称见 `design.md`,实施前可调整**;其中 `UNSUPPORTED_MAP_FORMAT` 与 `REQUIRE_FREEDOOM` 是用户决定指定的名称,不属于可调整之列。
- 仍标注"先决定再实现"的任务(14.1、14.3、14.4、14.8、14.9、14.10)用户尚未做决定,保留备选项;决定结果记录到 `docs/decisions.md` 之后才能开始实现。
- 决定 7(X-4,不属于任何 `MapScope` 的 Lump 可读不可写)属于第一批,任务 10.4;它取代了原先"作用域之外保持现状"的已知限制和原 14.2 的备选项。读取接口行为不变,只有 `setField` 抛 `OUTSIDE_MAP_SCOPE`。
- 决定 5(D-1,`PLAYPAL`)不属于本 Spec,任务 15.5 只改文档;决定 6(D-8,CI)延后到 `wad-export` 完成之后,任务 13.14 与 15.9 本次不执行。
- 生成文件 `packages/adapter-wad/src/generated/records.ts` 只能通过 `pnpm --filter @necrohex/adapter-wad generate` 重新生成,不手工编辑。
- D-3(PWAD 导出)和 D-4(回执层 I-3)的实现分别属于 `wad-export` 和 `semantic-patch`,本 Spec 只安排对应的文档标注任务(15.7、15.8)。

## Tasks

### 第一部分:已完成的实现任务

- [x] 1. core:Span 工具与 ByteOverlay
  - [x] 1.1 实现 Span 工具
    - 文件:`packages/core/src/span.ts`(`span`、`spanLength`、`spansOverlap`、`mergeSpans`、`complementSpans`、`spanWithin`),`packages/core/src/index.ts`
    - 测试:`packages/core/test/overlay.test.ts`("mergeSpans 与 complementSpans 互补",只有一个例子,不含越界截断,见 13.8)
    - _Requirements: 8.8, 8.9_

  - [x] 1.2 实现 ByteOverlay
    - 文件:`packages/core/src/overlay.ts`(`write`、`read`、`dirty`、`dirtySpans`、`materialize`)
    - 测试:`packages/core/test/overlay.test.ts`("materialize 只改变写入的区间,基础缓冲不变","越界写入被拒绝")
    - 现状:`ByteOverlay` 从 `@necrohex/core` 公开入口导出,`base` 是公开字段(已决定的变更见 10.1、10.3)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

- [x] 2. adapter-wad:WadFile 容器解析
  - [x] 2.1 实现头与目录解析及 WadParseError
    - 文件:`packages/adapter-wad/src/wad.ts`(`WadFile.parse`、`WadParseError`、`TOO_SHORT`、`BAD_IDENT`、`BAD_DIRECTORY`、`HEADER_SIZE`、`DIRECTORY_ENTRY_SIZE`)
    - 测试:`packages/adapter-wad/test/roundtrip.test.ts`("异常数据":"无法定位目录时给出带错误码的异常","任意字节要么抛 WadParseError,要么无损往返"),`scope.test.ts`("空目录的 WAD 可以解析")
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.7_

  - [x] 2.2 实现 LumpEntry 分类、原始名称与标记 Lump
    - 文件:`packages/adapter-wad/src/wad.ts`(`entrySpan`、`nameSpan`、`dataSpan`、`isMarker`、`issues`、`NEGATIVE_FIELD`、`DATA_OUT_OF_BOUNDS`)
    - 测试:`roundtrip.test.ts`("越界、负数和重叠的 Lump 被记录而不是拒绝","目录项中的 8 字节原始名称原样可读"),`scope.test.ts`("零字节 Lump 是标记,filepos 可以是任意值","名称到第一个 NUL 为止,NUL 之后的杂字节保留在原始名称里")
    - _Requirements: 1.3, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3_

  - [x] 2.3 实现 serialize、baseBuffer、dirtySpans、lumpBytes 与 findLump
    - 文件:`packages/adapter-wad/src/wad.ts`(私有 `#overlay`,`serialize()` 返回新数组)
    - 测试:`roundtrip.test.ts`("serialize 返回副本,不暴露基础缓冲"),`records.test.ts`("写入后读取到新值,字节只在字段区间变化,基础缓冲不变")
    - 现状:`parse` 不复制输入,`baseBuffer` getter 返回传入的同一引用(已决定的变更见 10.1)
    - _Requirements: 3.6, 3.7, 3.8, 9.1, 9.3, 9.5_

- [x] 3. adapter-wad:regions 与间隙
  - [x] 3.1 实现 computeRegions
    - 文件:`packages/adapter-wad/src/wad.ts`(`header`、`directory`、`lumpData`、`gaps`,使用 `mergeSpans` 和 `complementSpans`)
    - 测试:`roundtrip.test.ts`("头、目录、Lump 数据和间隙恰好铺满整个文件"),`scope.test.ts`("间隙字节被识别且不属于任何 Lump"),`freedoom.test.ts`("解析出两张完整地图和无关 Lump")
    - **Property 6: 区域铺满且 gaps 不相交**(已有 `wadBytes` 属性测试,缺口见 13.16)
    - **Validates: Requirements 3.4, 3.5**

- [x] 4. adapter-wad:地图作用域
  - [x] 4.1 实现 scopeMaps 与 MAP_DATA_LUMPS
    - 文件:`packages/adapter-wad/src/wad.ts`(`MAP_DATA_LUMPS`、`MapScope`、`scopeMaps`)
    - 测试:`scope.test.ts`("标记加其后的全部数据 Lump 构成一张地图","没有数据 Lump 跟随的同名 Lump 不是地图","重复的数据 Lump 名称结束当前地图的作用域","支持 ExMy 和 MAPxx 两种命名")
    - 只有例子测试,没有 Property 7 的属性测试(见 13.4)
    - 现状:`MapScope` 没有格式字段,作用域只含 10 个 `MAP_DATA_LUMPS`(已决定的变更见 11.1、11.2)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 4.2 实现 findMap 与 mapLump
    - 文件:`packages/adapter-wad/src/wad.ts`
    - 测试:`freedoom.test.ts`(夹具与 IWAD 中 `MAP01`、`MAP02` 的 Lump 集合等于 `MAP_DATA_LUMPS`)
    - _Requirements: 4.7, 4.8_

- [x] 5. adapter-wad:YAML 记录层生成
  - [x] 5.1 定义五种记录布局
    - 文件:`packages/adapter-wad/spec/wad.records.yaml`(`Sector` 26、`Thing` 10、`Linedef` 14、`Sidedef` 30、`Vertex` 4 字节)
    - 测试:`records.test.ts`("记录大小符合设计文档")
    - _Requirements: 5.10_

  - [x] 5.2 实现记录生成器与校验
    - 文件:`packages/adapter-wad/scripts/generate-records.ts`(`generateRecordsSource`,输出 `interface`、`<Record>Layout`、`read<Record>`、`encode<Record>Field`、`RecordTypes`、`RecordName`、`RECORD_LAYOUTS`、`RECORD_READERS`、`RECORD_BY_LUMP`),`packages/adapter-wad/src/generated/records.ts`(生成物)
    - 测试:`records.test.ts`("generated/records.ts 与 YAML 同步","读取 Sector 的全部字段","读取 Linedef 的数组字段和无符号字段")
    - YAML 校验的各错误分支没有测试(见 13.13)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 5.3 实现 `--check` 比较与 build 脚本串联
    - 文件:`packages/adapter-wad/scripts/generate-records.ts`(`--check`),`packages/adapter-wad/package.json`(`generate`、`generate:check`,`build` 先运行 `generate:check`)
    - 验证:`generate:check` 在成功路径上通过;过期时的非零退出状态没有测试(见 13.13)
    - _Requirements: 5.6, 5.7, 5.8, 5.9_

- [x] 6. adapter-wad:字段编码与 setField
  - [x] 6.1 实现 Field_Codec
    - 文件:`packages/adapter-wad/src/field-codec.ts`(`FieldLayout`、`RecordLayout`、`decodeName8`、`encodeName8`、`encodeField`、`fieldByteLength`)
    - 测试:`records.test.ts`("新值越界或类型错误时抛出,且不留下痕迹","解析不校验:越界取值也能读出")
    - _Requirements: 2.6, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [x] 6.2 实现记录读取与字段区间
    - 文件:`packages/adapter-wad/src/wad.ts`(`recordCount`、`recordSpan`、`fieldSpan`、`readRecord`、`readRecords`)
    - 测试:`records.test.ts`("尾部不足一条记录的字节不计入记录","Lump 名称与记录类型不符时拒绝读取")
    - `fieldSpan` 对未知字段名没有测试(见 13.11)
    - 现状:记录访问只按 Lump 名判断,不检查地图格式(已决定的变更见 11.2)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7_

  - [x] 6.3 实现 setField(仅 Sector 与 Thing)
    - 文件:`packages/adapter-wad/src/wad.ts`(`WRITABLE_RECORDS`,先校验、后 `ByteOverlay.write`,返回被写 `Span`)
    - 测试:`records.test.ts`("写入后读取到新值,字节只在字段区间变化,基础缓冲不变","只读记录类型拒绝写入")
    - `Thing` 写入没有测试(见 13.10)
    - 现状:不检查目标区间是否与头、目录或其他 Lump 重叠(已决定的变更见 10.2)
    - 现状:不要求被写 Lump 属于任何 `MapScope`,没有地图标记的裸 `SECTORS` 也可写(X-4;已决定的变更见 10.4,决定 7)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.10, 7.11_

- [x] 7. adapter-wad:buildWad 与夹具
  - [x] 7.1 实现 buildWad
    - 文件:`packages/adapter-wad/src/build.ts`(`buildWad`、`LumpInput`,支持原始名称字节、`gapBefore`、`markerFilepos`、`gapBeforeDirectory`、`trailing`),`packages/adapter-wad/src/index.ts`
    - 测试:`scope.test.ts`、`records.test.ts` 及各属性测试通过它构造输入
    - _Requirements: 3.3, 3.4_

  - [x] 7.2 实现 Freedoom 夹具裁剪脚本并提交夹具
    - 文件:`packages/adapter-wad/scripts/make-freedoom-fixture.ts`(现状:通过 `wad.baseBuffer` 切片,见 10.1),`packages/adapter-wad/fixtures/freedoom/freedoom2-map01-02.wad`,`packages/adapter-wad/fixtures/freedoom/COPYING.txt`,`packages/adapter-wad/fixtures/README.md`,`.gitignore`(排除 `fixtures/cache/`)
    - 测试:`freedoom.test.ts`
    - _Requirements: 9.2_

  - [x] 7.3 实现属性测试的生成器与比较工具
    - 文件:`packages/adapter-wad/test/arbitraries.ts`(导出 `lumpInput`、`wadBytes`、`mapWad`;文件内部的 `sectorBytes` 未导出),`packages/adapter-wad/test/helpers.ts`(`summarize`、`changedIndices`、`insideAny`、`equalBytes`)
    - _Requirements: 9.2, 10.1, 11.2_

- [x] 8. adapter-wad:I-1/I-2/I-3 属性测试
  - [x] 8.1 I-1 无损往返属性测试
    - 文件:`packages/adapter-wad/test/roundtrip.test.ts`("不做修改时,serialize(parse(B)) 与 B 逐字节相同",300 次;"损坏目录项的合法容器仍无损往返,问题记入 issues",300 次)
    - 属性中没有断言 `dirtySpans()` 为空,损坏目录用例没有断言 `issues`(见 13.1、13.16);目标行为下的前提扩展见 10.1
    - **Property 1: I-1 无损往返**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 3.6**

  - [x] 8.2 I-2 结构对偶属性测试
    - 文件:`packages/adapter-wad/test/roundtrip.test.ts`("parse(serialize(A)) 等于 A,包含写入之后",200 次,只写 `Sector.lightlevel`)
    - 字段覆盖窄(见 13.15、13.17);生成器不产生数据区间指向头或目录的 WAD(见 10.2)
    - **Property 2: I-2 结构对偶**
    - **Validates: Requirements 10.1, 10.2**

  - [x] 8.3 I-3 局部性属性测试
    - 文件:`packages/adapter-wad/test/roundtrip.test.ts`("写入只改变被写字段的区间,其余字节包括间隙都不变",200 次,写 `Sector.lightlevel` 和 `Sector.special`)
    - 没有断言 `dirtySpans()`,`Thing` 写入没有覆盖(见 13.1、13.10、13.15)
    - **Property 3: I-3 局部性**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 7.2, 7.3, 3.6**

  - [x] 8.4 parse 全函数的现有属性测试
    - 文件:`packages/adapter-wad/test/roundtrip.test.ts`("任意字节要么抛 WadParseError,要么无损往返",500 次)
    - 只断言异常类型,没有断言 `code`(见 13.2)
    - **Property 4: parse 对任意字节全函数,错误码由头部决定**(部分覆盖)
    - **Validates: Requirements 1.5, 1.6, 1.7, 1.8, 2.1, 2.7**

- [x] 9. adapter-wad:Freedoom 夹具测试
  - [x] 9.1 提交的 PWAD 子集夹具测试
    - 文件:`packages/adapter-wad/test/freedoom.test.ts`("I-1 逐字节往返","解析出两张完整地图和无关 Lump","MAP01 的记录可读且彼此一致","I-3 改一个扇区字段,字节只在该字段区间变化")
    - _Requirements: 9.2, 11.2, 4.1, 6.2_

  - [x] 9.2 本地完整 Freedoom IWAD 测试
    - 文件:`packages/adapter-wad/test/freedoom.test.ts`(`describe.each(cached)` 加 `it.skipIf`,读取被 git 忽略的 `fixtures/cache/freedoom1.wad` 和 `freedoom2.wad`)
    - 本机 cache 存在时 I-1 与作用域用例运行并通过;缺文件时被跳过,没有整包 I-2、I-3(见 13.14、15.9,二者已决定延后到 `wad-export` 之后)
    - _Requirements: 9.2, 4.1_

### 第二部分:未完成的任务

> 每个会修改 `.ts` 的任务,验收中都包含"检查":运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`,全部通过。只改文档的任务不要求。

#### 高优先级:第一批(已决定的必需修复)

- [x] 10. 修复破坏 I-1 与 binary-safety 的缺口
  - [x] 10.1 `parse` 复制输入,删除 `baseBuffer`,新增 `original()`(D-5)
    - 决定:`WadFile.parse` 在入口执行 `bytes.slice()`,之后与调用方的数组再无关联;删除 `baseBuffer` getter;新增 `original()` 返回解析时输入的副本,每次调用返回新数组(`serialize()` 同样每次返回新数组);`ByteOverlay.base` 改为私有 `#base`,新增 `baseCopy()` 供 `original()` 使用。复制发生在 `parse` 入口而不是 `ByteOverlay` 构造函数。不提供"转让所有权"或跳过复制的选项。(见 `design.md` 的"缓冲所有权"一节;名称见 `design.md`,实施前可调整)
    - 修改 `packages/adapter-wad/src/wad.ts`、`packages/core/src/overlay.ts`
    - 同步调整读取 `baseBuffer` 的调用点:`packages/adapter-wad/test/roundtrip.test.ts`(局部性用例的 `equalBytes(wad.baseBuffer, b)`)、`packages/adapter-wad/test/records.test.ts`("基础缓冲不变"用例,完整名称见 10.4)改用 `wad.original()`(该用例随后还会被 10.4 改为作用域内的辅助函数,10.1 只负责把 `baseBuffer` 换成 `original()`);`packages/adapter-wad/scripts/make-freedoom-fixture.ts` 在循环外调用一次 `wad.original()` 再切片,避免每个 Lump 做一次整包拷贝
    - 新建 `packages/adapter-wad/test/regression.test.ts`,加入命名回归用例"D-5":`parse` 之后修改输入数组的一个字节,`serialize()` 与 `original()` 仍等于原输入;修改 `serialize()`、`original()` 返回值的字节不影响之后的 `serialize()`
    - 在 `packages/adapter-wad/test/roundtrip.test.ts` 为 Property 1 增加目标段属性:对 `parse` 之后输入数组、`serialize()`、`original()`、`lumpBytes()` 返回值的任意修改序列,`serialize()` 与 `original()` 仍等于 `parse` 之前输入的拷贝,`dirtySpans()` 为空;原有"serialize 返回副本"用例保留并扩展为覆盖 `original()`
    - 验收:上述回归用例和属性通过;`WadFile` 与 `ByteOverlay` 的公开面上不再有可写的内部缓冲引用;原有 36 个 adapter-wad 用例和 3 个 core 用例(调整读取点之后)继续通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:D-5、F-1;关联规则:binary-safety "无改动时序列化与输入逐字节相同"
    - **Property 1: I-1 无损往返**
    - **Validates: Requirements 9.1, 9.3, 9.5, 3.6**(Requirement 3.6、7.2、9.3 中 `baseBuffer` 的措辞在 15.12 同步)

  - [x] 10.2 `setField` 拒绝写入头、目录或其他 Lump 的区间(X-1、X-2)
    - 决定:`setField` 的目标字段区间 T(`fieldSpan` 的结果)与 `regions.header`、`regions.directory`,或自己以外任一 Lump 的非空 `dataSpan` 相交时,抛 `WadRecordError`,`code` 为 `WRITE_OVERLAPS_STRUCTURE`(带 `lumpIndex`),不写入;相交沿用半开区间规则 `spansOverlap`,首尾相接不算相交;只比较目标字段区间,不比较被写 Lump 的整个 `dataSpan`。解析仍然不拒绝,`LumpEntry.issues` 不新增代码。检查放在 `encode<Record>Field` 之后、`ByteOverlay.write` 之前,所以参数类错误和新值错误先于结构拒绝报告。`WadRecordError` 在本任务创建并导出,错误码联合同时包含 `UNSUPPORTED_MAP_FORMAT`(供 11.2 使用)。(见 `design.md` 的"写入重叠检查"一节;类名和 `WRITE_OVERLAPS_STRUCTURE` 为设计阶段建议,名称见 `design.md`,实施前可调整)
    - 修改 `packages/adapter-wad/src/wad.ts`
    - **作用域约束(决定 7,见 10.4):** 本任务的所有新增 WAD 都必须让 `SECTORS` 处于地图作用域内,否则 10.4 实施后会先触发 `OUTSIDE_MAP_SCOPE`,掩盖 `WRITE_OVERLAPS_STRUCTURE`。10.2 按顺序先于 10.4 执行,此时作用域检查尚不存在,也仍须按"在作用域内"构造,这样 10.4 之后这些用例不用改。做法:只改写目录项的 `filepos`,不改名称、不改 Lump 顺序,标记 Lump 与 10 个数据 Lump 的相对位置保持 `mapWad` 的原样
    - 在 `packages/adapter-wad/test/arbitraries.ts` 为 Property 2 增加"数据区间指向头、目录或其他 Lump"的生成器变体:在 `mapWad` 之上改写 `SECTORS` 目录项的 `filepos`,使数据指向文件头(0 或 1 到 8)、指向目录(`directoryOffset` 附近)、与另一个 Lump 重叠,另有一个未改写的对照;变体保持 `SECTORS` 在地图作用域内(见上)
    - 在 `packages/adapter-wad/test/roundtrip.test.ts` 把 Property 2 改为目标段(被写 Lump 在 Doom 地图作用域内由生成器保证,作用域之外的写入不属于本属性,由 10.4 的 "X-4" 与 13.18 覆盖):每次 `setField` 被接受当且仅当测试内独立编写的参考实现判定不相交;被接受的写入完成后 `WadFile.parse(A.serialize())` 的摘要与 A 相等且各记录相等;被拒绝的写入抛 `WadRecordError` 且 `dirtySpans()` 与 `serialize()` 不变。同步 Property 3:被拒绝的调用不贡献 `Span`,被接受的 `Span` 不与头、目录、自己以外的 Lump 相交
    - 在 `packages/adapter-wad/test/regression.test.ts` 加入命名回归用例"X-1":用 `buildWad` 构造 `MAP01` 空标记后跟 `SECTORS` 的 WAD(`SECTORS` 在地图作用域内,不得使用裸 `SECTORS`),再把 `SECTORS` 目录项改写为 `filepos = 0`;`parse` 成功,`setField(…, "floorheight", 0x4441)` 抛 `WadRecordError`(`code` 为 `WRITE_OVERLAPS_STRUCTURE`),`dirtySpans()` 为空,`serialize()` 等于输入,`WadFile.parse(w.serialize())` 成功(不再抛 `BAD_IDENT`)
    - 边界例子:字段区间与头首尾相接(`T.start === 12`)被接受;与目录首尾相接被接受
    - 在 `packages/adapter-wad/test/freedoom.test.ts` 为 Freedoom 夹具加一个例子:把 `MAP01` 的 `SECTORS` 的目录项 `filepos` 改为 0(名称与顺序不变,`SECTORS` 仍在 `MAP01` 的作用域内),`setField` 被拒绝
    - 验收:上述用例和属性通过;被拒绝时不留痕迹(Requirement 7.10);Freedoom 夹具与本地 IWAD 的现有用例不受影响;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-1、X-2;关联规则:binary-safety "补丁只改回执中的字节区间"
    - **Property 2: I-2 结构对偶**、**Property 3: I-3 局部性**
    - **Validates: Requirements 10.1, 10.2, 7.10, 11.2**("写入重叠被拒绝"尚无对应需求条目,在 15.12 新增)

  - [x] 10.3 `ByteOverlay` 移出 `@necrohex/core` 公开入口(D-6)
    - 决定:`packages/core/package.json` 的 `exports` 增加 `"./internal": "./src/internal.ts"`;新增 `packages/core/src/internal.ts`(`export * from "./overlay.ts"`);`packages/core/src/index.ts` 只导出 `span.ts`。`packages/adapter-wad/src/wad.ts` 的导入拆成两条:Span 工具来自 `@necrohex/core`,`ByteOverlay` 来自 `@necrohex/core/internal`。这是**约定级隔离**,不是技术隔离:子路径对任何依赖 `@necrohex/core` 的包都可解析,相对路径导入也不受 `exports` 约束;测试只能发现误用,不能阻止有意绕过。(见 `design.md` 的"core 的公开入口与内部子路径"一节;子路径名为设计阶段建议,名称见 `design.md`,实施前可调整)
    - 修改 `packages/core/package.json`、`packages/core/src/index.ts`,新增 `packages/core/src/internal.ts`,修改 `packages/adapter-wad/src/wad.ts` 的导入;`packages/core/test/overlay.test.ts` 的 `ByteOverlay` 改从 `../src/internal.ts` 导入,Span 用例仍从 `../src/index.ts` 导入
    - 新增 `packages/core/test/public-api.test.ts`:用 `import * as pub from "../src/index.ts"` 断言 `"ByteOverlay" in pub` 为 `false`,并断言 `span`、`mergeSpans`、`complementSpans`、`spansOverlap`、`spanLength`、`spanWithin` 仍被导出
    - 新增 `packages/adapter-wad/test/core-exports.test.ts`(该包的 tsconfig 带 Node 类型):读取 `packages/core/package.json`,断言 `exports` 只有 `"."` 和 `"./internal"` 两个键。可选子项:同一文件扫描 `packages/cli/src`、`packages/mcp-server/src`、`packages/workbench/src`(目录不存在则跳过),断言源码文本不含 `@necrohex/core/internal`;这只是文本扫描,不是安全边界
    - 在 `packages/adapter-wad/test/regression.test.ts` 加入命名回归用例"D-6":公开入口不导出 `ByteOverlay`(可与 `public-api.test.ts` 的断言互相引用,不重复实现)
    - 验收:公开入口不导出 `ByteOverlay` 的测试通过;`WadFile` 仍以私有 `#overlay` 持有覆盖层;`@necrohex/core/internal` 在 `moduleResolution: Bundler` 下能被 `adapter-wad` 解析;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:D-6;关联规则:binary-safety "MCP 工具与公共 API 不接受裸偏移和字节写入"
    - 顺序:10.3 排在 10.4 之后(二者都改 `wad.ts`,10.3 只改它的导入,必须串行,不得同一波次)。10.3 也可与 10.4 互换,互换时要同步修改依赖图
    - _Requirements: 7.11, 8.1_(公开入口范围在 15.12 同步)

  - [x] 10.4 `setField` 拒绝不属于任何地图作用域的 Lump(X-4,决定 7)
    - 决定:不属于任何 `MapScope` 的记录 Lump(例如没有地图标记的 `SECTORS`、`THINGS`,或作用域被未识别 Lump 提前截断后落在作用域之外的数据 Lump)仍可按 Doom 布局**读取**,但 `setField` 必须抛 `WadRecordError`,`code` 为 `OUTSIDE_MAP_SCOPE`,不写入、不留痕迹。读写不对称的理由:读取没有副作用,写入必须能证明目标属于一张已识别的 Doom 地图。(见 `design.md` 的"不属于任何地图作用域的 Lump:可读不可写"与"`setField` 的检查顺序"两节;错误码名称为设计阶段建议,**名称见 `design.md`,实施前可调整**)
    - 修改 `packages/adapter-wad/src/wad.ts`:
      - `WadRecordErrorCode` 增加 `OUTSIDE_MAP_SCOPE`(`WadRecordError` 类与联合由 10.2 创建,本任务只增加错误码,`lumpIndex` 字段沿用)
      - 在 `setField` 内按 `design.md` 的检查顺序加入作用域检查:位于 `encode<Record>Field` 新值编码之后、写入重叠检查(`WRITE_OVERLAPS_STRUCTURE`)之前。因此参数类错误(记录类型只读、Lump 下标、Lump 名称、记录下标、字段名、新值)先于 `OUTSIDE_MAP_SCOPE`,`OUTSIDE_MAP_SCOPE` 先于 `WRITE_OVERLAPS_STRUCTURE`;不得把作用域检查移到新值编码之前
      - 读取接口(`recordCount`、`recordSpan`、`fieldSpan`、`readRecord`、`readRecords`)行为不变,不得加入作用域检查
      - 同一 Lump 落入多个作用域(病态输入)的规则按 `design.md`:落入任一非 Doom 作用域则拒绝(`UNSUPPORTED_MAP_FORMAT`,由 11.2 实现,优先于 `OUTSIDE_MAP_SCOPE`);至少落入一个 Doom 作用域且没有非 Doom 作用域才允许写入;不属于任何作用域才是 `OUTSIDE_MAP_SCOPE`。按现有扫描规则可能无法构造出同一 Lump 落入多个 `dataIndices` 的输入;若无法构造,就在代码注释中说明这条规则是防御性的,不为它编造测试
      - 第一批阶段(本任务)的规则是"Lump 至少属于一个 `MapScope`",此时 `MapScope.format` 尚不存在。决定 4 实施(11.2)后,规则自然收紧为"至少属于一个 Doom 作用域",这由 11.2 在 `fieldSpan` 内的格式检查保证,**本任务的作用域检查代码在 11.2 中无需修改**
    - 在 `packages/adapter-wad/test/regression.test.ts` 加入命名回归用例"X-4"(一条命名测试,不要扩展成属性测试;属性形式见可选任务 13.18):
      - 场景一:用 `buildWad` 构造含 `SECTORS`(1 到 3 条完整记录)和 `THINGS`(1 到 3 条完整记录)但不含任何地图标记的 WAD
      - 场景二:同一条测试内的第二个 WAD,作用域被未识别 Lump 提前截断:`MAP01`(空标记)、`THINGS`、`LINEDEFS`、一个名称不在成员列表也不是标记名的 Lump(例如 `XUNKNOWN`)、`SECTORS`;`SECTORS` 落在作用域之外
      - 对两个场景断言:读取接口照常工作(`recordCount` 等于 `floor(Lump 大小 / 记录大小)`,`readRecords(lump, "Sector")` 返回按 Doom 布局解码的结果,场景一的 `readRecords(lump, "Thing")` 同理);`setField` 抛 `WadRecordError` 且 `code === "OUTSIDE_MAP_SCOPE"`;`dirtySpans()` 为空;`serialize()` 等于输入
      - 对照:同样的 `SECTORS` 字节放进 `MAP01` 的作用域(`MAP01` 空标记加 `SECTORS`)后,`setField` 成功并返回 `Span`,`readRecord` 读到新值
    - **受影响的现有测试,必须在本任务内一并修改:**
      - `packages/adapter-wad/test/records.test.ts` 的 `字段写入` › "写入后读取到新值，字节只在字段区间变化，基础缓冲不变":原用例用只含裸 `SECTORS` 的 `sectorWad()` 构造 WAD,10.4 之后 `setField` 会抛 `OUTSIDE_MAP_SCOPE`。改为使用一个把 `SECTORS` 放进 `MAP01` 作用域的辅助函数(例如 `MAP01` 空标记加 `SECTORS`,函数名由实施者定,如 `mappedSectorWad()`),`SECTORS` 的 Lump 下标随之变为 1;用例不得依赖固定下标 0,下标从辅助函数的返回值、`findLump` 或 `mapLump` 取得。用例里与改动前 WAD 的比较(`sectorWad().wad.readRecord(...)` 一类)也改用同一个辅助函数。该用例同时受 10.1 影响:10.1 先于本任务执行,它此时已改用 `wad.original()`,本任务不得改回 `baseBuffer`
      - 建议同改(同一任务内做):`records.test.ts` 的 `字段写入` › "新值越界或类型错误时抛出，且不留下痕迹":它基于裸 `SECTORS`,按检查顺序其断言仍然通过(越界值、过长或含 NUL 的 `floorpic`、越界下标都在作用域检查之前抛出原来的 `RangeError`/`TypeError`),但改用作用域内的辅助函数后,断言不再依赖检查顺序,也防止以后有人把作用域检查提前时用例静默地"为错误的原因通过"
    - **明确不要改的现有测试**(它们是"读取不变"的回归保护,保留裸 `SECTORS`、`LINEDEFS` 等 Lump,不要加作用域):`records.test.ts` 的 "只读记录类型拒绝写入"(`VERTEXES` 在第 1 步就抛出,早于作用域检查)、"读取 Sector 的全部字段"、"读取 Linedef 的数组字段和无符号字段"、"尾部不足一条记录的字节不计入记录"、"Lump 名称与记录类型不符时拒绝读取"、"解析不校验：越界取值也能读出"。`roundtrip.test.ts` 的 I-2 与局部性用例、`freedoom.test.ts` 的 I-3 用例、`scope.test.ts` 本来就在作用域内或不调用记录接口,不需要修改,验收时应保持原样通过
    - 验收:"X-4" 回归用例通过;修改后的 `records.test.ts` 写入用例通过且不依赖固定下标 0;上面列出的"不要改"的用例保持原样并通过;读取接口行为与改动前相同;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 顺序:紧随 10.2 之后、10.3 之前(10.4 与 10.3 都改 `wad.ts`,必须串行,不得同一波次);实施 10.4 时第一批阶段尚无 `MapScope.format`
    - 关联风险:X-4;关联规则:binary-safety "补丁只改回执中的字节区间"、product "Refuse to guess"
    - **Property 14: 不属于任何地图作用域的 Lump 可读不可写**(本任务以命名回归用例覆盖其例子形式,属性形式见可选任务 13.18)、**Property 2: I-2 结构对偶**与 **Property 3: I-3 局部性**(二者的量化域是"被写 Lump 在 Doom 地图作用域内")
    - **Validates: Requirements 6.1, 6.2, 7.1, 7.10**("不在地图作用域内的 Lump 不可写"尚无对应需求条目,在 15.12 新增)

- [x] 11. 地图格式判定(第三批,已决定;范围仅限格式判定)
  - [x] 11.1 `MapScope.format` 与作用域扩展(X-3 的判定部分、D-9)
    - 决定:`MapScope` 增加 `format: "doom" | "hexen" | "udmf"`;作用域加入 `BEHAVIOR`、`SCRIPTS`;识别 UDMF(`TEXTMAP` 开头,成员 `ZNODES`、`REJECT`、`DIALOGUE`、`BEHAVIOR`、`SCRIPTS`、`BLOCKMAP`,以 `ENDMAP` 结束且包含它)。`MAP_DATA_LUMPS` 保持原来的 10 个名称不变,另增内部常量 `MAP_EXTRA_LUMPS`(`BEHAVIOR`、`SCRIPTS`)与 `UDMF_MAP_LUMPS`。判定:作用域含 `TEXTMAP` 为 `udmf`,否则含 `BEHAVIOR` 为 `hexen`,其余为 `doom`。Doom/Hexen 路径要求至少含一个 `MAP_DATA_LUMPS` 成员才成图;UDMF 候选标记可以是紧邻 `TEXTMAP` 之前的任意名称的 Lump(不要求 `size === 0`,与 D-7 一致)。缺 `ENDMAP` 的 UDMF 作用域仍识别为 `udmf`。**只识别,不解析**:不解析 Hexen 的记录布局,不解析 `TEXTMAP`。这是名称启发式,不能保证识别所有来源的 WAD。(见 `design.md` 的"地图作用域·目标"一节;常量名与 UDMF 成员列表为设计阶段建议,名称见 `design.md`,实施前可调整)
    - 修改 `packages/adapter-wad/src/wad.ts`
    - 在 `packages/adapter-wad/test/scope.test.ts` 补例子:(a) `MAP01`、`THINGS`、`LINEDEFS`、`BEHAVIOR` 得到 `dataIndices` 含 `BEHAVIOR` 且 `format` 为 `hexen`;(b) `MYMAP`、`TEXTMAP`、`ZNODES`、`REJECT`、`ENDMAP`、`THINGS` 得到 `udmf`,`dataIndices` 到 `ENDMAP` 为止、不含其后的 `THINGS`;(c) 缺 `ENDMAP` 的 UDMF 仍为 `udmf`;(d) `MAP01` 后只有 `BEHAVIOR` 不成图
    - 在 `packages/adapter-wad/test/freedoom.test.ts` 为夹具和本地 IWAD 的 `MAP01`、`MAP02` 增加断言:`format` 为 `doom`,`dataIndices` 与改动前逐项相同,`Object.keys(m.lumps)` 仍等于 `MAP_DATA_LUMPS`
    - 验收:上述例子通过;对不含 `BEHAVIOR`、`SCRIPTS`、`TEXTMAP` 的名称序列,新实现与旧实现的 `maps` 逐项相同(Property 7 目标段的不变量,属性形式见 13.4);`parse` 不抛新的错误类型;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-3、D-9、D-3;关联规则:binary-safety "PWAD 必须包含标记 Lump 与该地图的全部数据 Lump"、product "Refuse to guess"
    - **Property 7: 地图作用域与参考实现一致**(目标段由 13.4 以属性形式覆盖)
    - **Validates: Requirements 4.1, 4.2, 4.3**(`format`、扩展成员和 UDMF 识别尚无对应需求条目,在 15.12 新增)

  - [x] 11.2 非 Doom 地图的记录访问抛 `UNSUPPORTED_MAP_FORMAT`(X-3)
    - 决定:`recordCount`、`recordSpan`、`fieldSpan`、`readRecord`、`readRecords`、`setField` 对属于任一 `format` 为 `hexen` 或 `udmf` 的地图的 `dataIndices` 的 Lump,一律抛 `WadRecordError`,`code` 为 `UNSUPPORTED_MAP_FORMAT`;不返回 0,不降级为告警。检查顺序:在"Lump 下标存在"与"Lump 名称与记录类型相符"之后。病态输入使同一 Lump 落入多个作用域时,只要其中一个是非 Doom 格式就拒绝。不受限:`serialize()`、`original()`、`lumpBytes()`、`maps`、`regions`、`findLump`、`findMap`、`mapLump`、`dirtySpans()`,所以 I-1 对这类 WAD 照常成立。不属于任何 `MapScope` 的 Lump 按决定 7 处理:读取接口行为不变(仍按 Lump 名对应 Doom 记录),`setField` 由 10.4 拒绝为 `OUTSIDE_MAP_SCOPE`,本任务不改动这一行为。决定 4 实施后,10.4 的作用域规则从"至少属于一个 `MapScope`"收紧为"至少属于一个 Doom 作用域",这由本任务在 `fieldSpan` 内的格式检查保证(落入任一非 Doom 作用域即抛 `UNSUPPORTED_MAP_FORMAT`,优先于 `OUTSIDE_MAP_SCOPE`),10.4 的作用域检查代码无需修改。依赖 11.1 的 `format`、10.2 创建的 `WadRecordError`,以及 10.4 对 `OUTSIDE_MAP_SCOPE` 的实现。(见 `design.md` 的"地图格式与非 Doom 地图的访问限制"一节;名称见 `design.md`,实施前可调整,`UNSUPPORTED_MAP_FORMAT` 除外)
    - 修改 `packages/adapter-wad/src/wad.ts`
    - 新增 `packages/adapter-wad/test/map-format.test.ts`(Property 13):在 `mapWad` 之上构造格式变体:(a) 在 10 个数据 Lump 后追加 `BEHAVIOR`;(b) 把 `THINGS` 数据换成 20 字节的倍数(只用来制造"按 Doom 布局会读出错误条数"的反例,不解析其内容);(c) UDMF 作用域;(d) 对照的 Doom 地图。断言六个接口对非 Doom 地图抛 `UNSUPPORTED_MAP_FORMAT`,`setField` 的拒绝不留痕迹,`serialize()` 等于输入,`maps`、`regions`、`lumpBytes()` 照常工作;对 Doom 地图,六个接口的读取行为与改动前相同;对不属于任何作用域的 Lump,读取接口行为与改动前相同,`setField` 抛 `OUTSIDE_MAP_SCOPE`(10.4)
    - 在 `packages/adapter-wad/test/regression.test.ts` 加入命名回归用例"X-3":带 `BEHAVIOR` 的 Hexen 地图上 `readRecords(thingsLump, "Thing")` 抛 `UNSUPPORTED_MAP_FORMAT`
    - 在 `packages/adapter-wad/test/freedoom.test.ts` 用 `buildWad` 构造夹具的 Hexen 变体(追加 `BEHAVIOR`),断言记录接口抛 `UNSUPPORTED_MAP_FORMAT`;夹具本身的 `MAP01`、`MAP02` 六个接口行为不变
    - 验收:Property 13 至少 100 次通过;上述回归用例和夹具用例通过;Hexen 风格的 `THINGS`(20 字节一条)不再被按 10 字节 `Thing` 解释或写入;对不属于任何作用域的 Lump,读取接口行为与改动前相同,`setField` 抛 `OUTSIDE_MAP_SCOPE`(10.4 的 "X-4" 回归用例继续通过);解析仍不抛新的错误类型;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-3(X-4 已由 10.4 处理);关联原则:product "Refuse to guess"
    - **Property 13: 非 Doom 格式地图拒绝按 Doom 布局访问**
    - **Validates: Requirements 6.4, 9.1, 4.2**(`UNSUPPORTED_MAP_FORMAT` 尚无对应需求条目,在 15.12 新增)

- [ ] 12. Checkpoint - 确认必需修复后的测试状态
  - Ensure all tests pass, ask the user if questions arise.

#### 中优先级:补测

> 13.11、13.15、13.17 为必需任务,不带 `*`:13.11 是已决定的代码修复(第一批);13.15、13.17 是用户要求本轮完成的第二批。13.10 保持可选,13.18(Property 14 的属性测试)为可选,其余补测保持可选。
>
> 决定 7(10.4)之后,所有通过 `setField` 写入的测试,被写的 `SECTORS`、`THINGS` 必须在 Doom 地图作用域内(`mapWad` 满足;`buildWad` 手工构造时要有标记 Lump),否则会得到 `OUTSIDE_MAP_SCOPE`。

- [ ] 13. 补齐属性测试与例子测试
  - [ ]* 13.1 为 Property 1 与 Property 3 增加 dirtySpans 断言(F-2)
    - 文件:`packages/adapter-wad/test/roundtrip.test.ts`
    - I-1 属性断言 `dirtySpans()` 为空;局部性属性断言 `dirtySpans()` 区间的并集等于各次 `setField` 返回 `Span` 的并集(不是"每个区间被某一个 `Span` 覆盖")
    - 验收:新增断言通过,且相邻写入(`[32,34)` 与 `[34,36)`)被合并为 `[32,36)` 的情形有例子;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 1: I-1 无损往返**、**Property 3: I-3 局部性**
    - **Validates: Requirements 9.5, 11.4**

  - [ ]* 13.2 为 Property 4 增加错误码属性测试
    - 文件:新增 `packages/adapter-wad/test/parse-errors.test.ts`
    - 直接生成头部字段(`numLumps`、`directoryOffset`、输入长度),按条件计算期望错误码并断言 `code`;度量成功路径占比
    - 验收:对 `TOO_SHORT`、`BAD_IDENT`、`BAD_DIRECTORY` 和成功路径都有命中;至少 100 次;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 4: parse 对任意字节全函数,错误码由头部决定**
    - **Validates: Requirements 1.5, 1.6, 1.7, 1.8, 2.1, 2.7**

  - [ ]* 13.3 为 Property 5 增加目录项分类属性测试
    - 文件:新增 `packages/adapter-wad/test/directory-entries.test.ts`
    - 对生成容器及被改写目录项的变体,按"目录项分类"表断言 `entrySpan`、`nameSpan` 内容、`name`、`issues`、`dataSpan`、`isMarker`
    - 验收:四类目录项(负值、零字节标记、正常、越界)都被覆盖,至少 100 次;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 5: 目录项分类、名称与区间几何**
    - **Validates: Requirements 1.3, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3**

  - [ ]* 13.4 为 Property 7 增加地图作用域属性测试
    - 文件:`packages/adapter-wad/test/scope.test.ts`、`packages/adapter-wad/test/arbitraries.ts`(把 `BEHAVIOR`、`SCRIPTS`、`TEXTMAP`、`ZNODES`、`DIALOGUE`、`ENDMAP` 加入 `lumpInput` 的 `specialName`)
    - 复用 `lumpInput`,将 `wad.maps` 与只用规则描述的参考实现比较;参考实现按 11.1 的扫描规则编写,包括每张地图的 `format`
    - 验收:对任意 Lump 名称序列两者一致,至少 100 次;不含 `BEHAVIOR`、`SCRIPTS`、`TEXTMAP` 的序列,结果与 11.1 之前的实现逐项相同(该不变量以内联的旧规则实现断言);检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 7: 地图作用域与参考实现一致**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**

  - [ ]* 13.5 为 Property 8 增加字段写入读回属性测试
    - 文件:新增 `packages/adapter-wad/test/field-write.test.ts`,使用 13.15 的由 `RECORD_LAYOUTS` 推导的生成器(`name8` 字段由 13.17 覆盖,此处覆盖 `int16`、`uint16` 字段);被写 Lump 来自 `mapWad`,在地图作用域内(10.4)
    - 验收:对 `Sector`/`Thing` 的任意整数字段与合法值,返回的 `Span` 等于 `fieldSpan`,`readRecord` 读回新值,其他字段不变,`serialize()` 在该 `Span` 内等于小端编码,`original()` 不变;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 8: 字段写入后读回新值**
    - **Validates: Requirements 6.2, 6.3, 7.1, 7.2, 7.9**

  - [ ]* 13.6 为 Property 9 增加非法新值属性测试
    - 文件:新增 `packages/adapter-wad/test/field-write-reject.test.ts`,使用 13.15 的生成器;被写 Lump 来自 `mapWad`,在地图作用域内(10.4),这样被拒绝的原因只可能是参数或新值非法,而不是 `OUTSIDE_MAP_SCOPE`
    - 用 `fc.oneof` 组合非整数、`NaN`、`Infinity`、越界整数、非字符串、长度越界和含非法码点的字符串,以及非法记录下标
    - 验收:抛出 `TypeError` 或 `RangeError`,且调用前后 `dirtySpans()` 与 `serialize()` 相同;`uint16` 下界被覆盖;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 9: 非法新值被拒绝且不留痕迹**
    - **Validates: Requirements 7.5, 7.6, 7.7, 7.8, 7.10, 6.5**

  - [ ]* 13.7 补全 Property 10 的覆盖层断言
    - 文件:`packages/core/test/overlay.test.ts`(`ByteOverlay` 已在 10.3 改从 `../src/internal.ts` 导入)
    - 增加对 `dirtySpans()` 等于 `mergeSpans(全部写入区间)`、重叠写入的叠加顺序、`write` 的副本语义(事后修改传入数组不影响已记录内容)、`materialize()` 每次返回新数组的断言,以参考模型比较 `read`。`ByteOverlay` 构造函数仍持有传入的引用(复制发生在 `WadFile.parse`),所以"基础缓冲不被修改"断言的是调用方传入的数组
    - 验收:新增属性至少 100 次并通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 10: ByteOverlay 与参考模型一致**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.5, 8.6, 8.7**

  - [ ]* 13.8 为 Property 11 增加 mergeSpans 与 complementSpans 属性测试
    - 文件:新增 `packages/core/test/span.test.ts`
    - 生成允许 `end <= start` 和越界的区间,用位图作参考模型
    - 验收:结果有序、无空区间、无重叠或相邻;`complementSpans` 与 `covered` 在 `[0, total)` 内互补,越界区间被截断;至少 100 次;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 11: mergeSpans 与 complementSpans**
    - **Validates: Requirements 8.8, 8.9**

  - [ ]* 13.9 为 Property 12 增加生成器偏移与大小属性测试
    - 文件:新增 `packages/adapter-wad/test/generator.property.test.ts`
    - 随机生成记录定义并拼成 YAML 文本,调用纯函数 `generateRecordsSource`;字段总长与 `size` 不符的定义必须抛出以 `wad.records.yaml:` 开头的 `Error`
    - 验收:每个字段的 `offset` 等于前面字段字节数之和,末字段结束位置等于 `size`;至少 100 次;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - **Property 12: 生成器的偏移与大小一致**
    - **Validates: Requirements 5.2, 5.4, 5.5**

  - [ ]* 13.10 增加 Thing 字段写入的例子测试(第二批)
    - 文件:`packages/adapter-wad/test/records.test.ts`
    - 覆盖 `Thing` 的 `x`、`y`、`angle`、`type`(`int16`)和 `flags`(`uint16`,`setUint16` 路径)的写入、读回、边界值与相邻记录不变;比较原始字节使用 `original()`;`THINGS` 必须放进地图作用域(例如 `MAP01` 空标记加 `THINGS`,可复用 10.4 在 `records.test.ts` 引入的辅助函数的同类写法),否则 `setField` 抛 `OUTSIDE_MAP_SCOPE`
    - 验收:字节只在返回的 `Span` 内变化;`flags` 写入 0 与 65535 通过,-1 与 65536 抛 `RangeError`;`int16` 字段的 -32768 与 32767 通过,-32769 与 32768 抛 `RangeError`;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - _Requirements: 7.1, 7.3, 7.6_

  - [x] 13.11 `fieldSpan` 对继承自 Object.prototype 的字段名抛 RangeError(F-3,第一批,必需)
    - 决定:`fieldSpan` 只接受布局自有字段,用 `Object.hasOwn`(或等价的自有属性判断)检查字段名,使 `constructor`、`toString`、`__proto__` 等继承名称与不存在的字段名一样抛 `RangeError`,与 Requirement 6.6 一致;不修改 `requirements.md`。(见 `design.md` 的 F-3)
    - 修改 `packages/adapter-wad/src/wad.ts` 的 `fieldSpan`
    - 在 `packages/adapter-wad/test/regression.test.ts` 加入命名回归用例"F-3":`fieldSpan(…, "constructor")`、`"toString"`、`"__proto__"` 抛 `RangeError`;`setField` 对这些名称同样抛 `RangeError`,且 `dirtySpans()` 为空;`fieldSpan` 不再返回 `start`、`end` 为 `NaN` 的 `Span`
    - 验收:上述回归用例通过;合法字段名与未知字段名的原有行为不变;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:F-3
    - _Requirements: 6.6_

  - [ ]* 13.12 测试并修复 ByteOverlay.read 的越界与非整数参数(X-5)
    - 文件:`packages/core/src/overlay.ts`、`packages/core/test/overlay.test.ts`
    - 验收:`read` 对负数、超出缓冲、`NaN`、非整数的 `offset` 或 `length` 抛 `RangeError`,与 `write` 对偏移的要求对称;`WadFile` 内部调用不受影响;`ByteOverlay` 的导入来自 `../src/internal.ts`(见 10.3);检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-5
    - _Requirements: 8.4_

  - [ ]* 13.13 测试 YAML 校验分支与 `--check` 退出状态
    - 文件:新增 `packages/adapter-wad/test/generate-records.test.ts`(依赖 14.6、14.7 先统一提示与校验)
    - 逐条覆盖 Requirement 5.4 与 5.5 的错误分支(缺少 `records`、非法标识符、非法 Lump 名称、`size` 非正整数、无字段、字段重名、未知类型、非法 `count`、总长不符);用子进程运行 `--check`,断言过期或缺文件时退出码为非零且标准错误有提示,且不写任何文件
    - 验收:每个分支的错误消息都以 `wad.records.yaml:` 开头;`--check` 在同步时退出码为 0;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - _Requirements: 5.4, 5.5, 5.7, 5.8_

  - [ ]* 13.14 整包 IWAD 的 I-2 与 I-3 抽样检查,`REQUIRE_FREEDOOM` 缺文件失败(D-8,已决定,延后)
    - **已决定,延后:`wad-export` 完成之后再做;本次不执行。**(见 `design.md` 的"CI 策略"一节)
    - 文件:`packages/adapter-wad/test/freedoom.test.ts`
    - 决定:环境变量统一为 `REQUIRE_FREEDOOM`(此前草稿中的 `NECROHEX_REQUIRE_IWAD` 作废,不得出现在代码和文档中)。设置为 `1` 时,`fixtures/cache/` 中缺文件的整包用例必须失败,而不是 `it.skipIf` 跳过;未设置时(本地开发)保持现有跳过行为。随仓库提交的夹具 `fixtures/freedoom/freedoom2-map01-02.wad` 相关用例始终运行,不允许跳过
    - 对 `freedoom1.wad`、`freedoom2.wad` 随机选取若干扇区写入,检查结构摘要相等(I-2)和变化字节只在返回的 `Span` 内(I-3);新增的属性带 Feature 标签(见 15.11)
    - 验收:本地 cache 存在时新增用例通过;设置 `REQUIRE_FREEDOOM=1` 且缺文件时测试失败;未设置时行为与现在相同;全仓库 `grep` 不到 `NECROHEX_REQUIRE_IWAD`;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:D-8
    - _Requirements: 9.2, 10.1, 11.2_

  - [x] 13.15 让 `mapWad` 产出合法的 THINGS Lump,I-2 与 I-3 覆盖 Thing 全部字段(D-10,第二批)
    - 文件:`packages/adapter-wad/test/arbitraries.ts`、`packages/adapter-wad/test/roundtrip.test.ts`
    - 让 `mapWad` 产出长度合法的 `THINGS` Lump(10 字节的倍数,1 到 6 条,与扇区数无关,新增 `thingBytes(count, seed)`);新增由 `RECORD_LAYOUTS` 推导的"记录 × 字段 × 合法值"生成器(按字段类型生成合法值),供 I-2、I-3 以及 13.5、13.6 使用;I-2 与 I-3 属性改为对 `Thing` 的 `x`、`y`、`angle`、`type`、`flags` 全部字段写入。该任务**收窄**到 `Thing`:`Sector` 现有的 `lightlevel`、`special` 写入保持,`name8` 字段由 13.17 覆盖,`Sector` 其余整数字段由 13.5 覆盖
    - 属性以第一批之后的新行为为准:`original()` 取代 `baseBuffer`;**依赖 10.4 之后的新行为**:`mapWad` 产出的 `THINGS`、`SECTORS` 必须在 Doom 地图作用域内(标记之后紧跟 10 个数据 Lump,`mapWad` 满足),写入这样的 WAD 不会触发 `WRITE_OVERLAPS_STRUCTURE`(10.2),也不会触发 `OUTSIDE_MAP_SCOPE`(10.4),属性中断言每次写入都被接受(不抛 `WadRecordError`)
    - 验收:I-2、I-3 属性对 `Thing` 全部字段通过,至少 100 次;现有属性仍通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:D-10
    - **Property 2: I-2 结构对偶**、**Property 3: I-3 局部性**
    - **Validates: Requirements 10.1, 10.2, 11.1, 11.2**

  - [ ]* 13.16 修正个别测试的标题与断言(X-13)并补区域属性的损坏目录变体
    - 文件:`packages/adapter-wad/test/roundtrip.test.ts`
    - "损坏目录项…问题记入 issues"补上对 `issues` 的断言;为 Requirement 2.5 增加真正重叠 Lump 的用例;对被改写目录后产生重叠区间的容器断言 `gaps` 与其余区域不相交
    - 验收:测试标题与断言一致;Requirement 2.5 有直接用例;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-13
    - **Property 6: 区域铺满且 gaps 不相交**
    - **Validates: Requirements 2.5, 3.5**

  - [x] 13.17 `name8` 字段写入的属性测试(D-10,第二批)
    - 文件:新增 `packages/adapter-wad/test/field-write-name8.test.ts`;使用 `mapWad`、`summarize`、`changedIndices`、`insideAny`,位于 13.15 之后,避免与它同时修改共享的生成器
    - 对 `Sector` 的 `floorpic`、`ceilingpic`:合法名称(1 到 8 个码点在 0x21 到 0x7e 的字符,包含恰为 8 个字符与恰为 1 个字符的边界)写入后,`readRecord` 读回新值;`serialize()` 在返回的 `Span` 内的 8 字节等于名称加 NUL 填充;字节只在返回的 `Span` 内变化(I-3),此时字段原有的 8 字节(包括 NUL 之后的杂字节)被整体重写;写入后 `WadFile.parse(serialize())` 的结构摘要与各记录和写入后的 A 相等(I-2)
    - 非法名称(非字符串、长度为 0 或大于 8、含空格、NUL、0x7f 或非 Latin 字符)被拒绝:抛 `TypeError` 或 `RangeError`,`dirtySpans()` 与 `serialize()` 不变
    - 属性以第一批之后的新行为为准:**依赖 10.4 之后的新行为**,`mapWad` 产出的 `SECTORS` 在 Doom 地图作用域内,写入这样的 WAD 的每次写入都被接受(不抛 `WadRecordError`,既不是 `WRITE_OVERLAPS_STRUCTURE`(10.2)也不是 `OUTSIDE_MAP_SCOPE`(10.4)),比较原始字节使用 `original()`(10.1)
    - 验收:合法名称与非法名称两个属性各至少 100 次并通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:D-10
    - **Property 2: I-2 结构对偶**、**Property 3: I-3 局部性**、**Property 8: 字段写入后读回新值**、**Property 9: 非法新值被拒绝且不留痕迹**
    - **Validates: Requirements 7.7, 7.8, 7.9, 7.10, 10.1, 10.2, 11.2**

  - [ ]* 13.18 为 Property 14 增加属性测试:不属于任何地图作用域的 Lump 可读不可写(决定 7,X-4)
    - 可选。10.4 的命名回归用例 "X-4" 已覆盖例子形式;本任务把 `design.md` 的 Property 14 写成属性测试。依赖 10.4(`OUTSIDE_MAP_SCOPE`)和 10.2(`WRITE_OVERLAPS_STRUCTURE`,用于次序断言)
    - 文件:新增 `packages/adapter-wad/test/write-scope.test.ts`(生成器写在该文件内,不修改 `arbitraries.ts`),以及 `packages/adapter-wad/test/freedoom.test.ts` 的一个例子
    - 生成器(见 `design.md` 的 Property 14):(a) 无标记,只含 `SECTORS`、`THINGS` 等记录 Lump;(b) `SECTORS` 出现在 `MAP01` 之前;(c) 被未识别 Lump 截断:`MAP01`、`THINGS`、`LINEDEFS`、一个名称取自随机名(排除 `MAP_DATA_LUMPS` 和标记名)的 Lump、`SECTORS`;(d) 重复名称截断:`MAP01`、`THINGS`、`THINGS`,第二个 `THINGS` 在作用域之外;(e) 对照:`mapWad`,写入被接受。(a) 到 (d) 的记录 Lump 取 1 到 6 条完整记录
    - 断言:对 `maps` 中没有任何 `dataIndices` 含该下标的记录 Lump L:(1) 五个读取接口与按 Doom 布局的参考实现一致(`floor(size / 记录大小)` 条,小端解码)且不抛 `WadRecordError`;(2) 对任意合法记录下标、字段与合法新值,`setField` 抛 `WadRecordError` 且 `code === "OUTSIDE_MAP_SCOPE"`,调用前后 `dirtySpans()` 与 `serialize()` 相同;(3) 次序:非法的记录下标、字段名或新值仍抛原来的 `RangeError`/`TypeError`,只读记录类型仍抛 `Error`(参数类错误先于结构类拒绝);`SECTORS` 目录项 `filepos` 指向文件头的 L 得到 `OUTSIDE_MAP_SCOPE`,而不是 `WRITE_OVERLAPS_STRUCTURE`;(4) `serialize()` 等于输入;(5) 同一 Lump 落入多个作用域的次序断言,只有在 11.2 之后能构造出这类输入时才加,并入 `map-format.test.ts`;构造不出时本任务不写
    - Freedoom 例子:用 `buildWad` 以夹具的 Lump 重建一个 PWAD,在 `NODES` 与 `SECTORS` 之间插入一个名称不在成员列表里的 Lump,则 `MAP01` 的 `SECTORS` 落在作用域之外:`readRecords` 的结果与未改动的夹具逐条相等,`setField` 抛 `OUTSIDE_MAP_SCOPE`,`serialize()` 等于输入;未改动的夹具上 `SECTORS` 写入仍成功
    - 验收:属性至少 100 次通过;(a) 到 (d) 四类生成器都被命中;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-4
    - **Property 14: 不属于任何地图作用域的 Lump 可读不可写**
    - **Validates: Requirements 6.1, 6.2, 7.1, 7.10**

#### 低优先级:代码改进(可选,用户尚未决定)

- [ ] 14. 低优先级代码改进
  - [ ]* 14.1 决定并处理 scopeMaps 不检查标记大小为 0(D-7)
    - **先决定再实现。** 备选项:(a) 不改变识别结果,在 `MapScope` 增加标志(例如 `markerIsEmpty`)供上层展示;(b) 把 `isMarker` 作为硬条件(会漏掉非标准工具生成的 WAD);(c) 保持现状并只补文档。决定记录到 `docs/decisions.md`。
    - 文件:`packages/adapter-wad/src/wad.ts`、`packages/adapter-wad/test/scope.test.ts`;位于 11.1 之后,与 11.1 对 UDMF 候选不要求 `size === 0` 的规定保持一致
    - 验收:名为 `MAP01`、数据 3 字节且后接 `THINGS` 的 Lump 按决定表现,并有例子测试;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:D-7
    - _Requirements: 4.1_

  - [ ]* 14.3 把可写记录类型登记移入 YAML(X-6)
    - **先决定再实现。** 需要决定 YAML 字段名与生成物形式(例如 `writable: true`,生成 `WRITABLE_RECORDS` 与带类型的 `RECORD_ENCODERS`)。决定记录到 `docs/decisions.md`。
    - 文件:`packages/adapter-wad/spec/wad.records.yaml`、`packages/adapter-wad/scripts/generate-records.ts`、`packages/adapter-wad/src/wad.ts`;`src/generated/records.ts` 只能由生成器重新生成
    - 验收:`wad.ts` 不再手写 `WRITABLE_RECORDS`,也不再用 `as unknown as Record<string, …>` 按名取编码函数;`generate:check` 与 `pnpm -r typecheck` 通过;`Sector`、`Thing` 仍可写,其余三种仍只读;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-6
    - _Requirements: 5.1, 7.4_

  - [ ]* 14.4 决定并处理 buildWad 的公共导出(X-7)
    - **先决定再实现。** 备选项:(a) 移到 `@necrohex/adapter-wad/testing` 之类的子路径;(b) 保持导出并在 JSDoc 标注仅用于测试和夹具。决定记录到 `docs/decisions.md`。
    - 文件:`packages/adapter-wad/src/index.ts`、`packages/adapter-wad/src/build.ts`、`packages/adapter-wad/package.json`,以及导入 `buildWad` 的测试与脚本
    - 验收:按决定调整后全部测试通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-7
    - _Requirements: 7.11_

  - [ ]* 14.5 为 adapter-wad 的 src 增加无 Node 类型的类型检查(X-8)
    - 文件:`packages/adapter-wad/tsconfig.json` 及新增的仅含 `src` 的 tsconfig(`types: []`)、`packages/adapter-wad/package.json` 的 typecheck 脚本
    - 验收:在 `src` 引入 `node:` 导入时 typecheck 失败;当前代码通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-8
    - _Requirements: 7.11_

  - [ ]* 14.6 统一生成器的提示命令(X-9)
    - 文件:`packages/adapter-wad/scripts/generate-records.ts`
    - 把提示中的 `pnpm generate` 改为 `pnpm --filter @necrohex/adapter-wad generate`,与 `generated/records.ts` 头注释一致
    - 验收:过期提示中的命令可以直接运行;`generate:check` 仍通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-9
    - _Requirements: 5.8_

  - [ ]* 14.7 加强生成器对继承名称与重复 Lump 名的校验(X-10)
    - 文件:`packages/adapter-wad/scripts/generate-records.ts`
    - 字段类型与字段名的查找使用自有属性判断;拒绝两条记录使用同一个 Lump 名;错误消息仍以 `wad.records.yaml:` 开头
    - 验收:`constructor`、`__proto__` 作为类型或字段名时给出明确错误;重复 Lump 名被拒绝;现有 YAML 生成结果不变;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-10
    - _Requirements: 5.4_

  - [ ]* 14.8 决定并处理未被使用的 RECORD_BY_LUMP(X-11)
    - **先决定再实现。** 备选项:(a) 保留并增加使用它的测试;(b) 从生成物中移除。决定记录到 `docs/decisions.md`。
    - 文件:`packages/adapter-wad/scripts/generate-records.ts`(`src/generated/records.ts` 只能重新生成)、`packages/adapter-wad/test/records.test.ts`
    - 验收:`RECORD_BY_LUMP` 要么有测试保护,要么不再生成;`generate:check` 通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-11
    - _Requirements: 5.1_

  - [ ]* 14.9 决定并处理重复的名称解码实现(X-12)
    - **先决定再实现。** 备选项:合并为 `field-codec.ts` 中的一份实现,或保持现状并在两处加交叉注释。决定记录到 `docs/decisions.md`。
    - 文件:`packages/adapter-wad/src/wad.ts`、`packages/adapter-wad/src/field-codec.ts`
    - 验收:行为不变,Property 1 与 `scope.test.ts` 中的名称用例通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-12
    - _Requirements: 3.2_

  - [ ]* 14.10 评估并处理 ByteOverlay 读取随写入次数线性变慢(X-14)
    - **先决定是否需要实现。** 触发条件:补丁一次写入大量字段后在工作台反复读取记录。备选项:压缩写入列表,或在 `materialize` 后重建基础。
    - 文件:`packages/core/src/overlay.ts`、`packages/core/test/overlay.test.ts`(位于 10.1、10.3、13.12 之后,避免与它们同时改同一文件)
    - 验收:行为与 Property 10 的参考模型一致;`dirtySpans()` 结果不变;不改变 `write` 的副本语义;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - 关联风险:X-14
    - _Requirements: 8.3, 8.5, 8.6_

#### 文档与流程

- [ ] 15. 文档与流程
  - [x] 15.1 修正 requirements.md 中关于 baseBuffer 只读性的表述(F-1)(已完成)
    - 已完成:`.kiro/specs/wad-roundtrip/requirements.md` 的"已知差异"第 5 项和 Glossary 中 `baseBuffer` 条目已改为"没有任何类型或运行时保护",与 `design.md` 的 F-1 一致
    - 说明:`baseBuffer` 被 10.1 删除之后,Glossary 的相应条目随 15.12 同步,不在本任务范围内
    - 关联风险:F-1、D-5
    - _Requirements: 9.3_

  - [x] 15.2 修正 Requirement 11.4 的措辞(F-2)(已完成)
    - 已完成:`.kiro/specs/wad-roundtrip/requirements.md` 的 Requirement 11.4 已改为"被各次成功的 `setField` 返回的 Span 的并集覆盖",并说明 `dirtySpans()` 会合并相邻区间,与 Property 3 和 13.1 的断言一致
    - 关联风险:F-2
    - _Requirements: 11.4_

  - [x] 15.3 修正"验证依据"对测试覆盖的描述(F-4)(已完成)
    - 已完成:`.kiro/specs/wad-roundtrip/requirements.md` 的"验证依据"一节已更正:空目录用例的 `directoryOffset` 实际为 12(该用例没有断言此值);`name8` 写入已有直接例子测试,只有 `Thing` 写入没有测试;"已知差异"第 10 项同步更正
    - 关联风险:F-4
    - _Requirements: 7.1, 7.7, 7.8_

  - [ ]* 15.5 在 docs/design.md 第 9 节注明 PLAYPAL 为后续可选(D-1)
    - 已决定(见 `design.md` 的 D-1):`PLAYPAL` 不属于本 Spec,移到"后续可选项"。**只改文档,本次不执行。**
    - 文件:`docs/design.md` 第 9 节(仓库级设计文档,不是 Spec 的 `design.md`):把相关一句改为"`PLAYPAL` 的记录定义是后续可选项,不属于 `wad-roundtrip` 的当前范围";不改代码、YAML 和生成器
    - `PLAYPAL` 的记录定义草案列在本文末尾"后续可选项"一节
    - 验收:`docs/design.md` 第 9 节不再暗示 `PLAYPAL` 记录已经存在;`packages/adapter-wad/spec/wad.records.yaml` 没有改动;`PLAYPAL` 在 Freedoom 夹具中仍作为未解析 Lump 原样往返
    - 关联风险:D-1
    - _Requirements: 5.1, 5.10_

  - [ ]* 15.6 更正 docs/design.md 中记录与字段区间的措辞(D-2)
    - 文件:`docs/design.md` 第 9 节
    - 改为"Lump 的物理区间在解析时记录,记录和字段的区间由布局确定性计算"
    - 验收:与 `recordSpan`、`fieldSpan` 的实现一致
    - 关联风险:D-2
    - _Requirements: 6.3_

  - [ ]* 15.7 在 docs/design.md 标注导出的现状(D-3)
    - 文件:`docs/design.md` 第 9 节"导出"
    - 注明"完整 WAD = `WadFile.serialize()`,已实现";PWAD 导出及其不变量归 `wad-export`,以 11.1 的作用域结论(含 `BEHAVIOR`、`SCRIPTS` 与 UDMF 成员)为前置条件
    - 验收:文档不再暗示 PWAD 导出已存在
    - 关联风险:D-3、D-9
    - _Requirements: 9.1_

  - [ ]* 15.8 在 docs/design.md 说明 I-3 的层次(D-4)
    - 文件:`docs/design.md` 第 10 节
    - 说明 `wad-roundtrip` 层的 I-3 以 `setField` 返回的 `Span` 为准,是回执层 I-3 的前提;回执的区间应来自 `setField` 的返回值而不是 `dirtySpans()`
    - 验收:`semantic-patch` 的 Spec 可以引用该说明
    - 关联风险:D-4
    - _Requirements: 11.2, 11.4_

  - [ ]* 15.9 GitHub Actions 与 Freedoom 整包测试的 CI 配置(D-8,已决定,延后)
    - **已决定,延后:`wad-export` 完成之后再做;本次不执行。**(见 `design.md` 的"CI 策略"一节)
    - 决定:使用 GitHub Actions。随仓库提交的夹具必须始终运行。整包测试下载固定版本的 Freedoom,校验 SHA-256,缓存下载结果(缓存键包含版本号与校验和);Freedoom 为 BSD 许可,下载结果放入 `packages/adapter-wad/fixtures/cache/`,不进入仓库。CI 中设置 `REQUIRE_FREEDOOM=1`,缺文件时整包用例失败(`NECROHEX_REQUIRE_IWAD` 作废)。具体版本号与校验和在实施时从 Freedoom 官方发布页确定
    - 文件:新增 `.github/workflows/` 下的工作流文件(当前仓库没有 `.github`),`packages/adapter-wad/fixtures/README.md`("逐字节复制"改为只限 Lump 数据和原始名称,不含目录)
    - 依赖 13.14 提供的 `REQUIRE_FREEDOOM` 行为
    - 验收:CI 中整包 IWAD 用例实际运行;缺 cache 时因 `REQUIRE_FREEDOOM=1` 而失败;`fixtures/cache/` 仍被 git 忽略;工作流运行 `pnpm -r typecheck`、`pnpm --filter @necrohex/adapter-wad generate:check` 和各包测试
    - 关联风险:D-8
    - _Requirements: 9.2_

  - [ ]* 15.10 建立回归用例的落点与命名约定
    - 文件:`packages/adapter-wad/test/regression.test.ts`(文件头注释说明约定)
    - 约定:每个由属性测试或核对发现的 bug 对应一个命名用例,用例名以缺陷编号开头;文件头注释列出已有用例(按实施顺序):D-5(10.1)、X-1(10.2)、X-4(10.4)、D-6(10.3)、F-3(13.11)、X-3(11.2)
    - `docs/kiro-usage.md` 的记录由 15.13 负责,本任务不修改它
    - 验收:上述回归用例都在该文件中且通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - _Requirements: 9.1, 10.1, 6.6_

  - [ ]* 15.11 给属性测试加 Feature 标签
    - 文件:`packages/adapter-wad/test/` 与 `packages/core/test/` 下所有属性测试(`roundtrip.test.ts`、`parse-errors.test.ts`、`directory-entries.test.ts`、`scope.test.ts`、`map-format.test.ts`、`field-write.test.ts`、`field-write-reject.test.ts`、`field-write-name8.test.ts`、`write-scope.test.ts`、`generator.property.test.ts`、`overlay.test.ts`、`span.test.ts` 等)
    - 在每个属性测试处加注释标签,格式 `Feature: wad-roundtrip, Property N: <属性标题>`,编号与 `design.md` 一致
    - 验收:每个 Property 1 到 14 至少有一个带标签的测试(依赖 13.18 提供 Property 14 的属性测试);全部测试仍通过;检查:运行 `pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`
    - _Requirements: 9.1, 10.1, 11.1_

  - [x] 15.12 按已实现的行为同步 requirements.md,并把 design.md 中已实现条目的状态改为已实现
    - **必需任务。** 在全部必需的代码与测试任务完成并通过之后执行:10.1、10.2、10.3、10.4、11.1、11.2、13.11、13.15、13.17。必须排在 15.13 之前(15.13 依赖本任务)。本任务**不依赖任何可选任务**:可选任务(13.x、14.x、15.5 到 15.11)产出的测试,在它们完成时再追加到"验证依据"表,不属于本任务;本任务引用的测试文件都由上述必需任务产出
    - 文件:`.kiro/specs/wad-roundtrip/requirements.md`、`.kiro/specs/wad-roundtrip/design.md`(Spec 的 `design.md`,不是仓库级 `docs/design.md`)。本任务不修改代码,也不修改 `tasks.md` 的内容(只勾选自己)
    - **requirements.md 开头声明**:保留文件开头的"这是实现后补写的 Spec"声明,另加一句说明:"以下内容在实现完成后按实际代码同步。"
    - **新增与改写的需求组**(沿用 `design.md` 的名称;每组含 User Story 和 EARS 验收条目,格式与现有条目一致:`WHEN …, THE <组件> SHALL …` 或 `IF …, THEN THE <组件> SHALL …`;每条验收条目必须能由一个已存在的测试验证,并在条目下或"验证依据"表里写出该测试文件名;不能由测试验证的行为不写成验收条目,而是写入"已知限制"):
      - Requirement 12 缓冲所有权与 `original()`:`parse` 复制输入,调用方此后修改输入数组不影响 `serialize()`、`original()`、`lumpBytes()`;`original()` 返回解析时输入的逐字节副本且不含 `setField` 写入;`serialize()` 与 `original()` 每次返回新数组,修改返回值不影响之后的结果;`baseBuffer` 不再存在。测试:`roundtrip.test.ts`(Property 1 目标段)、`regression.test.ts`("D-5")、`records.test.ts`(写入用例使用 `original()`)。同时更新 Glossary 的 `baseBuffer` 条目(改为 `original()`)以及 Requirement 3.6、7.2、9.3 中 `baseBuffer` 的措辞
      - Requirement 13 写入重叠拒绝(取代原 15.4 的 Requirement 10 前提说明,不再单列 15.4):`setField` 的目标字段区间与 `regions.header`、`regions.directory` 或自己以外任一 Lump 的非空数据区间相交时,抛 `WadRecordError`,`code` 为 `WRITE_OVERLAPS_STRUCTURE`,不写入,`dirtySpans()` 与 `serialize()` 不变;半开区间,首尾相接不算相交;只比较目标字段区间;解析阶段仍不拒绝这类文件、`issues` 不新增代码;参数类错误(`TypeError`/`RangeError`)先于结构拒绝。同时修改 Requirement 10:I-2 对被接受的写入成立,相交的写入被 Requirement 13 拒绝,不再有"被写区间不得与头或目录相交"的隐含前提;Requirement 7.10 的"不留痕迹"范围扩到结构拒绝。测试:`roundtrip.test.ts`(Property 2 目标段)、`regression.test.ts`("X-1")、`freedoom.test.ts`(`filepos = 0` 的例子)
      - Requirement 14 `ByteOverlay` 内部子路径与公开入口:`@necrohex/core` 的公开入口不导出 `ByteOverlay`,仍导出 Span 工具;`ByteOverlay` 只经 `@necrohex/core/internal` 提供;`package.json` 的 `exports` 只有 `.` 和 `./internal`;写明这是约定级隔离,不是技术隔离(子路径与相对路径导入仍可绕过),机械检查只能发现误用。范围:收窄 Requirement 7.11(`WadFile` 公共 API 无裸偏移写入)与 Requirement 8.1(`ByteOverlay.write` 的可见范围)。测试:`packages/core/test/public-api.test.ts`、`packages/adapter-wad/test/core-exports.test.ts`、`regression.test.ts`("D-6")、`packages/core/test/overlay.test.ts`(改从内部入口导入)
      - Requirement 15 地图格式与 `UNSUPPORTED_MAP_FORMAT`:`MapScope.format` 为 `doom`、`hexen` 或 `udmf`;`BEHAVIOR`、`SCRIPTS` 是 Doom/Hexen 路径的扩展成员,UDMF 以 `TEXTMAP` 开头、成员见 `design.md`、以 `ENDMAP` 结束且包含它;`MAP_DATA_LUMPS` 仍为 10 个名称(同步 Requirement 4.1、4.3 的表述);识别结果对不含 `BEHAVIOR`、`SCRIPTS`、`TEXTMAP` 的输入与改动前相同;`recordCount`、`recordSpan`、`fieldSpan`、`readRecord`、`readRecords`、`setField` 对属于非 Doom 作用域的 Lump 抛 `WadRecordError`,`code` 为 `UNSUPPORTED_MAP_FORMAT`,检查顺序在 Lump 下标与名称检查之后;`serialize()`、`original()`、`lumpBytes()`、`maps`、`regions`、`dirtySpans()` 不受限;只识别不解析;名称启发式的限制写入"已知限制"。Glossary 新增 `WadRecordError`(`code`、`lumpIndex`)与 `MapScope.format`。测试:`scope.test.ts`、`freedoom.test.ts`、`map-format.test.ts`、`regression.test.ts`("X-3")
      - Requirement 16 不属于任何地图作用域的 Lump 可读不可写(决定 7):Lump 不属于任何 `MapScope` 时,五个读取接口行为不变;`setField` 抛 `WadRecordError`,`code` 为 `OUTSIDE_MAP_SCOPE`,不写入,`dirtySpans()` 与 `serialize()` 不变;检查位置在新值编码之后、写入重叠检查之前;非 Doom 作用域的 `UNSUPPORTED_MAP_FORMAT` 优先。多作用域规则只有在存在测试时才写成验收条目,否则写入"已知限制"。原有的"不属于任何作用域的 Lump 保持现状"的说法一并删除。测试:`regression.test.ts`("X-4")、`records.test.ts`(写入用例使用作用域内的辅助函数;只读与读取用例保留裸 Lump,证明读取不变)。Property 14 的属性测试(13.18)是可选任务,完成后再追加到"验证依据"表
      - Requirement 6.6 `fieldSpan` 未知字段名(F-3 已修复的事实):字段名不是该记录布局的自有字段时(包括 `constructor`、`toString`、`__proto__` 等继承名称),`fieldSpan` 与 `setField` 抛 `RangeError`,不返回 `NaN` 区间。测试:`regression.test.ts`("F-3")
    - **同步现有内容**:Glossary(`ByteOverlay` 的可见范围;`MAP_DATA_LUMPS` 仍为 10 个名称并说明扩展常量)、Requirement 4(格式与扩展成员)、Requirement 6(非 Doom 拒绝;6.6)、Requirement 10、范围外小节中与上述矛盾的描述
    - **已知差异**:已修复的条目改写为"已修复(对应任务)",或移到新小节"已解决的差异":D-5(10.1)、X-1 与 X-2(10.2)、D-6(10.3,注明仍是约定级隔离)、D-9 与 X-3(11.1、11.2)、X-4(10.4)、F-3(13.11)。保留尚未解决的条目:D-1(`PLAYPAL` 决定后续可选,范围外)、D-2、D-3、D-4、D-7、D-8(延后到 `wad-export` 之后)、D-10 的剩余部分(`Thing` 与 `name8` 字段写入已由 13.15、13.17 覆盖;`Sector` 其余整数字段的属性覆盖由可选的 13.5 提供,若未执行则仍属剩余部分)
    - **验证依据表**:更新现有行,新增 Requirement 12 到 16 的行(含测试文件名),并更正"目前没有直接的测试"一段(`fieldSpan` 未知字段已有 "F-3" 回归用例,`Thing` 写入已由 13.15 覆盖)
    - **design.md 状态同步**(本次规划没有改动 `design.md`,由本任务执行):
      - 下列条目的状态由"已决定,待实现"改为"已实现(任务编号)":D-5(10.1)、X-1 与 X-2(10.2)、D-6(10.3)、X-3 与 D-9(11.1、11.2)、X-4(10.4)、F-3(13.11)。D-1(后续可选)、D-8(延后)、D-10 的状态不变
      - 相应的【目标】标记改为【现状】(包括各 Components 小节、Data Models 的"地图作用域"、Correctness Properties 中 Property 1、2、3、7、13、14、Testing Strategy 的"决定 7 对现有测试的影响"和"回归用例"一节、"决定状态一览"与"已决定的变更与实施顺序"表中的状态列);原先的【现状】描述改写为"修复前的行为"或删除,不得留下"尚未实现"的残余表述;仍未实现的内容(决定 6 的 CI、`REQUIRE_FREEDOOM`)保持【目标】并标注"延后"
      - `design.md` 各 Property 的 `Validates` 同步引用 Requirement 12 到 16(Property 1 → 12;Property 2 → 13;Property 3 → 12、13;Property 7 → 15;Property 13 → 15;Property 14 → 16;Property 8/9 视 6.6 与 7.x 的改动保持一致),删除"尚未写入 `requirements.md`"的说明
    - 验收:
      - `requirements.md` 与 `design.md` 都通过 `validate_spec_format`(无错误)
      - 每条新增需求(Requirement 12 到 16 的每个验收条目)都出现在 `design.md` 某个 Property 的 `Validates` 中,并能指到一个已存在的测试文件
      - `design.md` 的 Property `Validates` 引用的编号都存在于 `requirements.md`,两份文档的编号一致
      - `design.md` 中不再有"已决定,待实现"指向 D-5、X-1、D-6、X-3、D-9、X-4、F-3 的状态,也不再有指向这些已实现行为的【目标】标记
      - 新增的 `requirements.md` 条目与已实现的行为一致,没有把延后或后续可选的事项写成已满足
    - 关联风险:D-5、X-1、X-2、D-6、X-3、D-9、X-4、F-3
    - _Requirements: 3.6, 4.1, 6.4, 6.6, 7.2, 7.10, 7.11, 8.1, 9.3, 10.1_(并新增 Requirement 12 到 16)

  - [x] 15.13 更新 docs/kiro-usage.md 与 docs/decisions.md
    - 必需任务,**依赖 15.12**(15.12 先完成,本任务才能执行),因此也在全部必需代码任务(10.x、13.11、13.15、13.17、11.x)之后;用户要求本次一并完成,不延后。
    - 文件:`docs/kiro-usage.md`、`docs/decisions.md`(仓库级文档)
    - `docs/kiro-usage.md`:在"Specs"表追加一行"wad-roundtrip(实现后补写)",按表头四列(Spec、工作流、产出、过程中修正了什么)填写。如实记录:Spec 是在代码已实现之后补写的;补写 requirements、design、tasks 的过程中通过阅读代码和内存脚本复现发现了 D-5(`parse` 不复制输入、`baseBuffer` 可改)、X-1(`setField` 可写入文件头,重新解析抛 `BAD_IDENT`)、F-3(`fieldSpan("constructor")` 返回 `NaN` 区间)、X-4(没有地图标记的裸 `SECTORS` 也可被 `setField` 写入)等缺陷,随后修复。**不得写成"属性测试捕获的 Bug":** 这些缺陷由人工核对和脚本复现发现,不是属性测试先发现的,所以不要写入"属性测试捕获的 Bug"表;只有当属性测试确实先于人工复现发现了某个缺陷时,才可以写入该表。只写已经发生的事,尚未实现或延后的事项(例如 D-8 的 CI)不写成已完成
    - `docs/decisions.md`:追加一节,标题格式沿用现有的 `## 日期:标题`,日期用执行当天的实际日期(必须晚于 2026-11-09,用 `Get-Date` 取得,不要凭空写);用现有的两列表格(`决定`、`原因`)记录七项决定:D-5(`parse` 复制输入,`original()` 返回副本,删除 `baseBuffer`)、X-1(`setField` 写入重叠头、目录或其他 Lump 时拒绝)、D-6(`ByteOverlay` 只经内部子路径提供,约定级隔离)、X-3 与 D-9(地图格式判定与作用域扩展,非 Doom 地图记录访问拒绝,只识别不解析)、D-1(`PLAYPAL` 不属于本 Spec,后续可选)、D-8(GitHub Actions、固定版本 Freedoom 加 SHA-256、`REQUIRE_FREEDOOM=1`,延后到 `wad-export` 之后)、决定 7 即 X-4(不属于任何地图作用域的记录 Lump 可读不可写:读取接口行为不变,`setField` 抛 `OUTSIDE_MAP_SCOPE`;原因是读取没有副作用而写入必须能证明目标属于一张已识别的 Doom 地图,作用域识别是名称启发式,误判方向是安全的)。每项的"原因"来自 `design.md`;状态如实写明(已实现、后续可选或延后)
    - 验收:`docs/kiro-usage.md` 的 Specs 表多出一行且"属性测试捕获的 Bug"表没有被改动(除非有真实事件);`docs/decisions.md` 新增一节,日期晚于 2026-11-09 且等于执行当天,表格格式与现有一致,表格中恰好有七项决定且包含决定 7(X-4);没有把延后或后续可选的事项写成已完成;`README.md` 未改动
    - 本任务只改 Markdown,不要求运行 `pnpm` 检查
    - _Requirements: 9.1_

- [ ] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 第一部分的任务已按现状标记为完成;它们不包含在下面的依赖图中。15.1、15.2、15.3 已完成(`[x]`),同样不在依赖图中。
- 带 `*` 的子任务是可选的,可以跳过。必需的任务是:10.1、10.2、10.3、10.4、11.1、11.2、13.11、13.15、13.17、15.12 和 15.13。其中 13.11 在"补测"一组里,但它是已决定的代码修复,所以不带 `*`;13.15、13.17 是用户要求本轮完成的第二批测试,同样不带 `*`。15.12(按已实现的行为同步 `requirements.md` 与 `design.md`)是必需的文档任务,排在全部必需代码任务之后、15.13 之前。13.10 保持可选(带 `*`),13.18(Property 14 的属性测试)保持可选,13.14 与 15.9 保持可选并已决定延后。
- **必需任务之间的依赖不经过任何可选任务**:选择"运行必需任务"时,依赖图的顺序是 10.1 → 10.2 → 10.4 → 10.3 → 13.11 → 13.15 → 13.17 → 11.1 → 11.2 → 15.12 → 15.13。
- **已删除的两个任务(依赖图中没有它们,其他任务也不再依赖或引用它们,下面的说明除外)**:
  - 原 14.2(决定 setField 是否要求 Lump 属于某个 MapScope,X-4)已由决定 7 取代,实现在 10.4,删除。任务编号不重排,所以第 14 节从 14.1 直接跳到 14.3。
  - 原 15.4(在 `requirements.md` 为 Requirement 10 补上前提,X-2)已并入 15.12(Requirement 13"写入重叠拒绝"与 Requirement 10 的修改),删除,原因是它是可选任务,而 15.12 现在是必需任务,必需任务不能依赖可选任务。第 15 节从 15.3 直接跳到 15.5。
- 任务名称、方法名、错误类名、错误码、子路径名、常量名沿用 `design.md` 的"设计阶段建议",**名称见 `design.md`,实施前可调整**。
- 每个会改 `.ts` 的任务,验收中都包含检查:`pnpm --filter @necrohex/core test`、`pnpm --filter @necrohex/adapter-wad test`、`pnpm --filter @necrohex/adapter-wad generate:check`、`pnpm -r typecheck`。
- 11.1 与 11.2 的内容按依赖关系安排:11.1 先建立 `MapScope.format` 和作用域扩展(X-3 的格式判定与 D-9),11.2 再让六个记录接口依据 `format` 拒绝(X-3 的拒绝部分),两者都改 `wad.ts`,所以串行。

### 实施顺序

1. **第一批**(波次 0 到 4,串行,因为都修改 `wad.ts`,其中 10.1 还改 `overlay.ts`,10.3 还改 `core` 的入口):10.1(D-5)→ 10.2(X-1)→ 10.4(X-4,决定 7)→ 10.3(D-6)→ 13.11(F-3)。10.4 紧随 10.2 之后;10.3 也改 `wad.ts`(只改导入),不得与 10.4 同一波次,两者的先后也可互换(10.1 → 10.2 → 10.3 → 10.4),互换时要同步修改依赖图。10.1、10.2、10.4 会改变 Property 1、2、3 的前提,在各自任务里调整测试。回归用例放在 `packages/adapter-wad/test/regression.test.ts`:D-5、X-1、X-4、D-6、F-3。
2. **第二批**(波次 5 到 6):13.15(必需,`mapWad` 产出合法 `THINGS`,I-2/I-3 覆盖 `Thing` 全部字段)→ 13.17(必需,`name8` 字段写入的属性测试);可选的 13.10(`Thing` 例子测试)与 13.15 同波次,二者改不同文件。第二批的属性以第一批完成后的新行为为准,包括 10.4:被写的 `THINGS`、`SECTORS` 必须在 Doom 地图作用域内,每次写入都被接受。
3. **第三批**(波次 7 到 8):11.1(`MapScope.format`、作用域扩展、UDMF 识别)→ 11.2(非 Doom 地图的记录接口抛 `UNSUPPORTED_MAP_FORMAT`)。只做格式判定,不解析 Hexen 或 UDMF 的记录。11.2 之后,10.4 的作用域规则自然收紧为"至少属于一个 Doom 作用域"。
4. **文档**(波次 9 到 10):15.12(同步 `requirements.md` 与 `design.md` 的状态,必需)→ 15.13(更新 `docs/kiro-usage.md` 与 `docs/decisions.md`,必需,依赖 15.12),在第一批、第二批和第三批全部完成之后执行,本次一并完成。
5. **其余补测和低优先级任务**(波次 9 到 17):保持原状(可选 `*`),按文件冲突分波次;14.1、14.3、14.4、14.8、14.9、14.10 仍需先得到用户的决定。这些任务不得与 15.13 同一波次改 `docs/decisions.md`:14.1、14.3、14.8、14.9、14.4 依次排在 15.13 之后的不同波次,彼此也不同波次。13.18(Property 14 的属性测试)与 15.12 同在波次 9。
6. **延后**(波次 18 到 19):13.14 与 15.9(决定 6,CI),`wad-export` 完成之后再做,本次不执行。
7. 决定 5(D-1)不在任何批次内:15.5 只改文档,本次不执行,`PLAYPAL` 的记录定义见下一节。

### 依赖图的约定

- 修改同一文件的任务被放在不同的波次(例如 `wad.ts`、`overlay.ts`、`regression.test.ts`、`roundtrip.test.ts`、`records.test.ts`、`scope.test.ts`、`freedoom.test.ts`、`arbitraries.ts`、`generate-records.ts`、`requirements.md`、`.kiro/specs/wad-roundtrip/design.md`、`docs/design.md`、`docs/kiro-usage.md`、`docs/decisions.md`)。其中改 `wad.ts` 的任务有 10.1、10.2、10.4、10.3、13.11、11.1、11.2(之后的可选任务 14.1、14.3、14.9),各占一个波次;改 `regression.test.ts` 的有 10.1、10.2、10.4、10.3、13.11、11.2、15.10,同样各占一个波次;15.12 是唯一改 `requirements.md` 与 Spec `design.md` 的任务。
- 14.4 会调整多个测试文件的导入,15.10 修改 `regression.test.ts`,15.11 修改所有属性测试文件,因此依次放在靠后的波次(14.4 → 15.5、15.10 → 15.11)。
- 13.13 依赖 14.6、14.7;13.15 依赖 10.1、10.2、10.4;13.5、13.6、13.17 依赖 13.15 的生成器(13.17 还依赖 10.4);13.4 依赖 11.1、11.2;13.18 依赖 10.2、10.4;15.11 依赖 13.18;15.9 依赖 13.14。
- **15.12 依赖全部必需的代码与测试任务**:10.1、10.2、10.3、10.4、11.1、11.2、13.11、13.15、13.17,不依赖任何可选任务(原先对 15.4 的依赖随 15.4 的删除消失)。**15.13 依赖 15.12。**

## 后续可选项(不属于本 Spec 的当前范围)

以下内容不是任务,不进入依赖图,本 Spec 不实施。

- **`PLAYPAL` 记录定义(D-1,已决定为后续可选)。** `PLAYPAL` 是 14 组 256 色的 RGB 调色板,共 10752 字节。若将来纳入,草案为:
  - 先给 `scripts/generate-records.ts` 增加一字节无符号类型 `uint8`,并让较大的 `count` 字段读出为 `readonly number[]`,而不是逐元素的元组类型;
  - 在 `spec/wad.records.yaml` 中新增记录 `Palette`:`lump: PLAYPAL`,`size: 768`,一个字段 `rgb`,类型 `uint8`,`count: 768`(256 色乘以 3 个字节);一个 `PLAYPAL` Lump 为 14 条 `Palette` 记录;
  - 可写性登记随 14.3 处理;`PLAYPAL` 的读取需要测试,Freedoom 夹具中的 `PLAYPAL` 仍要原样往返;
  - 先决条件:该工作启动前,在 `docs/decisions.md` 记录范围决定。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["10.1"] },
    { "id": 1, "tasks": ["10.2"] },
    { "id": 2, "tasks": ["10.4"] },
    { "id": 3, "tasks": ["10.3"] },
    { "id": 4, "tasks": ["13.11"] },
    { "id": 5, "tasks": ["13.10", "13.15"] },
    { "id": 6, "tasks": ["13.17"] },
    { "id": 7, "tasks": ["11.1"] },
    { "id": 8, "tasks": ["11.2"] },
    { "id": 9, "tasks": ["13.1", "13.2", "13.3", "13.4", "13.5", "13.6", "13.7", "13.8", "13.9", "13.18", "14.5", "14.6", "15.6", "15.12"] },
    { "id": 10, "tasks": ["13.12", "13.16", "14.7", "15.7", "15.13"] },
    { "id": 11, "tasks": ["13.13", "14.1", "14.10", "15.8"] },
    { "id": 12, "tasks": ["14.3"] },
    { "id": 13, "tasks": ["14.8"] },
    { "id": 14, "tasks": ["14.9"] },
    { "id": 15, "tasks": ["14.4"] },
    { "id": 16, "tasks": ["15.5", "15.10"] },
    { "id": 17, "tasks": ["15.11"] },
    { "id": 18, "tasks": ["13.14"] },
    { "id": 19, "tasks": ["15.9"] }
  ]
}
```
