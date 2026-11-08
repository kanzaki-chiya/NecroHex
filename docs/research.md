# 竞品与待验证事项

调研日期：2026-11-09。这是一次定向搜索，“没有找到”不等于不存在，提交前要再查一次。

## 现有项目

| 类别 | 项目 | 能做什么 | 和 NecroHex 的关系 |
| :--- | :--- | :--- | :--- |
| WAD 库 | [crustywad](https://github.com/masriamir/crustywad) | 带类型的 WAD 读写、CLI、Diff、Freedoom 测试 | 底层能力接近，没有语义补丁 |
| WAD 工具 | [wad-tweak](https://github.com/selliott512/wad-tweak) | 按 Lump 查看和替换，输出尽量与输入一致 | 粒度是 Lump，不是字段和对象 |
| WAD 库 | [tinywad](https://github.com/theobori/tinywad) | Lump 级更新和重建 WAD | 粒度是 Lump |
| WAD 库 | [idchoppers](https://github.com/eevee/idchoppers) | 解析 WAD，目标包含错误检测，作者说明仍未完成 | 部分可玩性检查的目标相近 |
| Doom MCP | [zandronum-mcp](https://glama.ai/mcp/servers/rc4l/ZandronumMCP) | 控制引擎、调试脚本、只读地图分析 | 面向调试，不提供安全的 WAD 写入补丁 |
| Doom MCP | [doom-mcp](https://github.com/arthurjdam/doom-mcp) | 让 LLM 玩游戏 | 方向不同 |
| 二进制 Schema | [Kaitai Struct v0.11](https://kaitai.io/news/2025/09/07/kaitai-struct-v0.11-released.html) | 已支持 Java 和 Python 序列化 | 不能再称其只读；它不提供可重放的语义补丁 |
| 二进制 Schema | [EByte](https://ebyte.org/about/) | 单一 Schema 读写、无损往返、字段级比较 | Schema 能力重叠，所以我们不主打通用框架 |
| 二进制 Schema | [RaE](https://github.com/xeonds/RaE) | 声明式查询、修改、构造二进制 | 表达能力重叠，没有重定位和 AI 护栏 |
| 补丁工具 | [bytepatch](https://github.com/raehik/bytepatch) | 声明式原地补丁，能检查原数据 | 按偏移定位，不感知语义 |

这几轮搜索没有找到同时具备规则型跨地图补丁、语义重定位和 AI 写入护栏的 WAD 工具。

SLADE、Ultimate Doom Builder 等主流编辑器的脚本能力还没有逐项核对，这是下一次调研的重点。

## 待验证事项

| 问题 | 怎么验证 | 期限 | 影响 |
| :--- | :--- | :--- | :--- |
| Freedoom 是否包含所需贴图和 Thing | 用解析结果直接查询 | 11-12 | 决定演示效果 |
| 哪个开源引擎适合做无窗口冒烟测试 | 实际运行 | 11-12 | 决定 `verify_output` 的实现 |
| 真实版本之间是否存在下标漂移 | 对比两个 Freedoom 发行版 | 11-17 | 决定重定位是否作为演示重点 |
| WAD 作者是否真的需要可重放补丁 | 在社区询问或看历史讨论 | 11-28 | 决定影响力叙事 |
| 主流编辑器是否已有类似脚本能力 | 查文档 | 11-17 | 决定差异点表述 |
| 视频和页面如何提及游戏名称才符合规则 | 必要时询问 Hackathon Manager | 11-28 | 避免商标风险 |
