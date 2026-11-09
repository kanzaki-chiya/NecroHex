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

pin 重定位（`docs/design.md` 第 7 节）按用户要求没有写 Spec，直接在对话中实现。它改变了 patch-engine Spec 的 Property 3 和 Property 5，所以在 `.kiro/specs/patch-engine/design.md` 的这两条属性下注明了变化，没有改写原文。

## Hooks

| Hook | 触发条件 | 动作 | 拦下过什么 |
| :--- | :--- | :--- | :--- |
| Regenerate WAD records（`.kiro/hooks/regenerate-records.json`） | PostFileSave，路径匹配 `wad\.records\.yaml$` | `pnpm --filter @necrohex/adapter-wad generate` | 还没有拦下过问题。会触发（生成文件被重写，见下面的验证）；输出没有回到 Agent，IDE 里是否显示结果未确认 |
| Typecheck on save（`.kiro/hooks/typecheck-on-save.json`） | PostFileSave，路径匹配 `packages[\\/][^\\/]+[\\/]src[\\/].*\.ts$` | `pnpm -r typecheck` | 还没有拦下过问题。会触发，但输出没有回到 Agent，IDE 里是否显示报错未确认（见下面的验证）。matcher 也匹配 `src/generated/records.ts`，不匹配 `test/` 和 `scripts/` |

两个 Hook 都是在实现写入护栏的会话里用 Kiro 的 createHook 创建的，Kiro 提示下次会话开始才生效。

### 2026-11-09 新会话里的验证

两个 Hook 创建后的第一个新会话里各测了一次。Agent 通过工具保存文件，Hook 的输出没有出现在 Agent 的工具结果里，所以是否触发是用旁证判断的。

| Hook | 做了什么 | 结果 |
| :--- | :--- | :--- |
| Typecheck on save | 在 `packages/core/src/span.ts` 的 `spanLength` 里加 `const hookProbe: number = "not a number";` 并保存。第一次（先 `str_replace`，再整文件写入）没有观察进程；第二次保存前先启动一个每 0.3 秒列一次进程的脚本 | 第一次：Agent 这边看不到任何 Hook 输出，也没有旁证，无法判断是否触发。第二次：保存之前的采样里没有相关进程，保存之后（10:18:38）出现了 `cmd.exe /d /s /c "pnpm -r typecheck"` 和两个 `tsc -p tsconfig.json` 进程，约 1 秒后消失，说明 Hook 触发了。Hook 自己的输出和退出码 Agent 看不到，IDE 里是否显示了报错没有确认；在同一状态下手动运行 `pnpm --filter @necrohex/core typecheck`，报 `src/span.ts(12,9): error TS2322`，退出码非零。之后用 `git checkout -- packages/core/src/span.ts` 恢复，这个错误没有提交 |
| Regenerate WAD records | 在 `packages/adapter-wad/spec/wad.records.yaml` 的头部注释里加一行 `# hook probe` 并保存，再删掉这一行并保存 | 触发了：`src/generated/records.ts` 的修改时间从 09:41:53 变为 10:17:51（第一次保存），恢复时又变为 10:19:19。生成脚本每次都会写文件，文件内容没有变化（`git status` 只显示 yaml 有改动，恢复后工作区干净）。进程列表脚本没有抓到这次的进程，可能是生成太快，在两次采样之间结束了 |

