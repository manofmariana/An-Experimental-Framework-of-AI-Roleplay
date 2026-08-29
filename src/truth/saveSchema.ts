export const SAVE_SCHEMA_VERSION = 18;

/**
 * version 类加载错误的统一措辞（保留"请新建会话/重启服务"提示——
 * resume/auditContracts 测试与旧用户认知均锚定该措辞；错误的机器判别走 SaveLoadError.kind）。
 */
export const INCOMPATIBLE_SAVE_MESSAGE =
  "存档结构版本不兼容或核心文件版本混合，请新建会话/重启服务（不支持旧存档迁移）";
