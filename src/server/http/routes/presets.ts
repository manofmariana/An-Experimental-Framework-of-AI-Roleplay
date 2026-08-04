/**
 * presets 域路由。
 * 全部变更走 configService 配置事务（baseConfigRevision 乐观并发闸）：
 * - GET    /api/presets                  → preset 列表（引用 secret，不含 key）
 * - POST   /api/presets                  {preset（id 可省 = 新建）, baseConfigRevision} → save(upsert)
 * - POST   /api/presets/:id/duplicate    {baseConfigRevision}
 * - DELETE /api/presets/:id              {baseConfigRevision}
 *   被任一 agent 绑定引用的 preset 拒删 → 409 PRESET_IN_USE。
 * 错误码经 errors.ts 映射：PRESET_NOT_FOUND→404，CONFIG_REVISION_CONFLICT→409。
 */
import { z } from "zod";
import {
  applyConfigMutation,
  loadConfigState,
} from "../../../application/configService.js";
import { ApiPresetSchema } from "../../../contracts/config.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

const BaseRevisionBodySchema = z.object({ baseConfigRevision: z.number().int().min(0) }).strict();

/** save 请求体：preset 的 id 可省（新建由服务端生成 id）。 */
const SaveBodySchema = BaseRevisionBodySchema.extend({
  preset: ApiPresetSchema.extend({ id: z.string().min(1).optional() }),
});

function presetId(params: Record<string, string>): string {
  return z.string().min(1).parse(params.id);
}

export function presetRoutes(deps: ApiDeps): Route[] {
  const cfg = deps.config;
  return [
    {
      method: "GET",
      pattern: "/api/presets",
      handler: () => loadConfigState(cfg).view.presets,
    },
    {
      method: "POST",
      pattern: "/api/presets",
      handler: async ({ req }) => {
        const body = SaveBodySchema.parse(parseJsonBody(await readBody(req)));
        return applyConfigMutation(
          cfg,
          { domain: "preset", mutation: { type: "save", preset: body.preset } },
          body.baseConfigRevision,
        );
      },
    },
    {
      method: "POST",
      pattern: "/api/presets/:id/duplicate",
      handler: async ({ req, params }) => {
        const body = BaseRevisionBodySchema.parse(parseJsonBody(await readBody(req)));
        return applyConfigMutation(
          cfg,
          { domain: "preset", mutation: { type: "duplicate", id: presetId(params) } },
          body.baseConfigRevision,
        );
      },
    },
    {
      method: "DELETE",
      pattern: "/api/presets/:id",
      handler: async ({ req, params }) => {
        const body = BaseRevisionBodySchema.parse(parseJsonBody(await readBody(req)));
        return applyConfigMutation(
          cfg,
          { domain: "preset", mutation: { type: "delete", id: presetId(params) } },
          body.baseConfigRevision,
        );
      },
    },
  ];
}
