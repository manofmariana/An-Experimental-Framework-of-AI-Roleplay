/**
 * world/worlds 域路由（世界设定集列表 + 世界三文件读写 + 变量体系文件读写）。
 * 文件 IO 在 resources/worldRepository；本层只做请求解析与校验收口。
 * PUT 生效规则：markStale 后下次 new_session 生效。
 * 变量体系端点：GET/PUT /api/world/vars-template、GET/PUT /api/world/vars-tags、
 * GET /api/world/tags（注册表只读）；缺文件 GET 回缺省空结构（EMPTY_VARS_TEMPLATE /
 * EMPTY_VARS_TAGS / 空注册表），PUT 创建。PUT 校验失败 400 零落盘：
 * vars-template 过 parseVarsTemplate；vars-tags 过 parseVarsTags 对拍同包模板。
 */
import { z } from "zod";
import { DEFAULT_WORLD_SET } from "../../../config.js";
import {
  isWorldFileName,
  isWorldVarsFileName,
  listWorldSets,
  readWorldFile,
  readWorldVarsFile,
  resolveWorldDir,
  validateLorebookPayload,
  writeWorldFile,
  writeWorldVarsFile,
} from "../../../resources/worldRepository.js";
import {
  EMPTY_VARS_TAGS,
  EMPTY_VARS_TEMPLATE,
  parseVarsTags,
  parseVarsTemplate,
} from "../../../vars/template.js";
import { ApiError, validate } from "../errors.js";
import { parseJsonBody, readBody, requireStringField } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

/** vars-tags 文件顶层形状（world/character 两附加根；各根校验走 parseVarsTags 对拍模板）。 */
const VarsTagsFileSchema = z.object({ world: z.unknown(), character: z.unknown() }).strict();

export function worldRoutes(deps: ApiDeps): Route[] {
  const worldDirOf = (url: URL): string =>
    resolveWorldDir(deps.dirs.assetsDir, url.searchParams.get("set") ?? undefined, DEFAULT_WORLD_SET);
  return [
    {
      method: "GET",
      pattern: "/api/worlds",
      handler: () => ({ sets: listWorldSets(deps.dirs.assetsDir) }),
    },
    {
      method: "GET",
      pattern: "/api/world",
      handler: ({ url }) => {
        const worldDir = worldDirOf(url);
        return {
          lorebook: JSON.parse(readWorldFile(worldDir, "lorebook")) as unknown,
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/world/:name",
      handler: ({ url, params }) => {
        const name = params.name!;
        if (!isWorldVarsFileName(name)) {
          throw new ApiError(404, "UNKNOWN_ENDPOINT", `未知端点: GET /api/world/${name}`);
        }
        const raw = readWorldVarsFile(worldDirOf(url), name);
        if (name === "vars-template") return raw ?? EMPTY_VARS_TEMPLATE;
        if (name === "vars-tags") return raw ?? EMPTY_VARS_TAGS;
        return raw ?? {}; // tags.json 注册表（只读；缺文件 = 空注册表）
      },
    },
    {
      method: "PUT",
      pattern: "/api/world/:name",
      handler: async ({ req, url, params }) => {
        const name = params.name!;
        if (!isWorldFileName(name) && !isWorldVarsFileName(name)) {
          throw new ApiError(404, "UNKNOWN_ENDPOINT", `未知端点: PUT /api/world/${name}`);
        }
        if (name === "tags") {
          throw new ApiError(404, "UNKNOWN_ENDPOINT", `未知端点: PUT /api/world/${name}`);
        }
        const worldDir = worldDirOf(url);
        const body = parseJsonBody(await readBody(req));
        if (name === "lorebook") {
          const entries = validate(() => validateLorebookPayload(body));
          writeWorldFile(worldDir, name, JSON.stringify(entries, null, 2) + "\n");
        } else if (name === "vars-template") {
          validate(() => parseVarsTemplate(body));
          writeWorldVarsFile(worldDir, name, body);
        } else if (name === "vars-tags") {
          // 对拍同包 vars-template（缺文件按缺省空模板）；包内模板损坏 = 包损坏（500）
          const template = parseVarsTemplate(
            readWorldVarsFile(worldDir, "vars-template") ?? EMPTY_VARS_TEMPLATE,
          );
          validate(() => {
            const file = VarsTagsFileSchema.parse(body);
            parseVarsTags(file.world, template.world);
            parseVarsTags(file.character, template.character);
          });
          writeWorldVarsFile(worldDir, name, body);
        } else if (isWorldFileName(name)) {
          writeWorldFile(worldDir, name, requireStringField(body, "content"));
        }
        deps.coordinator.markStale();
        return { note: "已保存，修改在新会话生效" };
      },
    },
  ];
}
