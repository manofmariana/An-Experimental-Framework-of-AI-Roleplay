import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runDir } from "../config.js";
import { VarChangeSchema, type PipelineCurrent } from "./worldStore.js";
import { SAVE_SCHEMA_VERSION, incompatibleSave } from "./saveSchema.js";

export const ArchiveEntrySchema = z.object({
  seq: z.number(), kind: z.string(), result: z.unknown(), edited: z.boolean().optional(), var_changes: z.array(VarChangeSchema).optional(),
});
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;
export const ArchiveFileSchema = z.object({ schema_version: z.literal(SAVE_SCHEMA_VERSION), entries: z.array(ArchiveEntrySchema) });

export function buildArchiveEntry(current: PipelineCurrent | null): ArchiveEntry | null {
  if (current === null) return null;
  const entry: ArchiveEntry = { seq: current.seq, kind: current.kind, result: current.result, var_changes: current.var_changes ?? [] };
  if (current.edited === true) entry.edited = true;
  return entry;
}

export class ArchiveStore {
  private file: string; private entries: ArchiveEntry[];
  constructor(runId: string, baseDir?: string) {
    const dir = path.join(baseDir ?? runDir(runId)); fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, "archive.json");
    if (fs.existsSync(this.file)) {
      try { this.entries = ArchiveFileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8"))).entries; }
      catch (error) { throw incompatibleSave(error); }
    } else { this.entries = []; this.persist(); }
  }
  append(entry: ArchiveEntry): void { this.entries.push(ArchiveEntrySchema.parse(entry)); this.persist(); }
  readAll(): ArchiveEntry[] { return [...this.entries]; }
  truncateToSeq(targetSeq: number): void { this.entries = this.entries.filter((entry) => entry.seq <= targetSeq); this.persist(); }
  private persist(): void { fs.writeFileSync(this.file, JSON.stringify({ schema_version: SAVE_SCHEMA_VERSION, entries: this.entries }, null, 2) + "\n", "utf8"); }
}
