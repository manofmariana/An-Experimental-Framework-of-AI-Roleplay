/**
 * 五根真相 Store 成组视图：
 * session 内核（gameSession.ts）与效果规划器（src/application/）共用同一组纯类型 + 纯函数。
 *
 * live 与 draft 同形。draft = cloneTruth 产出的工作副本：编辑/回溯/直编/规划器的
 * 全部变异以它为靶，任何失败（解析/校验/提交）直接丢弃即零副作用；commit 成功后
 * 经 adoptTruth 把数据搬回 live 实例（**Store 身份不变**——GameSession 与派生缓存
 * 持有引用，换实例会让 live 视图失配）。纯内存操作，本模块不做任何 IO。
 */
import { ArchiveStore } from "./archive.js";
import { CharactersStore } from "./charactersStore.js";
import { EventsStore } from "./events.js";
import type { SaveSet } from "./generationRepository.js";
import { LoreStore } from "./loreStore.js";
import { PromptsStore } from "./promptsStore.js";
import { SysStore } from "./sysStore.js";
import { WorldStore } from "./worldStore.js";

export interface TruthStores {
  world: WorldStore;
  sys: SysStore;
  characters: CharactersStore;
  events: EventsStore;
  archive: ArchiveStore;
  loreStore: LoreStore;
  promptsStore: PromptsStore;
}

/** draft 工作副本：各 store.saveData() → structuredClone → 新 store 实例（与 live 完全隔离）。 */
export function cloneTruth(live: TruthStores): TruthStores {
  return {
    world: new WorldStore(structuredClone(live.world.saveData())),
    sys: new SysStore(structuredClone(live.sys.saveData())),
    characters: new CharactersStore(structuredClone(live.characters.saveData()), live.characters.characterDecl),
    events: new EventsStore(structuredClone(live.events.saveData())),
    archive: new ArchiveStore(structuredClone(live.archive.saveData())),
    loreStore: new LoreStore(structuredClone(live.loreStore.saveData())),
    promptsStore: new PromptsStore(structuredClone(live.promptsStore.saveData())),
  };
}

/** draft 数据搬回 live 实例（restoreData 系：内容替换，**Store 对象身份不变**）。 */
export function adoptTruth(live: TruthStores, draft: TruthStores): void {
  live.world.restoreData(draft.world.saveData());
  live.sys.restoreData(draft.sys.saveData());
  live.characters.restoreSnapshot(draft.characters.saveData());
  live.events.restoreData(draft.events.saveData());
  live.archive.restoreData(draft.archive.saveData());
  live.loreStore.restoreData(draft.loreStore.saveData());
  live.promptsStore.restoreData(draft.promptsStore.saveData());
}

/** 收集指定 truth 视图的各 Store 当前数据为一代 SaveSet（commit 的输入）。 */
export function collectSave(truth: TruthStores): SaveSet {
  return {
    world: truth.world.saveData(),
    sys: truth.sys.saveData(),
    characters: truth.characters.saveData(),
    events: truth.events.saveData(),
    archive: truth.archive.saveData(),
    lores: truth.loreStore.saveData(),
    prompts: truth.promptsStore.saveData(),
  };
}
