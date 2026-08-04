/**
 * world/worlds 域路由（世界设定集列表 + 世界三文件读写）。
 * 文件 IO 在 resources/worldRepository；本层只做请求解析与校验收口。
 * PUT 生效规则：markStale 后下次 new_session 生效。
 */
import { DEFAULT_WORLD_SET } from "../../../config.js";
import {
  isWorldFileName,
  listWorldSets,
  readWorldFile,
  resolveWorldDir,
  validateLorebookPayload,
  writeWorldFile,
} from "../../../resources/worldRepository.js";
import { ApiError, validate } from "../errors.js";
import { parseJsonBody, readBody, requireStringField } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

export function worldRoutes(deps: ApiDeps): Route[] {
  const worldDirOf = (url: URL): string =>
    resolveWorldDir(deps.dirs.worldsDir, url.searchParams.get("set") ?? undefined, DEFAULT_WORLD_SET);
  return [
    {
      method: "GET",
      pattern: "/api/worlds",
      handler: () => ({ sets: listWorldSets(deps.dirs.worldsDir) }),
    },
    {
      method: "GET",
      pattern: "/api/world",
      handler: ({ url }) => {
        const worldDir = worldDirOf(url);
        return {
          setting: readWorldFile(worldDir, "setting"),
          toneCard: readWorldFile(worldDir, "tone-card"),
          lorebook: JSON.parse(readWorldFile(worldDir, "lorebook")) as unknown,
        };
      },
    },
    {
      method: "PUT",
      pattern: "/api/world/:name",
      handler: async ({ req, url, params }) => {
        const name = params.name!;
        if (!isWorldFileName(name)) {
          throw new ApiError(404, "UNKNOWN_ENDPOINT", `未知端点: PUT /api/world/${name}`);
        }
        const worldDir = worldDirOf(url);
        const body = parseJsonBody(await readBody(req));
        if (name === "lorebook") {
          const entries = validate(() => validateLorebookPayload(body));
          writeWorldFile(worldDir, name, JSON.stringify(entries, null, 2) + "\n");
        } else {
          writeWorldFile(worldDir, name, requireStringField(body, "content"));
        }
        deps.coordinator.markStale();
        return { note: "已保存，修改在新会话生效" };
      },
    },
  ];
}