两个 Hook 创建时把 `timeout` 写在了 `action` 里。2026-11-09 查 [Kiro 文档的 Hook file schema](https://kiro.dev/docs/hooks.md)，字段表列的是 `hooks[].timeout`（单位为秒，默认 60），于是把它移到 `hooks[]` 这一层，数值不变（120 和 180）。之前写在 `action` 里时 Kiro 是否按默认的 60 秒处理，没有验证。

## Steering

| 文件 | 起了什么作用 | 真实案例 |
| :--- | :--- | :--- |
| | | |

## MCP

| 工具 | 在开发中如何使用 |
| :--- | :--- |
| NecroHex 自己的 MCP Server（`packages/mcp-server`） | 2026-11-09 实现。Agent 想写 `.kiro/settings/mcp.json` 时被这个环境的权限规则拦下（拒绝写 `.kiro/settings/`），Agent 没有绕过，改为提交 `packages/mcp-server/mcp.example.json`，由用户复制。到这次会话结束为止，Kiro 里还没有加载这个服务器，也没有在 Kiro 对话里真实调用过它的工具：Kiro 端到端没有跑通。服务器本身用官方 SDK 的 stdio 客户端测过（`packages/mcp-server/test/stdio.test.ts`，在配置了引擎的环境里 10 个用例全部通过）。2026-11-10 放好 `.kiro/settings/mcp.json` 后，Kiro 加载了服务器，端到端流程在 Kiro 对话里跑通，见下面的调用记录 |

### Kiro 端到端调用记录

#### 2026-11-10 第一次端到端

`.kiro/settings/mcp.json` 已按 `packages/mcp-server/mcp.example.json` 放好（内容相同）。在一个新会话里，Kiro 加载了 `necrohex` 的五个工具（`inspect_wad`、`query_entities`、`plan_patch`、`apply_patch`、`verify_output`），整个流程只用这些工具完成，没有用命令行或脚本代替。六步全部成功，没有失败的调用。下面按调用顺序记录参数和结果摘要。路径都相对仓库根目录，`freedoom2.wad` 指 `packages/adapter-wad/fixtures/cache/freedoom2.wad`。

1. **`inspect_wad`**，参数 `{ path: freedoom2.wad }`。结果：`IWAD`，sha256 `a8772e08…0ecd4b`，28 787 748 字节，3610 个 Lump，32 张地图（MAP01–MAP32，均为 doom 格式）。MAP01 有 Sector 211、Thing 200、Linedef 1274、Sidedef 2041、Vertex 1189。可写记录只有 Sector 和 Thing。

2. **`query_entities`**，调用了三次。
   - 查出生点：`{ path: freedoom2.wad, maps: ["MAP01"], select: { record: "Thing", where: { type: { in: [1, 2, 3, 4, 11] } } } }`。结果 14 条：玩家 1–4 出生点是 #0–#3，位于 (-192, -192)、(-192, -240)、(-192, -144)、(-192, -96)；另有 10 个死亡竞赛出生点（#52、#65、#68、#69、#71、#73、#119、#132、#139、#159）。
   - 查扇区：`{ …, select: { record: "Sector", where: { special: { eq: 0 }, tag: { eq: 0 } } }, limit: 5, includeFingerprint: true }`。结果 total 173，返回 5 条，truncated。#0 的 bbox 是 [-224, -288, -32, 32]，四个玩家出生点都在里面；`patches/haunted-house.nhpatch.json` 也把 #0 当作出生房间。#2 的天花板是 `F_SKY1`，是室外区域，所以没有选它。
   - 缩小到室内：`{ …, where: { special: { eq: 0 }, tag: { eq: 0 }, ceilingpic: { ne: "F_SKY1" }, lightlevel: { lte: 192 } }, fields: [7 个字段], limit: 12, includeFingerprint: true }`。结果 total 100，返回 12 条，truncated。

   选了 **MAP01 Sector #12**。它的天花板是 `AQF057`，是室内房间；面积 20480，10 条线；bbox [224, 64, 480, 288] 里没有任何玩家出生点或死亡竞赛出生点，和出生扇区 #0 的 bbox 不相交，所以两者不相邻。`special` 和 `tag` 都是 0，不是门、升降机或触发目标。第 4 步的 pin 结果里只有它一个候选，说明它的指纹和别的扇区不撞。这次只是按 bbox 判断出生点不在里面，工具不做点在多边形内的判断。

3. **补丁**直接以 JSON 对象传给工具，没有存成文件：

   ```json
   {
     "schemaVersion": 1,
     "name": "Kiro E2E",
     "target": { "format": "wad", "maps": ["MAP01"] },
     "operations": [{
       "id": "glow-room-map01-12",
       "select": {
         "record": "Sector",
         "pin": {
           "map": "MAP01",
           "expectedIndex": 12,
           "fingerprint": {
             "tag": 0, "floorpic": "AQF024", "ceilingpic": "AQF057",
             "heights": [-32, 64], "centroid": [352, 147],
             "bbox": [224, 64, 480, 288], "area": 20480, "lineCount": 10
           }
         }
       },
       "change": { "floorpic": { "set": "FLOOR5_2" }, "special": { "set": 8 } }
     }]
   }
   ```

   `special` 8 是灯光呼吸（glow）特效。补丁格式里 `pin` 不能再加 `where` 条件。“原特效必须是 0”这一条由默认开启的护栏 `sector-special-nonzero` 保证：补丁没有 opt-in，如果原值不是 0，plan 会被拒绝。

4. **`plan_patch`**，参数 `{ inputPath: freedoom2.wad, iwadPath: freedoom2.wad, patch: <上面的补丁> }`。结果 `status: ready`，planId `plan-a755eb66…cd902373`，patchHash `sha256:78095e30…6edb907`，匹配 1 条，改动 2 个字段，没有 warning 和 issue，15 项检查全部 passed（其中包括 `sector-special-nonzero` 和 `flat-exists`）。
   - pin：`EXACT: #12 matches its fingerprint (score 1)`，expectedIndex 12 → index 12，fingerprintChecked true，只有 1 个候选，needsReview false。
   - 字段 Diff：

     | 记录 | 字段 | 旧值 | 新值 |
     | :--- | :--- | :--- | :--- |
     | MAP01 Sector #12 | `floorpic` | `AQF024` | `FLOOR5_2` |
     | MAP01 Sector #12 | `special` | 0 | 8 |

5. **`apply_patch`**，参数 `{ inputPath: freedoom2.wad, iwadPath: freedoom2.wad, patch: <同一补丁>, planId: <第 4 步的 planId>, outputPath: "out/kiro-e2e.wad" }`。结果 `status: applied`，写出 `out/kiro-e2e.wad`（sha256 `8e1077f2…b5f74`）和 `out/kiro-e2e.receipt.json`。回执有 2 条记录，outputHash `5bb222ea…cbc953`，输入文件未改动。PWAD 包含 MAP01 的标记和全部 10 个数据 Lump，3 项导出检查通过。

   结果里 `maps[0].modified` 是 `false`，可实际上 MAP01 的 SECTORS 改了两个字段（第 6 步的 `pwad-maps` 确认 PWAD 的数据和补丁后的 WAD 一致）。原因是 `packages/cli/src/ops.ts` 先把输出重新解析成新的 `WadFile`，再交给 `exportPwad`，新对象的 `dirtySpans()` 是空的，所以这个标志永远是 `false`。写出的字节没有问题，错的只是报告里的这个字段。这次没有修。

6. **`verify_output`**，参数 `{ inputPath: freedoom2.wad, outputPath: "out/kiro-e2e.wad", receiptPath: "out/kiro-e2e.receipt.json", iwadPath: freedoom2.wad }`。结果 `status: passed`，`verified: true`。
   - `receipt-input-hash`、`receipt-replay`、`locality (I-3)`、`revert (I-4)`、`pwad-maps` 都是 passed；`full-output-hash` 是 skipped，因为没有传 `fullOutputPath`。
   - 引擎真的运行了：`engine.status: passed`，路径 `%LOCALAPPDATA%\necrohex\engines\dsda-doom-0.30.1\dsda-doom-0.30.1-win-x64\dsda-doom.exe`，source `default`。MAP01 跑了 350 tic，60 秒内结束，退出码 0。
   - 工具自己注明，这些检查不说明地图能通关。
   - 之后进游戏确认：#12 的地板确实变成了 `FLOOR5_2`，但 `special` 8 看不出效果，因为相邻的 #13、#15 亮度都是 255，比 #12 的 160 高。

`out/` 被 `.gitignore` 忽略，输出文件没有提交。

### 给用户的操作步骤（2026-11-09 更新）

1. 把 `packages/mcp-server/mcp.example.json` 复制为 `.kiro/settings/mcp.json`，保存。按 Kiro 文档，保存后服务器会自动重连，不需要重启。配置里没有 `env`，不需要批准任何环境变量，也不需要设置 `NECROHEX_ENGINE`。
2. 在 Kiro 面板的 MCP servers 里确认 `necrohex` 已连接；没有连上就右键选 Reconnect，或用 Show MCP Logs 查看。日志第一行写明工作区和引擎，例如 `ready; workspace X:\NecroHex (from pnpm-workspace.yaml); engine %LOCALAPPDATA%\necrohex\engines\…\dsda-doom.exe (from default; …)`。
3. 开一个新会话，让 Agent 按上面的流程调用。

配置为什么是这样：

- **工作区根目录**：Kiro 的 `mcp.json` 只支持 `${VAR}` 形式的环境变量展开（需要先批准），文档里没有工作区路径变量（查的是 [MCP configuration](https://kiro.dev/docs/mcp/configuration.md)）。所以配置里不设 `NECROHEX_WORKSPACE`。服务器没有 `NECROHEX_WORKSPACE` 时，从入口文件 `packages/mcp-server/src/main.ts` 所在目录向上找 `pnpm-workspace.yaml`，把它所在目录（仓库根目录）当作工作区，不用启动时的当前目录。
- **入口文件**：`args` 里的 `packages/mcp-server/src/main.ts` 仍是相对路径。它依赖 Kiro 文档写明的“服务器以第一个工作区根文件夹为当前目录启动”（[多根工作区](https://kiro.dev/docs/ide/editor/multi-root-workspaces.md)）。如果 Kiro 换了启动目录，服务器根本起不来，MCP 日志里会看到找不到模块，而不是用错工作区。
- **引擎**：没有 `NECROHEX_ENGINE` 时，`verify_output` 使用默认安装位置 `%LOCALAPPDATA%\necrohex\engines\dsda-doom-0.30.1\dsda-doom-0.30.1-win-x64\dsda-doom.exe`；那里没有引擎时返回“引擎未运行”，状态为 `incomplete`，不算通过。结果的 `engine.path` 和 `engine.source` 写明实际用的路径和来源。

## 属性测试捕获的 Bug

| 日期 | 不变量 | 触发样本 | 根因 | 修复提交 |
| :--- | :--- | :--- | :--- | :--- |
| 2026-11-09 | patch-engine Property 3（I-4 的 `set` 幂等） | 生成样本，缩减 6 次：`op0` 选 `where x ne -202 且 angle 在 [-202, 0]` 改 `flags`，`op1` 选 `all` 把 `x` 设为 23402。第一次应用 `op0` 匹配 0 条，对输出再应用匹配 1 条，`flags` 被改 | 不是引擎缺陷。选择器按当前输入求值，后一操作读取前一操作写入的字段时，第二次会选中新记录，属性本身写得过宽 | 未改引擎。design.md 的 Property 3 加上"没有跨操作读取"的前提，测试相应过滤；回归用例 `P3-1`。与 patch-engine 实现同一次提交 |
| 2026-11-09 | patch-engine Property 3（I-4 的 `set` 幂等） | Freedoom 夹具，缩减 24 次：`pin MAP01 #0`，`special` 设为 1、`tag` 设为 -32768。再应用时报 `PROTECTED` | `sector-special-nonzero` 按规则拦截"旧值非零"的 `special`，第一次写入的 1 在第二次就是旧值 | 保护不放宽。Property 3 改为：未 opt-in 时只允许这条 `PROTECTED`，opt-in 后结果与第一次相同；回归用例 `P3-2`。与 patch-engine 实现同一次提交 |
| 2026-11-09 | patch-engine Property 3（I-4 的 `set` 幂等），加入 pin 重定位之后 | 生成样本，缩减后：E1M1 #1 的 `pin` 带该扇区的真实指纹，同一操作把 `ceilingheight` 设为 32767、`tag` 设为 0。第一次 `EXACT`；对输出再应用时为 `CONFLICT_AMBIGUOUS` | 不是引擎缺陷。补丁改了 pin 自己指纹里的字段，输出里的扇区已不再符合指纹，相似度 0.8 低于 0.85，按规则拒绝 | 引擎不放宽。Property 3 的前提加上“带指纹的 pin 不读取补丁写入的指纹字段”，`.kiro/specs/patch-engine/design.md` 的 Property 3 相应注明；回归用例 `P3-3`。与重定位实现同一次提交 |

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
