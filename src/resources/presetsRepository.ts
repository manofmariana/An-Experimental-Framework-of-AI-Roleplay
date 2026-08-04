/**
 * API 预设仓储。
 *
 * data/<username>/api-presets/{id}.json 逐文件存储：list/load/save/delete/duplicate。
 * preset 引用 secretKind + 可选 secretId，不复制 API key（明文只在 secrets.json）。
 * id 一律先过 safeSegment 防目录穿越（非法 → INVALID_PRESET_ID）；载荷经
 * ApiPresetSchema 校验；文件内 id 与文件名不一致视为损坏（PRESET_CORRUPT）。
 * 写入 = .tmp → rename 原子替换。
 *
 * 全部函数显式接收 presetsDir（组成根经 UserDirectories 注入），本模块不 import config。
 * 依赖方向：resources → shared / contracts（依赖审计守护）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeSegment } from "../shared/safeSegment.js";
import { ApiPresetSchema, type ApiPreset } from "../contracts/config.js";

/** 仓储错误码（HTTP 映射：PRESET_NOT_FOUND→404，PRESET_CORRUPT→500，INVALID_PRESET_ID/INVALID_PRESET→400）。 */
export type PresetsErrorCode =
  | "PRESET_NOT_FOUND"
  | "PRESET_CORRUPT"
  | "INVALID_PRESET_ID"
  | "INVALID_PRESET";

export class PresetsRepositoryError extends Error {
  constructor(
    public readonly code: PresetsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PresetsRepositoryError";
  }
}

/** id 先过 safeSegment；非法 → INVALID_PRESET_ID（400 语义，非 500）。 */
function checkedId(id: string): string {
  try {
    return safeSegment(id);
  } catch {
    throw new PresetsRepositoryError("INVALID_PRESET_ID", `非法 preset id: ${JSON.stringify(id)}`);
  }
}

function presetFile(presetsDir: string, id: string): string {
  return path.join(presetsDir, `${id}.json`);
}

/** 读单文件并校验；expectId = 文件名隐含 id，不一致视为损坏。 */
function loadPresetFile(file: string, expectId: string): ApiPreset {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new PresetsRepositoryError("PRESET_CORRUPT", `preset 文件不是合法 JSON: ${expectId}`);
  }
  const result = ApiPresetSchema.safeParse(raw);
  if (!result.success) {
    throw new PresetsRepositoryError("PRESET_CORRUPT", `preset 文件契约校验失败: ${expectId}`);
  }
  if (result.data.id !== expectId) {
    throw new PresetsRepositoryError(
      "PRESET_CORRUPT",
      `preset 文件 id 与文件名不一致: ${expectId}（文件内 ${result.data.id}）`,
    );
  }
  return result.data;
}

/** 列出全部 preset（按 id 字典序，确定性；目录不存在 = 空）。 */
export function listPresets(presetsDir: string): ApiPreset[] {
  if (!fs.existsSync(presetsDir)) return [];
  return fs
    .readdirSync(presetsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => loadPresetFile(presetFile(presetsDir, id), id));
}

/** 读指定 preset；不存在 → PRESET_NOT_FOUND。 */
export function loadPreset(presetsDir: string, id: string): ApiPreset {
  const safe = checkedId(id);
  const file = presetFile(presetsDir, safe);
  if (!fs.existsSync(file)) {
    throw new PresetsRepositoryError("PRESET_NOT_FOUND", `preset 不存在: ${safe}`);
  }
  return loadPresetFile(file, safe);
}

/** 原子写 preset（id 非法 → INVALID_PRESET_ID；载荷非法 → INVALID_PRESET；不落盘）。 */
export function savePreset(presetsDir: string, preset: ApiPreset): void {
  const safe = checkedId(preset.id);
  const result = ApiPresetSchema.safeParse(preset);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(顶层)"}: ${issue.message}`)
      .join("；");
    throw new PresetsRepositoryError("INVALID_PRESET", `preset 契约校验失败：${issues}`);
  }
  fs.mkdirSync(presetsDir, { recursive: true });
  const file = presetFile(presetsDir, safe);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result.data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** 删除 preset；不存在 → PRESET_NOT_FOUND。 */
export function deletePreset(presetsDir: string, id: string): void {
  const safe = checkedId(id);
  const file = presetFile(presetsDir, safe);
  if (!fs.existsSync(file)) {
    throw new PresetsRepositoryError("PRESET_NOT_FOUND", `preset 不存在: ${safe}`);
  }
  fs.rmSync(file);
}

/** 复制 preset：新 id（generateId 注入，默认 randomUUID）+ 名称加 " (副本)" 后缀；返回新 preset。 */
export function duplicatePreset(
  presetsDir: string,
  id: string,
  generateId: () => string = randomUUID,
): ApiPreset {
  const source = loadPreset(presetsDir, id);
  const copy: ApiPreset = { ...source, id: generateId(), name: `${source.name} (副本)` };
  savePreset(presetsDir, copy);
  return copy;
}
