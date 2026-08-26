/**
 * HTTP API 错误模型。
 *
 * ApiError = 路由主动抛出的带状态码错误；toApiError 把任意抛错收敛为 ApiError：
 * - ApiError 原样透传；
 * - ZodError → 400 VALIDATION_ERROR；
 * - RunRepositoryError / WorldRepositoryError → 按仓储 code 映射；
 * - 配置三仓储（secrets/presets/settings）按 code 映射（SECRET_NOT_FOUND/PRESET_NOT_FOUND→404，
 *   INVALID_PRESET_ID/INVALID_PRESET→400，SECRETS_CORRUPT/PRESET_CORRUPT/SETTINGS_CORRUPT→500）；
 * - ConfigServiceError（配置事务）→ CONFIG_INVALID 400 / CONFIG_REVISION_CONFLICT·PRESET_IN_USE 409
 *   / CONFIG_APPLY_FAILED 500；
 * - RevisionConflictError → 409 REVISION_CONFLICT（details 附 baseRevision/currentRevision）；
 * - 协调器/真相层的少量历史消息约定（LLM 在途、safeSegment 非法名）按消息映射；
 * - 其余未预期异常 → 500 INTERNAL_ERROR。
 *
 * 403 用于 secrets view 未开启 allowKeysExposure 等场景（FORBIDDEN）；401 留码位（认证未实现）。
 */
import { ZodError } from "zod";
import { ConfigServiceError } from "../../application/configService.js";
import { PresetsRepositoryError } from "../../resources/presetsRepository.js";
import { RunRepositoryError } from "../../resources/runRepository.js";
import { SecretsRepositoryError } from "../../resources/secretsRepository.js";
import { SettingsRepositoryError } from "../../resources/settingsRepository.js";
import { WorldRepositoryError } from "../../resources/worldRepository.js";
import { RevisionConflictError } from "../../truth/validation/errors.js";

/** 稳定错误码（envelope error.code 的取值集）。 */
export type ApiErrorCode =
  | "BAD_JSON"
  | "VALIDATION_ERROR"
  | "UNKNOWN_ENDPOINT"
  | "METHOD_NOT_ALLOWED"
  | "RUN_NOT_FOUND"
  | "LEGACY_RUN_UNSUPPORTED"
  | "CHARACTER_NOT_FOUND"
  | "WORLD_SET_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "SESSION_BUSY"
  | "NO_ACTIVE_SESSION"
  | "SESSION_ACTIVE"
  | "RUN_CORRUPT"
  | "SECRET_NOT_FOUND"
  | "PRESET_NOT_FOUND"
  | "CONFIG_REVISION_CONFLICT"
  | "PRESET_IN_USE"
  | "CONFIG_APPLY_FAILED"
  | "INTERNAL_ERROR"
  /** 预留（认证未实现，不触发） */
  | "UNAUTHORIZED"
  /** 未开启 allowKeysExposure 的明文查看等 */
  | "FORBIDDEN";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 错误消息提取（unknown → string）。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const RUN_ERROR_STATUS: Record<string, { status: number; code: ApiErrorCode }> = {
  RUN_NOT_FOUND: { status: 404, code: "RUN_NOT_FOUND" },
  LEGACY_RUN_UNSUPPORTED: { status: 404, code: "LEGACY_RUN_UNSUPPORTED" },
  RUN_CORRUPT: { status: 500, code: "RUN_CORRUPT" },
  SESSION_ACTIVE: { status: 409, code: "SESSION_ACTIVE" },
  INVALID_ALIAS: { status: 400, code: "VALIDATION_ERROR" },
};

const WORLD_ERROR_STATUS: Record<string, { status: number; code: ApiErrorCode }> = {
  WORLD_SET_NOT_FOUND: { status: 404, code: "WORLD_SET_NOT_FOUND" },
  CHARACTER_NOT_FOUND: { status: 404, code: "CHARACTER_NOT_FOUND" },
  INVALID_WORLD_SET: { status: 400, code: "VALIDATION_ERROR" },
};

