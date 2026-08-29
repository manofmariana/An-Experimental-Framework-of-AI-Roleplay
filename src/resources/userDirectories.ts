/**
 * 用户资源目录解析。
 *
 * 单用户阶段固定 handle 为 default_user，但所有资源路径从一开始都经
 * UserDirectories 集中提供，不在 endpoint/业务代码里散落硬编码。
 *
 * 布局（物理迁移已完成：旧 data/worlds、data/prompts、根 runs/ 已删除，无 legacy 回落）：
 * - data/assets/{世界包}/：世界设定集（setting/tone-card/lorebook/time/incident.json/player/characters/）
 *   + 包内 prompts/（完整提示词副本：对象×功能矩阵全量，全局单例 prompts 目录已废）；
 * - data/users/{username}/：secrets.json / api-presets/ / settings.json / save/
 *   （save/ = 存档家目录，原项目根 runs/ 改名迁入户内）。
 *
 * 依赖方向：resources → shared（safeSegment）；config → resources（路径常量派生）。
 * resources 不得反向依赖 config（PROJECT_ROOT 在此自行定位，测试断言与 config 一致）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeSegment } from "../shared/safeSegment.js";

/** 项目根目录（src/resources/ 的上两级）。与 config.ts 的 PROJECT_ROOT 同值（有测试守护）。 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 单用户阶段的默认身份（唯一出处，不散落为字面量）。 */
export const DEFAULT_USERNAME = "default_user";

/**
 * 一个用户的全部资源路径。字段含义：
 * - root：用户根（data/users/{username}/）——用户级资源的家；
 * - assetsDir：世界资产根（data/assets/，用户间共享；每个世界包内自带 prompts/）；
 * - saveDir：存档根（{root}/save/，原项目根 runs/ 改名迁入）；
 * - presetsDir / secretsFile / settingsFile：API 预设、密钥、用户设置（root 下三资源）。
 */
export interface UserDirectories {
  username: string;
  root: string;
  assetsDir: string;
  saveDir: string;
  presetsDir: string;
  secretsFile: string;
  settingsFile: string;
}

/**
 * 解析用户资源目录。username 须为合法 handle（`[\w-]+`，复用 safeSegment 防穿越）。
 * 纯路径计算，无任何文件系统访问。
 */
export function resolveUserDirectories(username: string = DEFAULT_USERNAME): UserDirectories {
  const user = safeSegment(username);
  if (!/^[\w-]+$/.test(user)) throw new Error(`非法用户名: ${JSON.stringify(username)}`);
  const root = path.join(PROJECT_ROOT, "data", "users", user);
  return {
    username: user,
    root,
    assetsDir: path.join(PROJECT_ROOT, "data", "assets"),
    saveDir: path.join(root, "save"),
    presetsDir: path.join(root, "api-presets"),
    secretsFile: path.join(root, "secrets.json"),
    settingsFile: path.join(root, "settings.json"),
  };
}
