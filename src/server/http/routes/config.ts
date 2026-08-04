/**
 * config 域路由（GET/PUT /api/config）。
 * 校验 = contracts/config.ts FileConfigSchema（D3 起唯一出处，手工字段表已删）；
 * 未知顶层字段（"_说明" 注释）经 passthrough 原样保留。
 * config 域专属：保存后热重载到运行中会话（立即生效），不走 markStale/新会话生效。
 */
import fs from "node:fs";
import { validateFileConfig } from "../../../contracts/config.js";
import { validate } from "../errors.js";
import { parseJsonBody, readBody } from "../response.js";
import type { ApiDeps, Route } from "../router.js";

export function configRoutes(deps: ApiDeps): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/config",
      handler: () =>
        fs.existsSync(deps.configFile)
          ? (JSON.parse(fs.readFileSync(deps.configFile, "utf8")) as unknown)
          : {},
    },
    {
      method: "PUT",
      pattern: "/api/config",
      handler: async ({ req }) => {
        const body = parseJsonBody(await readBody(req));
        const config = validate(() => validateFileConfig(body));
        fs.writeFileSync(deps.configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
        // config 域专属：热重载到运行中会话（立即生效），不走 markStale/新会话生效
        deps.coordinator.reloadConfig();
        return { note: "已保存，立即生效" };
      },
    },
  ];
}