const SECRETS_ERROR_STATUS: Record<string, { status: number; code: ApiErrorCode }> = {
  SECRET_NOT_FOUND: { status: 404, code: "SECRET_NOT_FOUND" },
  SECRETS_CORRUPT: { status: 500, code: "INTERNAL_ERROR" },
};

const PRESETS_ERROR_STATUS: Record<string, { status: number; code: ApiErrorCode }> = {
  PRESET_NOT_FOUND: { status: 404, code: "PRESET_NOT_FOUND" },
  PRESET_CORRUPT: { status: 500, code: "INTERNAL_ERROR" },
  INVALID_PRESET_ID: { status: 400, code: "VALIDATION_ERROR" },
  INVALID_PRESET: { status: 400, code: "VALIDATION_ERROR" },
};

const SETTINGS_ERROR_STATUS: Record<string, { status: number; code: ApiErrorCode }> = {
  SETTINGS_CORRUPT: { status: 500, code: "INTERNAL_ERROR" },
};

const CONFIG_SERVICE_ERROR_STATUS: Record<string, { status: number; code: ApiErrorCode }> = {
  CONFIG_INVALID: { status: 400, code: "VALIDATION_ERROR" },
  CONFIG_REVISION_CONFLICT: { status: 409, code: "CONFIG_REVISION_CONFLICT" },
  PRESET_IN_USE: { status: 409, code: "PRESET_IN_USE" },
  CONFIG_APPLY_FAILED: { status: 500, code: "CONFIG_APPLY_FAILED" },
};

/** 任意抛错 → ApiError（路由/仓储/协调器错误的唯一收敛出口）。 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    const issues = err.issues
      .map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`)
      .join("；");
    return new ApiError(400, "VALIDATION_ERROR", `校验失败：${issues}`);
  }
  if (err instanceof RunRepositoryError) {
    const mapped = RUN_ERROR_STATUS[err.code]!;
    return new ApiError(mapped.status, mapped.code, err.message);
  }
  if (err instanceof WorldRepositoryError) {
    const mapped = WORLD_ERROR_STATUS[err.code]!;
    return new ApiError(mapped.status, mapped.code, err.message);
  }
  if (err instanceof SecretsRepositoryError) {
    const mapped = SECRETS_ERROR_STATUS[err.code]!;
    return new ApiError(mapped.status, mapped.code, err.message);
  }
  if (err instanceof PresetsRepositoryError) {
    const mapped = PRESETS_ERROR_STATUS[err.code]!;
    return new ApiError(mapped.status, mapped.code, err.message);
  }
  if (err instanceof SettingsRepositoryError) {
    const mapped = SETTINGS_ERROR_STATUS[err.code]!;
    return new ApiError(mapped.status, mapped.code, err.message);
  }
  if (err instanceof ConfigServiceError) {
    const mapped = CONFIG_SERVICE_ERROR_STATUS[err.code]!;
    return new ApiError(mapped.status, mapped.code, err.message, err.details);
  }
  if (err instanceof RevisionConflictError) {
    return new ApiError(409, "REVISION_CONFLICT", err.message, {
      baseRevision: err.base,
      currentRevision: err.current,
    });
  }
  const message = errorMessage(err);
  // 历史消息约定（GameSession/协调器与 shared/safeSegment 的错误暂无类型化出口）
  if (message.includes("LLM 运行中")) return new ApiError(409, "SESSION_BUSY", message);
  if (message.startsWith("非法名称")) return new ApiError(400, "VALIDATION_ERROR", message);
  return new ApiError(500, "INTERNAL_ERROR", message);
}

/**
 * 校验段执行器：把校验类抛错（zod/普通 Error）统一收敛为 400 VALIDATION_ERROR；
 * 已是 ApiError 的（如 BAD_JSON）原样透传。
 */
export function validate<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "VALIDATION_ERROR", errorMessage(err));
  }
}
