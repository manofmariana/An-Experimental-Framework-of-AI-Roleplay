/**
 * HTTP API 错误模型（优化阶段 D3，docs/optimization-review.md §9「HTTP envelope」）。
 *
 * ApiError = 路由主动抛出的带状态码错误；toApiError 把任意抛错收敛为 ApiError：
 * - ApiError 原样透传；
 * - ZodError → 400 VALIDATION_ERROR；
 * - RunRepositoryError / WorldRepositoryError → 按仓储 code 映射；
 * - RevisionConflictError → 409 REVISION_CONFLICT（details 附 baseRevision/currentRevision）；
 * - 协调器/真相层的少量历史消息约定（LLM 在途、safeSegment 非法名）按消息映射；
 * - 其余未预期异常 → 500 INTERNAL_ERROR（不再一律 400）。
 *
 * 401/403 码位预留（认证属阶段 E），本片不触发。
 */
import { ZodError } from "zod";
import { RunRepositoryError } from "../../resources/runRepository.js";
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
  | "SESSION_ACTIVE"
  | "RUN_CORRUPT"
  | "INTERNAL_ERROR"
  /** 预留（认证属阶段 E，本片不触发） */
  | "UNAUTHORIZED"
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
