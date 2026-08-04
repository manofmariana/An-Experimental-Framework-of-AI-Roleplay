/**
 * activeSession 域路由（PUT /api/session/state：活跃会话真相层直接编辑）。
 * 薄壳转发 SessionCoordinator.applyDirectEdit（direct_edit 命令入队）；
 * 提交广播 = Coordinator onCommit → transition（前端输入权限立刻跟随 phase 变化）。
 * 错误映射：LLM 在途 → 409 SESSION_BUSY（toApiError 消息约定）；直编域校验失败
 * （payload 形状/角色集合一致性/store schema）一律 400 VALIDATION_ERROR。
 * D5：body 可带可选 baseRevision（状态编辑器乐观并发闸）——非整数 → 400；
 * 与当前 revision 不符 → 409 REVISION_CONFLICT（Coordinator checkRevision）。
 */
import type { DirectEditPayload } from "../../../application/sessionCoordinator.js";
import { ApiError, toApiError } from "../errors.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

export function activeSessionRoutes(deps: ApiDeps): Route[] {
  return [
    {
      method: "PUT",
      pattern: "/api/session/state",
      handler: async ({ req }) => {
        const body = parseJsonBody(await readBody(req)) as DirectEditPayload & { baseRevision?: unknown };
        const { baseRevision, ...payload } = body;
        if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || (baseRevision as number) < 0)) {
          throw new ApiError(400, "VALIDATION_ERROR", "baseRevision 必须是非负整数");
        }
        try {
          await deps.coordinator.applyDirectEdit(payload, baseRevision as number | undefined);
        } catch (err) {
          const apiErr = toApiError(err);
          // RevisionConflictError（409）原样透传；未分类的直编失败本质是域校验失败
          // （draft 机制保证零副作用），归 400 而非 500
          throw apiErr.status === 500 ? new ApiError(400, "VALIDATION_ERROR", apiErr.message) : apiErr;
        }
        return { note: "已保存，立即生效" };
      },
    },
  ];
}
