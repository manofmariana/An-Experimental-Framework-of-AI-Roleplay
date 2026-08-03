/**
 * 用户资源目录解析（优化阶段 A4，docs/optimization-review.md §8「用户数据根」）。
 *
 * 单用户阶段固定 handle 为 default_user，但所有资源路径从一开始都经
 * UserDirectories 集中提供，不在 endpoint/业务代码里散落硬编码。
 *
 * 本阶段保持兼容读取：worlds/runs/prompts 仍指向现行 legacy 位置
 * （data/worlds、runs、data/prompts），presetsDir/secretsFile/settingsFile
 * 只定义未来位置（data/<username>/ 下）——不创建目录、不读取。
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
 * - root：用户根（data/<username>/）——未来用户级资源的家；现阶段其下文件尚不存在；
 * - worldsDir / runsDir / promptsDir：现行 legacy 位置（本阶段不迁移数据）；
 * - presetsDir / secretsFile / settingsFile：未来 API 预设、密钥、用户设置的位置
 *   （docs §8 目标结构），现阶段仅定义路径，不创建、不读。
 */
export interface UserDirectories {
  username: string;
  root: string;
  worldsDir: string;
  runsDir: string;
  promptsDir: string;
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
  const root = path.join(PROJECT_ROOT, "data", user);
  return {
    username: user,
    root,
    // legacy 映射：现行位置（兼容读取，不迁移）
    worldsDir: path.join(PROJECT_ROOT, "data", "worlds"),
    runsDir: path.join(PROJECT_ROOT, "runs"),
    promptsDir: path.join(PROJECT_ROOT, "data", "prompts"),
    // 未来位置：仅定义，不创建不读
    presetsDir: path.join(root, "api-presets"),
    secretsFile: path.join(root, "secrets.json"),
    settingsFile: path.join(root, "settings.json"),
  };
}
