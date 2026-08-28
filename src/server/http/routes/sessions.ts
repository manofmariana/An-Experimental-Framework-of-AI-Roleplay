/**
 * sessions 域路由（runs 列表/回放产物/llm-recent/重命名/删除）。
 * 存档读写全部在 resources/runRepository（错误码由 HTTP 层映射：
 * RUN_NOT_FOUND/LEGACY_RUN_UNSUPPORTED→404、SESSION_ACTIVE→409、RUN_CORRUPT→500）。
 */
import path from "node:path";
import { readRecent } from "../../../llm/recent.js";
import {
  deleteRun,
  listRuns,
  readRunArtifact,
  writeAlias,
  type RunArtifactKind,
} from "../../../resources/runRepository.js";
import { safeSegment } from "../../../shared/safeSegment.js";
import { ApiError } from "../errors.js";
import { parseJsonBody, readBody, requireStringField } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

const ARTIFACT_KINDS: readonly RunArtifactKind[] = ["events", "world", "characters", "archive", "lore", "sys", "prompts", "stats"];

export function sessionRoutes(deps: ApiDeps): Route[] {
  const saveDir = deps.dirs.saveDir;
  return [
    {
      method: "GET",
      pattern: "/api/sessions",
      handler: () => ({ active: deps.coordinator.currentRunId, runs: listRuns(saveDir) }),
    },
    {
      // GET /api/sessions/{id}/llm-recent/{agentSlug}（最近 5 轮滚动窗；超出 = 已轮换出窗）
      method: "GET",
      pattern: "/api/sessions/:id/llm-recent/:slug",
      handler: ({ params }) => {
        const id = safeSegment(params.id!);
        const slug = safeSegment(params.slug!);
        return readRecent(id, slug, path.join(saveDir, id));
      },
    },
    {
      // POST /api/sessions/{id}/rename {alias}
      method: "POST",
      pattern: "/api/sessions/:id/rename",
      handler: async ({ req, params }) => {
        const alias = requireStringField(parseJsonBody(await readBody(req)), "alias");
        writeAlias(saveDir, params.id!, alias);
        return {};
      },
    },
    {
      method: "GET",
      pattern: "/api/sessions/:id/:kind",
      handler: ({ params }) => {
        const kind = params.kind!;
        if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
          throw new ApiError(400, "VALIDATION_ERROR", `未知会话产物: ${kind}`);
        }
        return readRunArtifact(saveDir, params.id!, kind as RunArtifactKind);
      },
    },
    {
      // DELETE /api/sessions/{id}（拒删活跃会话 → 409 SESSION_ACTIVE）
      method: "DELETE",
      pattern: "/api/sessions/:id",
      handler: ({ params }) => {
        deleteRun(saveDir, params.id!, deps.coordinator.currentRunId);
        return {};
      },
    },
  ];
}
