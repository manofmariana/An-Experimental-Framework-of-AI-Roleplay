/**
 * activeSession 域路由（活跃会话真相层直接编辑 + 结构编辑档内副本通道）。
 *
 * PUT /api/session/state：薄壳转发 SessionCoordinator.applyDirectEdit（direct_edit 命令入队）；
 * 提交广播 = Coordinator onCommit → transition（前端输入权限立刻跟随 phase 变化）。
 * 错误映射：LLM 在途 → 409 SESSION_BUSY（toApiError 消息约定）；直编域校验失败
 * （payload 形状/角色集合一致性/store schema）一律 400 VALIDATION_ERROR。
 * body 可带可选 baseRevision（状态编辑器乐观并发闸）——非整数 → 400；
 * 与当前 revision 不符 → 409 REVISION_CONFLICT（Coordinator checkRevision）。
 * 成功应答附 revision（保存后的新 revision，前端保存不关窗时刷新闸值）。
 *
 * body 可带可选 sys {varsTemplate?, varsTags?}（世界页结构编辑档内模式）：原样并入
 * 直编载荷走同一通道（GameSession 侧并入 draft sys 根 → parseSys 严格解析 + normalize +
 * 从动级联 + baseRevision 乐观闸全部沿用；结构不合法 = 400 零落盘）；sys 与 world 可
 * 同携（两个独立域）；无活跃会话 → 404 NO_ACTIVE_SESSION（无会话时 sys 无落点）。
 *
 * GET /api/session/state/sys：活跃会话的结构编辑源——sys 根的
 * varsTemplate/varsTags/tagRegistry + baseRevision；无活跃会话 → 404 NO_ACTIVE_SESSION
 * （前端据此判双模式：有 = 档内模式，无 = 世界包基线模式）。
 */
import type { DirectEditPayload } from "../../../application/sessionCoordinator.js";
import { ApiError, toApiError } from "../errors.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

/** sys 载荷键白名单闸（形状校验与解析在直编通道内）。 */
function checkSysKeys(sys: unknown): void {
  if (typeof sys !== "object" || sys === null || Array.isArray(sys)) {
    throw new ApiError(400, "VALIDATION_ERROR", "sys 必须是对象");
  }
  const keys = Object.keys(sys);
  for (const k of keys) {
    if (k !== "varsTemplate" && k !== "varsTags") {
      throw new ApiError(400, "VALIDATION_ERROR", `sys 不支持字段: ${k}`);
    }
  }
  if (keys.length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "sys 至少携带 varsTemplate/varsTags 其一");
  }
}

export function activeSessionRoutes(deps: ApiDeps): Route[] {
  return [
    {
      method: "PUT",
      pattern: "/api/session/state",
      handler: async ({ req }) => {
        const body = parseJsonBody(await readBody(req)) as DirectEditPayload & {
          baseRevision?: unknown;
        };
        const { baseRevision, ...payload } = body;
        if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || (baseRevision as number) < 0)) {
          throw new ApiError(400, "VALIDATION_ERROR", "baseRevision 必须是非负整数");
        }
        if (payload.sys !== undefined) {
          if (deps.coordinator.activeSys() === null) {
            throw new ApiError(404, "NO_ACTIVE_SESSION", "当前无活跃会话（结构编辑档内模式不可用）");
          }
          checkSysKeys(payload.sys);
        }
        try {
          await deps.coordinator.applyDirectEdit(payload, baseRevision as number | undefined);
        } catch (err) {
          const apiErr = toApiError(err);
          // RevisionConflictError（409）原样透传；未分类的直编失败本质是域校验失败
          // （draft 机制保证零副作用），归 400 而非 500
          throw apiErr.status === 500 ? new ApiError(400, "VALIDATION_ERROR", apiErr.message) : apiErr;
        }
        return { note: "已保存，立即生效", revision: deps.coordinator.currentRevision };
      },
    },
    {
      method: "GET",
      pattern: "/api/session/state/sys",
      handler: () => {
        const sys = deps.coordinator.activeSys();
        if (sys === null) {
          throw new ApiError(404, "NO_ACTIVE_SESSION", "当前无活跃会话");
        }
        return {
          varsTemplate: sys.varsTemplate,
          varsTags: sys.varsTags,
          tagRegistry: sys.tagRegistry,
          baseRevision: deps.coordinator.currentRevision,
        };
      },
    },
  ];
}
