/**
 * 六个 File schema 的汇聚出口（docs/optimization-review.md §7 建议目录 validation/fileSchemas.ts）。
 *
 * 两级校验的第一级 = 文件 codec：校验 JSON、schema version、字段类型与基础数值范围。
 * codec 本体仍留在各 Store 文件（与容器同文件维护）；整体搬迁属旧 Store 完全降级之后，本片不做。
 * 跨文件不变量（第二级）见同目录 saveSet.ts。
 */
export { WorldFileSchema } from "../worldStore.js";
export { CharactersFileSchema } from "../charactersStore.js";
export { EventsFileSchema } from "../events.js";
export { ArchiveFileSchema } from "../archive.js";
export { LoreFileSchema } from "../loreStore.js";
export { TimeFileSchema } from "../timeStore.js";
