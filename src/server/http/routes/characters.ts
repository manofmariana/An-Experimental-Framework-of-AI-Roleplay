/**
 * characters 域路由（角色 manifest 列表/读取/写入）。
 * 文件 IO 在 resources/worldRepository；结构校验（CharacterManifestSchema 属 agents 层）
 * 留在本路由层。PUT 生效规则：markStale 后下次 new_session 生效。
 */
import { CharacterManifestSchema } from "../../../agents/character.js";
import { DEFAULT_WORLD_SET } from "../../../config.js";
import {
  listCharacterManifests,
  readCharacterManifest,
  resolveWorldDir,
  writeCharacterManifest,
} from "../../../resources/worldRepository.js";
import { validate } from "../errors.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

/** 校验 manifest 并与路径 id 对拍（C0 唯一 isPlayer）。 */
export function validateCharacterManifestForPath(id: string, raw: unknown) {
  const manifest = CharacterManifestSchema.parse(raw);
  if (manifest.id !== id) throw new Error(`manifest.id（${manifest.id}）与路径 id（${id}）不一致`);
  if (id === "C0" && !manifest.isPlayer) throw new Error("C0 必须标记 isPlayer=true");
  if (id !== "C0" && manifest.isPlayer) throw new Error(`只有 C0 可以标记 isPlayer=true: ${id}`);
  return manifest;
}

export function characterRoutes(deps: ApiDeps): Route[] {
  const worldDirOf = (url: URL): string =>
    resolveWorldDir(deps.dirs.assetsDir, url.searchParams.get("set") ?? undefined, DEFAULT_WORLD_SET);
  return [
    {
      method: "GET",
      pattern: "/api/characters",
      handler: ({ url }) => listCharacterManifests(worldDirOf(url)),
    },
    {
      method: "GET",
      pattern: "/api/characters/:id",
      handler: ({ url, params }) => readCharacterManifest(worldDirOf(url), params.id!),
    },
    {
      method: "PUT",
      pattern: "/api/characters/:id",
      handler: async ({ req, url, params }) => {
        const id = params.id!;
        const body = parseJsonBody(await readBody(req));
        const manifest = validate(() => validateCharacterManifestForPath(id, body));
        writeCharacterManifest(worldDirOf(url), id, manifest);
        deps.coordinator.markStale();
        return { note: "已保存，修改在新会话生效" };
      },
    },
  ];
}
