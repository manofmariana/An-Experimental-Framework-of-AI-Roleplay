export const SAVE_SCHEMA_VERSION = 5;

export const INCOMPATIBLE_SAVE_MESSAGE =
  "存档结构版本不兼容或核心文件版本混合，请新建会话/重启服务（不支持旧存档迁移）";

export function incompatibleSave(cause?: unknown): Error {
  return new Error(INCOMPATIBLE_SAVE_MESSAGE, cause === undefined ? undefined : { cause });
}
