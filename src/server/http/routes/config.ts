/**
 * config 域路由。
 * - GET /api/config → ConfigStateView（脱敏：secrets 只有掩码态，无 api_key 字段）；
 *   首次读取触发 config.json → 三资源的幂等迁移闸（configService.loadConfigState）。
 * - PUT /api/config → settings/agent 绑定 patch（ConfigPutBodySchema：patch 字段 +
 *   baseConfigRevision 并发闸），走 configService 配置事务（解析失败零落盘 → 400；
 *   版本冲突 → 409 CONFIG_REVISION_CONFLICT；热应用失败回滚 → 500 CONFIG_APPLY_FAILED）。
 *   PUT 只支持 patch 语义，不接整文件替换。
 */
import { applyConfigMutation, loadConfigState } from "../../../application/configService.js";
import { ConfigPutBodySchema } from "../../../contracts/config.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

export function configRoutes(deps: ApiDeps): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/config",
      handler: () => loadConfigState(deps.config).view,
    },
    {
      method: "PUT",
      pattern: "/api/config",
      handler: async ({ req }) => {
        const body = ConfigPutBodySchema.parse(parseJsonBody(await readBody(req)));
        const { baseConfigRevision, ...patch } = body;
        return applyConfigMutation(deps.config, { domain: "settings", patch }, baseConfigRevision);
      },
    },
  ];
}
