import { z } from "zod";
import { StepChangesSchema, emptyStepChanges, type PipelineCurrent } from "./worldStore.js";
import { SAVE_SCHEMA_VERSION } from "./saveSchema.js";

export const ArchiveEntrySchema = z.object({
  seq: z.number(), kind: z.string(), result: z.unknown(), edited: z.boolean().optional(), changes: StepChangesSchema.optional(),
});
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;
export const ArchiveFileSchema = z.object({ schema_version: z.literal(SAVE_SCHEMA_VERSION), entries: z.array(ArchiveEntrySchema) });
export type ArchiveFile = z.infer<typeof ArchiveFileSchema>;

export function buildArchiveEntry(current: PipelineCurrent | null): ArchiveEntry | null {
  if (current === null) return null;
  const entry: ArchiveEntry = { seq: current.seq, kind: current.kind, result: current.result, changes: current.changes ?? emptyStepChanges() };
  if (current.edited === true) entry.edited = true;
  return entry;
}

/** 步骤归档容器（纯内存，无 IO）：落盘由 GenerationRepository 在步边界整代提交（存档 v7）。 */
export class ArchiveStore {
  private entries: ArchiveEntry[];
  constructor(entries: ArchiveEntry[] = []) {
    this.entries = JSON.parse(JSON.stringify(entries)) as ArchiveEntry[];
  }
  /** 整代提交的写盘数据源（archive.json 的 entries 载荷）。 */
  saveData(): ArchiveEntry[] { return this.entries; }
  /** 数据整体替换（错误再同步用：对象身份保持，内容回到指定 Generation）。 */
  restoreData(entries: ArchiveEntry[]): void { this.entries = JSON.parse(JSON.stringify(entries)) as ArchiveEntry[]; }
  /** 追加（容器级替换：live 数据 commit 后恒冻结，不得原地 push）。 */
  append(entry: ArchiveEntry): void { this.entries = [...this.entries, ArchiveEntrySchema.parse(entry)]; }
  readAll(): ArchiveEntry[] { return [...this.entries]; }
  truncateToSeq(targetSeq: number): void { this.entries = this.entries.filter((entry) => entry.seq <= targetSeq); }
}
