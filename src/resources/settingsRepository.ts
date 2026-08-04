/**
 * 用户设置仓储。
 *
 * data/<username>/settings.json 读写：UserSettings（proseWindowTurns/gmIntervalCycles/
 * pauseOptions/agentPresets/configRevision）。缺文件 = 默认空设置（configRevision 0）；
 * 损坏抛 SettingsRepositoryError（稳定 code，HTTP 层负责映射）；写入 = .tmp → rename
 * 原子替换，写前过 UserSettingsSchema。
 *
 * 全部函数显式接收路径参数（组成根经 UserDirectories 注入），本模块不 import config。
 * 依赖方向：resources → contracts（依赖审计守护）。
 */
import fs from "node:fs";
import path from "node:path";
import { UserSettingsSchema, type UserSettings } from "../contracts/config.js";

/** 仓储错误码（HTTP 映射：SETTINGS_CORRUPT→500）。 */
export type SettingsErrorCode = "SETTINGS_CORRUPT";

export class SettingsRepositoryError extends Error {
  constructor(
    public readonly code: SettingsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SettingsRepositoryError";
  }
}

/** 读 settings.json；缺文件 = 默认空设置；JSON 损坏/契约不符 → SETTINGS_CORRUPT。 */
export function readSettings(settingsFile: string): UserSettings {
  if (!fs.existsSync(settingsFile)) return UserSettingsSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch {
    throw new SettingsRepositoryError("SETTINGS_CORRUPT", `settings.json 不是合法 JSON: ${settingsFile}`);
  }
  const result = UserSettingsSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(顶层)"}: ${issue.message}`)
      .join("；");
    throw new SettingsRepositoryError("SETTINGS_CORRUPT", `settings.json 契约校验失败：${issues}`);
  }
  return result.data;
}

/** 原子写 settings.json（先过契约校验，非法形状不落盘；.tmp → rename 替换）。 */
export function writeSettings(settingsFile: string, settings: UserSettings): void {
  const data = UserSettingsSchema.parse(settings);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const tmp = `${settingsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, settingsFile);
}
