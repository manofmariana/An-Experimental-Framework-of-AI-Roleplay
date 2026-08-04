import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SAVE_SCHEMA_VERSION } from "./saveSchema.js";

export const TimeAnchorSchema = z.object({
  y: z.number().int().min(1), m: z.number().int().min(1).max(12), d: z.number().int().min(1).max(35),
  h: z.number().int().min(0).max(23), min: z.number().int().min(0).max(59),
});
export type TimeAnchor = z.infer<typeof TimeAnchorSchema>;
export const TimePeriodSchema = z.object({ key: z.string(), from: z.number(), to: z.number() });
export type TimePeriod = z.infer<typeof TimePeriodSchema>;
export const TimeFileSchema = z.object({
  schema_version: z.literal(SAVE_SCHEMA_VERSION), start: TimeAnchorSchema, periods: z.array(TimePeriodSchema),
});
export type TimeFile = z.infer<typeof TimeFileSchema>;
export const WorldTimeConfigSchema = z.object({ start: TimeAnchorSchema, periods: z.array(TimePeriodSchema) });
export type WorldTimeConfig = z.infer<typeof WorldTimeConfigSchema>;

export const DEFAULT_TIME_FILE: TimeFile = {
  schema_version: SAVE_SCHEMA_VERSION,
  start: { y: 1, m: 1, d: 1, h: 6, min: 0 },
  periods: [{ key: "白天", from: 6, to: 18 }, { key: "夜晚", from: 18, to: 6 }],
};

export function worldTimeToMinutes(time: TimeAnchor): number {
  return ((((time.y - 1) * 365 + (time.m - 1) * 30 + (time.d - 1)) * 24 + time.h) * 60) + time.min;
}

export function minutesToWorldTime(totalMinutes: number): TimeAnchor {
  let value = Math.max(0, Math.floor(totalMinutes));
  const min = value % 60; value = Math.floor(value / 60);
  const h = value % 24; value = Math.floor(value / 24);
  const y = Math.floor(value / 365) + 1;
  const dayOfYear = value % 365;
  // 每年 12 月承接 30 日月制余下的 5 天，避免产生第 13 月。
  const m = Math.min(12, Math.floor(dayOfYear / 30) + 1);
  const d = dayOfYear - (m - 1) * 30 + 1;
  return { y, m, d, h, min };
}

export function loadWorldTime(worldDir: string): WorldTimeConfig {
  const file = path.join(worldDir, "time.json");
  if (!fs.existsSync(file)) return { start: DEFAULT_TIME_FILE.start, periods: DEFAULT_TIME_FILE.periods };
  return WorldTimeConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function renderTimeHeader(time: TimeAnchor, data: Pick<TimeFile, "periods">): string {
  const hour = time.h + time.min / 60;
  const period = data.periods.find((p) => p.from <= p.to ? hour >= p.from && hour < p.to : hour >= p.from || hour < p.to);
  const date = `${time.y}年${time.m}月${time.d}日`;
  return period === undefined ? date : `${date}·${period.key}`;
}

/** time.json 档内副本容器（纯内存，无 IO）：落盘由 GenerationRepository 在步边界整代提交（存档 v6）。 */
export class TimeStore {
  private data: TimeFile;

  constructor(data: TimeFile) {
    this.data = JSON.parse(JSON.stringify(data)) as TimeFile;
  }

  /** 整代提交的写盘数据源（time.json 信封）。 */
  saveData(): TimeFile { return this.data; }
  /** 数据整体替换（错误再同步用：对象身份保持，内容回到指定 Generation）。 */
  restoreData(data: TimeFile): void { this.data = JSON.parse(JSON.stringify(data)) as TimeFile; }
  get(): TimeFile { return this.data; }
  render(time: TimeAnchor): string { return renderTimeHeader(time, this.data); }
}
