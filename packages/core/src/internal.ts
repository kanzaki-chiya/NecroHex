/**
 * 内部入口（@necrohex/core/internal）：只供 adapter-wad 和后续的补丁引擎使用。
 * ByteOverlay.write 接收裸偏移和字节，不属于公开 API，所以不从 index.ts 导出。
 * 这是约定级隔离：任何依赖 @necrohex/core 的包在技术上都能解析这个子路径。
 * 写回通道只经这里提供两个类型和 registerRestorer；lookupRestorer 不经任何入口。
 */
export * from "./overlay.ts";
export type { RestorableOpener, RestorableRecordSource } from "./patch/restorable.ts";
export { registerRestorer } from "./patch/restorable.ts";
