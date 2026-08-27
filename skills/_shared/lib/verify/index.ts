// index.ts — public surface of the admission gate module.
export * from "./types.ts";
export { verifyEntity, verifyAll, verifyPack, VerifyUsageError, MODULES, kindFromAlias, type VerifyOptions, type BatchOptions, type Emitter } from "./runner.ts";
export { renderReport, renderBatch, countFindings, exitCodeFor, type BatchReport } from "./report.ts";
export { loadBaseline, recordBaseline, applyBaseline, debtOf, importLegacy, defaultBaselinePath, writeBaseline, type Baseline, type RecordResult } from "./baseline.ts";
export { createBackup, restoreBackup, listBackups, prune, withBackup, defaultBackupRoot, BACKUP_KEEP } from "./backup.ts";
export { mindCloneModule, criteria as mindCloneCriteria, measureDnaSchema, countLayerItems, CANONICAL_ARTIFACTS } from "./kinds/mind-clone.ts";
export { squadModule } from "./kinds/squad.ts";
export { businessModule } from "./kinds/business.ts";
