import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runDir } from "../config.js";
import { EventSchema, knownByTag, type Event } from "../types.js";
import { SAVE_SCHEMA_VERSION, incompatibleSave } from "./saveSchema.js";

const EventsFileSchema = z.object({ schema_version: z.literal(SAVE_SCHEMA_VERSION), events: z.array(EventSchema) });
export function truncateEvents(events: Event[], targetSeq: number): Event[] { return events.filter((event) => event.seq <= targetSeq); }

export class EventsStore {
  private file: string; private events: Event[];
  constructor(runId: string, baseDir?: string) {
    const dir = path.join(baseDir ?? runDir(runId)); fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, "events.json");
    if (fs.existsSync(this.file)) {
      try { this.events = EventsFileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8"))).events; }
      catch (error) { throw incompatibleSave(error); }
    } else { this.events = []; this.persist(); }
  }
  append(event: Event): void { this.events.push(EventSchema.parse(event)); this.persist(); }
  readAll(): Event[] { return [...this.events].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id)); }
  readWindow(n: number): Event[] { const all = this.readAll(); return all.slice(Math.max(0, all.length - n)); }
  readVisibleTo(observerCid: string, at: number): Event[] { const tag = knownByTag(observerCid); return this.readAll().filter((event) => event.t <= at && event.tags.includes(tag)); }
  truncateToSeq(targetSeq: number): void { this.events = truncateEvents(this.events, targetSeq); this.persist(); }
  /** 整体替换事件表（状态栏直接编辑用）：先全量校验，失败抛错不落盘。 */
  replaceAll(events: unknown): void { this.events = z.array(EventSchema).parse(events); this.persist(); }
  private persist(): void { fs.writeFileSync(this.file, JSON.stringify({ schema_version: SAVE_SCHEMA_VERSION, events: this.events }, null, 2) + "\n", "utf8"); }
}
