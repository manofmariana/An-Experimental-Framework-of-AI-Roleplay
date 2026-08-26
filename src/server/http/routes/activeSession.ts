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
 * body 可带可选 sys {varsTemplate?, varsTags?}（世界页结构编辑档内模式）：服务端取当前
 * world，把 `_sys.varsTemplate`/`_sys.varsTags` 替换为提交值后并入 payload.world 走同一
 * 直编通道（`_sys` 严格解析 + normalize + 从动级联 + baseRevision 乐观闸全部沿用；
 * 结构不合法 = 400 零落盘）；sys 与 world 互斥（400）；无活跃会话 → 404 NO_ACTIVE_SESSION。
 *
 * GET /api/session/state/sys：活跃会话的结构编辑源——world._sys 的
 * varsTemplate/varsTags/tagRegistry + baseRevision；无活跃会话 → 404 NO_ACTIVE_SESSION
 * （前端据此判双模式：有 = 档内模式，无 = 世界包基线模式）。
 */
import type { DirectEditPayload } from "../../../application/sessionCoordinator.js";
import { ApiError, toApiError } from "../errors.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

/** sys 载荷形状闸 + 取当前 world 替换 `_sys` 对应键（返回并入后的完整 world 直编载荷）。 */
function patchWorldSys(deps: ApiDeps, sys: unknown, worldInPayload: unknown): unknown {
  if (typeof sys !== "object" || sys === null || Array.isArray(sys)) {
    throw new ApiError(400, "VALIDATION_ERROR", "sys 必须是对象");
  }
  if (worldInPayload !== undefined) {
    throw new ApiError(400, "VALIDATION_ERROR", "sys 与 world 不可同时携带（sys 语义已含整体 world）");
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
  const world = deps.coordinator.activeWorld();
  if (world === null) {
    throw new ApiError(404, "NO_ACTIVE_SESSION", "当前无活跃会话（结构编辑档内模式不可用）");
  }
  // getState 返回冻结视图：深拷贝为可变副本后替换 `_sys` 对应键（计数键等其余程序分支原样保留）
  const patched = JSON.parse(JSON.stringify(world)) as { _sys: Record<string, unknown> };
  const patch = sys as { varsTemplate?: unknown; varsTags?: unknown };
  if (patch.varsTemplate !== undefined) patched._sys["varsTemplate"] = patch.varsTemplate;
  if (patch.varsTags !== undefined) patched._sys["varsTags"] = patch.varsTags;
  return patched;
}

export function activeSessionRoutes(deps: ApiDeps): Route[] {
  return [
    {
      method: "PUT",
      pattern: "/api/session/state",
      handler: async ({ req }) => {
        const body = parseJsonBody(await readBody(req)) as DirectEditPayload & {
          baseRevision?: unknown;
          sys?: unknown;
        };
        const { baseRevision, sys, ...payload } = body;
        if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || (baseRevision as number) < 0)) {
          throw new ApiError(400, "VALIDATION_ERROR", "baseRevision 必须是非负整数");
        }
        if (sys !== undefined) {
          payload.world = patchWorldSys(deps, sys, payload.world);
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
        const world = deps.coordinator.activeWorld();
        if (world === null) {
          throw new ApiError(404, "NO_ACTIVE_SESSION", "当前无活跃会话");
        }
        const sys = world._sys;
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
