import { z } from "zod";
import { EventSchema, type Event } from "../types.js";

/** events.json 文件 codec（schema_version 单点化后本文件不再盖章）。 */
export const EventsFileSchema = z.object({ events: z.array(EventSchema) });
export type EventsFile = z.infer<typeof EventsFileSchema>;
export function truncateEvents(events: Event[], targetSeq: number): Event[] {
  return events.filter((event) => event.seq.value <= targetSeq);
}

/**
 * 事件 ID 水位：扫描 `evt_(\d+)` 最大数字后缀（无匹配归 0；非标准格式 id 忽略）。
 * 新事件 ID 分配必须用水位而非数组长度——删中段事件/直编事件表后长度会失真，
 * 水位保证续档/回溯/直编后新 ID 不与现存冲突。
 */
export function scanEventWatermark(events: readonly Event[]): number {
  let max = 0;
  for (const event of events) {
    const match = /^evt_(\d+)$/.exec(event.id.value);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * 事件日志容器（纯内存，无 IO；落盘由 GenerationRepository 在步边界整代提交）。
 * 只留存储语义：可见性/时间过滤已移交引擎（投影全量供给 + 逐末端 TAG 过滤），
 * 本容器不做读者求值。
 */
export class EventsStore {
  private events: Event[];
  constructor(events: Event[] = []) {
    this.events = JSON.parse(JSON.stringify(events)) as Event[];
  }
  /** 整代提交的写盘数据源（events.json 的 events 载荷，保持追加序）。 */
  saveData(): Event[] { return this.events; }
  /** 数据整体替换（错误再同步用：对象身份保持，内容回到指定 Generation）。 */
  restoreData(events: Event[]): void { this.events = JSON.parse(JSON.stringify(events)) as Event[]; }
  /** 追加（容器级替换：live 数据 commit 后恒冻结，不得原地 push）。 */
  append(event: Event): void { this.events = [...this.events, EventSchema.parse(event)]; }
  readAll(): Event[] { return [...this.events].sort((a, b) => a.t.value - b.t.value || a.id.value.localeCompare(b.id.value)); }
  /** 正文滑窗取数范围截取（投影供给侧的窗口，不是过滤）。 */
  readWindow(n: number): Event[] { const all = this.readAll(); return all.slice(Math.max(0, all.length - n)); }
  truncateToSeq(targetSeq: number): void { this.events = truncateEvents(this.events, targetSeq); }
  /** 整体替换事件表（状态直编用）：先全量校验，失败抛错不变更。 */
  replaceAll(events: unknown): void { this.events = z.array(EventSchema).parse(events); }
}
