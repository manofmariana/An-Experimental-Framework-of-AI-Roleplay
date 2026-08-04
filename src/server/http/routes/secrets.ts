/**
 * secrets 域路由。
 * 全部变更走 configService 配置事务（baseConfigRevision 乐观并发闸）：
 * - GET    /api/secrets                        → 掩码 state（绝不含明文）
 * - POST   /api/secrets                        {kind, value, label, baseConfigRevision} → write
 * - POST   /api/secrets/:kind/:id/activate     {baseConfigRevision}
 * - POST   /api/secrets/:kind/:id/rotate       {baseConfigRevision}（激活下一条，循环）
 * - POST   /api/secrets/:kind/:id/rename       {label, baseConfigRevision}
 * - DELETE /api/secrets/:kind/:id              {baseConfigRevision}
 * - GET    /api/secrets/:kind/:id/view         明文查看：allowKeysExposure 未开启 → 403 FORBIDDEN
 *   （开关属服务端配置，经 server.json → ApiDeps.allowKeysExposure 接线）
 * 错误码经 errors.ts 映射：SECRET_NOT_FOUND→404，CONFIG_REVISION_CONFLICT→409。
 */
import { z } from "zod";
import {
  applyConfigMutation,
  loadConfigState,
} from "../../../application/configService.js";
import { SecretKindSchema } from "../../../contracts/secrets.js";
import { readSecretsFile } from "../../../resources/secretsRepository.js";
import { ApiError } from "../errors.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

/** 带并发闸的请求体基座（全部 secrets mutation 共用）。 */
const BaseRevisionBodySchema = z.object({ baseConfigRevision: z.number().int().min(0) }).strict();

const WriteBodySchema = BaseRevisionBodySchema.extend({
  kind: SecretKindSchema,
  value: z.string().min(1),
  label: z.string().min(1),
});

const RenameBodySchema = BaseRevisionBodySchema.extend({ label: z.string().min(1) });

/** 路径参数 → 校验过的 kind/id（zod 抛错 → 400 VALIDATION_ERROR）。 */
function secretTarget(params: Record<string, string>): { kind: string; id: string } {
  return { kind: SecretKindSchema.parse(params.kind), id: z.string().min(1).parse(params.id) };
}

export function secretRoutes(deps: ApiDeps): Route[] {
  const cfg = deps.config;
  return [
    {
      method: "GET",
      pattern: "/api/secrets",
      handler: () => loadConfigState(cfg).view.secrets,
    },
    {
      method: "POST",
      pattern: "/api/secrets",
      handler: async ({ req }) => {
        const body = WriteBodySchema.parse(parseJsonBody(await readBody(req)));
        return applyConfigMutation(
          cfg,
          {
            domain: "secret",
            mutation: { type: "write", kind: body.kind, value: body.value, label: body.label },
          },
          body.baseConfigRevision,
        );
      },
    },
    {
      method: "POST",
      pattern: "/api/secrets/:kind/:id/activate",
      handler: async ({ req, params }) => {
        const body = BaseRevisionBodySchema.parse(parseJsonBody(await readBody(req)));
        const { kind, id } = secretTarget(params);
        return applyConfigMutation(cfg, { domain: "secret", mutation: { type: "activate", kind, id } }, body.baseConfigRevision);
      },
    },
    {
      method: "POST",
      pattern: "/api/secrets/:kind/:id/rotate",
      handler: async ({ req, params }) => {
        const body = BaseRevisionBodySchema.parse(parseJsonBody(await readBody(req)));
        const { kind, id } = secretTarget(params);
        return applyConfigMutation(cfg, { domain: "secret", mutation: { type: "rotate", kind, id } }, body.baseConfigRevision);
      },
    },
    {
      method: "POST",
      pattern: "/api/secrets/:kind/:id/rename",
      handler: async ({ req, params }) => {
        const body = RenameBodySchema.parse(parseJsonBody(await readBody(req)));
        const { kind, id } = secretTarget(params);
        return applyConfigMutation(
          cfg,
          { domain: "secret", mutation: { type: "rename", kind, id, label: body.label } },
          body.baseConfigRevision,
        );
      },
    },
    {
      method: "DELETE",
      pattern: "/api/secrets/:kind/:id",
      handler: async ({ req, params }) => {
        const body = BaseRevisionBodySchema.parse(parseJsonBody(await readBody(req)));
        const { kind, id } = secretTarget(params);
        return applyConfigMutation(cfg, { domain: "secret", mutation: { type: "delete", kind, id } }, body.baseConfigRevision);
      },
    },
    {
      // 明文查看：仅服务端配置 allowKeysExposure=true 时放行（经 server.json 接线），否则 403
      method: "GET",
      pattern: "/api/secrets/:kind/:id/view",
      handler: ({ params }) => {
        if (deps.allowKeysExposure !== true) {
          throw new ApiError(403, "FORBIDDEN", "服务端未开启密钥明文暴露（allowKeysExposure=false）");
        }
        const { kind, id } = secretTarget(params);
        // 明文只在本端点内短暂出现（仓储读文件直取，不进公共视图）
        const record = (readSecretsFile(cfg.dirs.secretsFile)[kind] ?? []).find((r) => r.id === id);
        if (record === undefined) {
          throw new ApiError(404, "SECRET_NOT_FOUND", `secret 不存在: ${kind}/${id}`);
        }
        return { id: record.id, kind, label: record.label, value: record.value };
      },
    },
  ];
}
