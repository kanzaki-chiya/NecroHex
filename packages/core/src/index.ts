export * from "./span.ts";
export type {
  FieldKind,
  FieldValue,
  PatchIssue,
  PatchIssueCode,
  PlannedChange,
  ProposedChange,
  ProtectionHook,
  RecordAdapter,
  RecordLocator,
  RecordReader,
  RecordSchema,
  RecordScope,
  RecordSource,
  Selection,
  WriteOutcome,
} from "./patch/source.ts";
export type { Change, Condition, ConditionOp, Operation, Patch, Selector } from "./patch/validate.ts";
export type { Receipt } from "./patch/receipt.ts";
export type { ApplyOptions, ApplyResult, PlanResult, RevertResult } from "./patch/engine.ts";
export { applyPatch, bytesHash, patchHash, planPatch, revertPatch } from "./patch/engine.ts";
