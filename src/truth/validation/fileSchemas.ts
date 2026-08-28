/**
 * 七个 File schema 的汇聚出口。
 *
 * 两级校验的第一级 = 文件 codec：校验 JSON 与字段类型（schema_version 单点化：
 * 只有 SysFileSchema 携版本字面量，版本闸在 generationRepository.readSaveSet 单点判定）。
 * codec 本体留在各 Store 文件（与容器同文件维护）。
 * 跨文件不变量（第二级）见同目录 saveSet.ts。
 */
export { WorldFileSchema } from "../worldStore.js";
export { CharactersFileSchema } from "../charactersStore.js";
export { EventsFileSchema } from "../events.js";
export { ArchiveFileSchema } from "../archive.js";
export { LoresFileSchema } from "../loreStore.js";
export { SysFileSchema } from "../sysStore.js";
export { PromptsFileSchema } from "../promptsStore.js";
