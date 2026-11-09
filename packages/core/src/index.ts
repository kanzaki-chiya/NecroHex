export * from "./span.ts";
export type {
  CheckInfo,
  CheckResult,
  FieldKind,
  FieldValue,
  FingerprintProblem,
  PatchIssue,
  PatchIssueCode,
  PinResolution,
  PlannedChange,
  ProposedChange,
  ProtectionHook,
  RecordAdapter,
  RecordFingerprints,
  RecordLocator,
  RecordReader,
  RecordSchema,
  RecordScope,
  RecordSource,
  RelocationCandidate,
  Selection,
  StructuralCheck,
  WriteOutcome,
  WriteRejection,
} from "./patch/source.ts";
export type { Change, Condition, ConditionOp, Operation, Patch, Selector } from "./patch/validate.ts";
export type { Receipt } from "./patch/receipt.ts";
export type { ApplyOptions, ApplyResult, PlanResult, RevertResult } from "./patch/engine.ts";
export { applyPatch, bytesHash, patchHash, planPatch, revertPatch } from "./patch/engine.ts";
export type { RelocationThresholds } from "./patch/relocate.ts";
export { RELOCATION_THRESHOLDS } from "./patch/relocate.ts";
