/**
 * 写回通道：撤销流程把 Receipt 中的旧值写回字段的唯一途径。
 * 登记表模块私有，只能登记、不能经任何入口取回；lookupRestorer 只由 engine.ts 导入。
 */
import type { FieldValue, RecordAdapter, RecordLocator, RecordSource, WriteOutcome } from "./source.ts";

export interface RestorableRecordSource extends RecordSource {
  /** 写回旧值，只做类型域检查；只读、作用域和结构检查与 writeField 相同。 */
  restoreField(loc: RecordLocator, field: string, value: FieldValue): WriteOutcome;
}

export type RestorableOpener = (input: Uint8Array) => RestorableRecordSource;

const restorers = new WeakMap<RecordAdapter, RestorableOpener>();

/** 同一 adapter 只接受首次登记，之后再登记抛错。 */
export function registerRestorer(adapter: RecordAdapter, opener: RestorableOpener): void {
  if (typeof opener !== "function") throw new TypeError("registerRestorer: opener must be a function");
  if (restorers.has(adapter)) throw new Error(`a restorer is already registered for adapter ${String(adapter.format)}`);
  restorers.set(adapter, opener);
}

export function lookupRestorer(adapter: RecordAdapter): RestorableOpener | undefined {
  return restorers.get(adapter);
}
