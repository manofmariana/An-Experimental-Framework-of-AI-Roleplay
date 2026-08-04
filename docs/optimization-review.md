# 架构优化审查意见

本文记录逐项审查后已经确认的优化意见。仅记录已完成讨论并达成一致的事项；后续事项在确认后追加。

## 1. 真相层原子提交

### 现状

当前一次逻辑步骤会依次修改并立即持久化多个 Store，例如：

- world deltas、时钟和 pipeline；
- 一个或多个 character 的 timer、location、group、relations 等字段；
- events、archive、lore 和 working set。

完整 `var_changes` 通常在这些修改完成后才写入 pipeline。任一中间写盘失败或进程退出，都可能留下部分文件已更新、部分文件未更新的混合状态；此时回滚记录也可能不完整。已完成 GM 步的编辑还存在先反转旧变化、再校验新裁决包的顺序，校验失败时会留下旧变化已被反转的状态。

### 决定

采用：

> 增量 `CommitPlan` + 完整 Generation + `CURRENT` 原子切换 + 保留当前及上一 Generation。

`CommitPlan` 只记录本次新增或修改的条目，不保存完整存档。事务层把 plan 应用到当前内存状态，完成全部校验后生成一个完整、自足的新 Generation。只有新 Generation 完整写入并通过校验后，才原子替换 `CURRENT` 指针。

外部只能观察到提交前或提交后的完整状态，不得观察到中间状态。

### CommitPlan 形式

暂不引入按领域划分的判别联合 `TruthOperation`。当前预期膨胀主要发生在 world 和 characters 内部，例如一次增加或修改多个 character 条目；现有通用 `VarChange` 模型已经可以表达路径级新增、修改和删除，引入多种 operation 类型会增加 schema、执行器、回滚和版本维护成本，目前收益不足。

建议采用常规变更记录：

```ts
interface CommitPlan {
  transactionId: string;
  baseRevision: number;
  reason: "step" | "gm" | "rollback" | "admin_edit";
  changes: VarChange[];
}

interface VarChange {
  path: string;
  before: unknown;
  after: unknown;
  before_exists?: boolean;
  after_exists?: boolean;
}
```

路径应从真相根开始，能够覆盖不同数据域，例如：

```text
world.region.harbor.fog
characters.C1001.timer
characters.C1002.relations.C1001
characters.C1003.inventory.2
pipeline.working_set
```

一次 plan 可以包含任意数量的 world 或 character 变化，因此可以适应角色数量、角色字段和世界状态在一局存档中动态增长。

### 常规变更记录的边界

通用 `VarChange` 只负责描述最终状态差异，不负责表达业务命令。GM、角色、玩家和用户编辑仍须先经过各自的 schema、权限和领域规则校验，再统一产生 `VarChange[]`。

以下行为不应依赖模糊的数组下标操作：

- event/archive 的追加和按 seq 截断；
- character 的新增或删除；
- 大型数组中间插入或重排。

对这些结构，plan 生成器应先计算变更后的完整字段值，再记录该字段的 before/after；或者使用稳定 ID 的对象映射。只有在此方式出现明确的性能或歧义问题后，才考虑为少数结构增加专用 operation，不预先建立全套领域操作联合。

### 提交流程

1. 读取当前 revision 和真相状态。
2. 解析输入并完成 schema、权限和领域语义校验。
3. 生成完整 `CommitPlan`，确认 `baseRevision` 等于当前 revision。
4. 在 copy-on-write 的下一状态上应用全部 `changes`。
5. 校验修改后的完整 schema 和跨文件不变量。
6. 将完整状态写入新的临时 Generation 目录。
7. 对临时 Generation 重新读取并校验。
8. 将临时目录确认为正式 Generation。
9. 原子替换 `CURRENT`，此后才切换 Store 的内存根引用。
10. 保留当前和上一 Generation；更旧版本由独立的 best-effort 清理删除。

清理失败只记录告警，不得把已经成功切换的事务报告为失败。启动时清理未完成的临时 Generation。

### Generation 与逻辑回滚

Generation revision 与游戏 seq 是两个独立概念：

- Generation revision 是物理存储提交版本，只能递增；
- pipeline seq 是游戏逻辑步骤，回滚时可以下降。

用户回滚时，仍使用当前 Generation 内的 archive、events、lore changelog 和 `var_changes` 计算目标状态，然后把回滚结果作为一个新的 `CommitPlan` 提交到新的 Generation。删除更旧 Generation 不影响现有逻辑回滚，因为最新 Generation 必须包含允许回滚所需的完整历史数据。

保留上一 Generation 的用途是存储灾备，而不是游戏回滚。

### 用户主动编辑

用户编辑存档也必须经过同一事务入口：

1. 编辑请求携带打开编辑页面时的 `baseRevision`；
2. 服务端校验完整输入并计算与当前状态的 diff；
3. 若当前 revision 已变化，则拒绝旧编辑，避免覆盖新产生的游戏状态；
4. 将 diff 记录为 `reason: "admin_edit"` 的 CommitPlan；
5. 通过相同 Generation 流程提交。

任何字段校验失败时，内存、正式文件和 `CURRENT` 都必须保持不变。

### 资源约束

当前不采用不可变 events/archive 分段。项目存档通常不超过百兆，接受每次提交完整写入新 Generation 所产生的磁盘写入放大。

内存中只保留当前状态、增量 plan 和 copy-on-write 的下一状态；不缓存历史 Generation。完整 JSON 序列化仍会产生短时内存峰值，但在当前存档规模约束下可以接受。如果未来实测出现明显内存或磁盘瓶颈，再评估流式序列化或不可变分段，不提前增加复杂度。

### 验收条件

- 任一写入、校验或切换点故障后，重新加载只能得到完整旧状态或完整新状态。
- 非法 GM 编辑和非法用户编辑失败前后，内存及当前 Generation 保持不变。
- archive、pipeline、events 的 seq 关系通过跨文件校验。
- 当前 Generation 损坏时可回退到上一 Generation，并明确报告恢复行为。
- rollback 提交后 Generation revision 递增，而游戏 seq 正确回到目标步骤。
- `npm run typecheck` 与 `npm test` 通过，并新增覆盖写盘故障、revision 冲突和恢复流程的测试。

## 2. 调度派生模块收敛

### 保留原则

保留“下一步从真相状态派生”的现有方向，不新增必须与 timer/group/acted 同步维护的持久化行动者游标。恢复、回滚、编辑和正常续跑继续通过同一个派生出口确定下一步。

### `src/scheduler/derive.ts`

新增纯逻辑模块 `src/scheduler/derive.ts`，只负责从最小调度快照派生下一命令，不读取 Store、archive 或 LLM，也不执行写盘。

该模块包含：

- `SchedulerSnapshot`、`SchedulerCharacter`、`ScheduleSetup`；
- 类型完备的 `NextCommand` 判别联合；
- `phaseOf(command)`；
- `deriveNext(snapshot)`；
- 前台组选择 `selectFront(...)`；
- GM trigger 同先攻批完成判断；
- 下一个行动者与周期边界判断；
- `expectedGmTimerCids(...)`。

`NextCommand` 必须从类型上排除非法组合，并消除 `d.cid!` 一类非空断言。建议形状：

```ts
type NextCommand =
  | { type: "player"; reason: "turn" | "deadlock"; setup: ScheduleSetup; invitation?: PendingInvitationView }
  | { type: "character"; cid: string; setup: ScheduleSetup; invitation?: PendingInvitationView }
  | { type: "gm"; setup: ScheduleSetup }
  | { type: "prose"; setup: ScheduleSetup };
```

`ScheduleSetup` 只描述语义数据，例如目标时钟、需要清除 acted 的 CID、是否增加周期计数。它不生成 `VarChange`，也不知道 `world.time` 等持久化路径；application/CommitPlan 层负责把 setup 转成常规变更记录。

现有 `src/scheduler/simulator.ts` 继续保留 nextDue、orderGroups、initiativeBatches、reconcileGroups 等无状态基础算法；`derive.ts` 组合使用这些算法，不复制实现。

### `src/scheduler/invitations.ts`

邀请历史解释单独放入 `src/scheduler/invitations.ts`，不放进 `derive.ts`。该模块维护可重建的 `InvitationProjection`，向 `derive.ts` 只提供当前 pending invitation 视图。

正常推进时，每个步骤的真相事务提交成功后调用一次 `projection.applyStep(committedStep)`，只增量处理该步骤：

- contact 步新增邀请及全部目标；
- GM 步把此前未生效邀请标为 armed；
- 邀请应答步按稳定 `contactSeq` 将对应目标标为 accepted/rejected；
- 无关步骤不改变投影。

以下场景从 archive + current 完整重建一次：

- 读档；
- 回滚；
- 编辑 contact/confirm 或其他会影响邀请语义的步骤；
- 用户直接编辑 archive/current；
- Generation 灾备恢复。

投影是派生缓存，不进入 Generation，也不进入 CommitPlan。增量更新必须发生在真相事务成功切换 `CURRENT` 之后；投影更新失败时丢弃并从已提交历史重建，不得反向撤销已成功的真相提交。

邀请应答结果必须显式记录 `contactSeq`、target 和 accepted，停止通过 `${cid}.timer` 的 `after === 0` 猜测是否已应答。

### 留在 application 层的内容

以下职责不进入 scheduler：

- 从 CharactersStore、WorldStore 和邀请投影构建 `SchedulerSnapshot`；
- `applyScheduleSetup` 对应的 CommitPlan/VarChange 生成；
- marker、confirm、reject 的领域效应执行；
- startStep、finishStep、runPipeline；
- pause options 和 UI 是否立即执行下一命令的策略。

### phase

`pipeline.phase` 不再作为持久化真相字段；它由 `phaseOf(deriveNext(snapshot))` 查询时计算。这样避免存储 phase 与角色调度变量漂移。若将来实测查询成本过高，可以把它作为可丢弃缓存，但不得成为权限判断或恢复的权威来源。

### 验收条件

- `deriveNext` 可以只用内存快照进行表驱动测试，不创建 Store、Agent、LLM 或临时存档。
- `NextCommand` 的每个分支携带执行该命令所需的全部字段，调用方无 `cid!`。
- 正常推进邀请投影只处理新提交步骤，不扫描完整 archive。
- 读档、回滚和编辑后重建的邀请投影与从头顺序 applyStep 的结果一致。
- 同一调度快照在正常运行、恢复和回滚后产生相同 `NextCommand`。
- scheduler 模块保持无 IO、LLM、server 和 truth Store import。
- 多目标 contact 沿用已有调度规则，不新增邀请专属周期、固定应答顺序或应答游标；每次从 pending 目标中按当前先攻规则派生下一人。
- 增加多人邀请集成测试：多目标按先攻降序且同值按 CID 依次应答；接受/拒绝混合时每人只应答一次；目标含玩家时正确停在 `await_player` 并在输入后继续；已同组或已删除目标安全跳过；回滚、读档及编辑后只继续尚未应答目标；多个并存 contact 的处理结果保持确定性。

## 3. 正常输出与编辑重放共用效果规划器

### 核心语义

编辑活动必须被理解为该步骤的一次新输出。正常输出与编辑重放必须使用同一个效果规划器，不允许编辑路径手工复制 relations、acted、邀请、markers 或 GM effects 的处理规则。

玩家与 NPC 角色的领域行为保持一致；两者只在取得 `DecisionPackage` 的方式上不同：

- 玩家输入经解析得到 `DecisionPackage`，不调用 LLM；
- NPC 角色调用 LLM 并经 schema 校验得到 `DecisionPackage`；
- 两者随后统一进入 `planActorDecision(...)`。

GM 正常裁决与 GM 编辑统一进入 `planGmAdjudication(...)`。

### 即刻生效与事务草稿

“先在事务草稿中规划”不表示延迟到下一轮才生效。正确流程是：

1. 在不可见的事务草稿中撤销旧 effects（编辑时）并计算完整新 effects；
2. 完成 schema、权限和跨状态不变量校验；
3. 通过 CommitPlan/Generation 一次原子提交；
4. `CURRENT` 切换成功后，新的 world、characters、initiative、acted、group 等立即成为唯一可见状态；
5. 立即重建受影响的派生投影并重新调用 scheduler，刷新下一行动者和输入权限。

因此，用户编辑 initiative 后，如果 NPC 已移动到玩家之前，编辑提交完成后的下一次权限检查必须立即得到该 NPC；服务端应拒绝玩家继续输入，不能依赖编辑前 UI 展示的 `await_player`。

所有编辑、玩家输入和 continue 命令须经同一会话串行入口并携带 revision，防止编辑提交与旧输入并发穿透。

### 统一效果规划器

规划器放在 `src/application/`：

```text
src/application/
  actorEffects.ts
  gmEffects.ts
  workingSetProjection.ts
```

建议接口：

```ts
planActorDecision(draft, context): StepEffects
planGmAdjudication(draft, context): StepEffects
```

`planActorDecision` 统一处理 working set、relations、普通行动 acted、邀请接受/拒绝、markers 和邀请应答记录。`planGmAdjudication` 统一处理 world deltas、timer/location、周期和 trigger 复位、acted、group/initiative、channel、events 与 working set 清算。

规划器只修改事务草稿并返回常规 `VarChange[]`，不得直接持久化正式 Store。

### 步骤变化分段

删除依赖数组位置的 `effects_from` 和 `markers_from`，步骤变化明确分成：

```ts
interface StepChanges {
  setup: VarChange[];
  effects: VarChange[];
}
```

- `setup`：调度在该步骤执行前产生的变化，如时钟推进、周期增加、后台 acted 清理和邀请激活前置变化；
- `effects`：本次 DecisionPackage 或 AdjudicationPackage 产生的变化。

正常执行记录 `setup + effects`；编辑保留 setup，在草稿中反转旧 effects 后调用同一规划器生成新 effects；中止且尚未应用业务输出时 effects 为空；逻辑回滚倒序反转 setup 和 effects，不重新解析旧输出、不重新执行规划器，也不重新投骰。

### 确定性计算层与执行入口

未来固定代码动作、纯数值规则和投掷应进入独立的确定性计算层，而不是交给 GM。该层必须在任何“执行下一行动”之前运行，不能只挂在 UI 的继续按钮上。

建议建立统一入口：

```ts
prepareNextCommand(): NextCommand
```

玩家输入权限检查、用户点击继续和自动继续都必须调用它。流程为：

1. 基于最新已提交状态创建一个不可见的事务草稿；
2. 在同一草稿上运行固定规则、数值计算及其连锁变化；
3. 直到草稿达到固定点，期间只累积一个 CommitPlan，不产生中间 Generation；
4. 若草稿相对当前状态有变化，则一次原子提交并生成一个新 Generation；
5. 提交成功后重建受影响投影，再调用 `deriveNext`；
6. 返回最终 `NextCommand`，随后才允许玩家输入或执行 NPC/GM/prose。

这是一个收敛步骤，应设置最大迭代次数并检测重复状态签名；规则无法达到固定点时丢弃整个草稿、明确报错并停止，禁止无限循环。投骰结果在草稿中只生成一次并属于该次计算提交的 effects；恢复与回滚不得隐式重投。

### working set 投影合并

现有 `rebuildWorkingSet()` 与 `preGmWorkingSet()` 的核心算法相同：都从给定步骤序列中找到最后一个 gm/prose 边界，再收集其后的 player/character 步。区别只在调用方传入的截止位置：

- `rebuildWorkingSet()` 把回滚目标 current 包含在输入中；若目标本身是 gm/prose，则结果为空；
- `preGmWorkingSet()` 编辑当前 GM 时只读取 archive，天然排除了当前 GM，因此得到 GM 之前尚未清算的角色步骤。

合并为纯函数：

```ts
projectWorkingSet(steps: readonly StepLike[]): WorkingSetEntry[]
```

调用方负责传入正确的步骤切片：回滚传“archive 到目标前 + 目标 current”，GM 编辑传“不含当前 GM 的 archive”。投影函数不需要知道调用场景，也不需要额外模式参数。

### 验收条件

- 相同 DecisionPackage 经正常玩家输入、正常 NPC 输出和编辑重放时，除明确的输入来源字段外，产生相同领域 effects。
- 相同 AdjudicationPackage 经正常 GM 输出和编辑重放时产生相同领域 effects。
- 编辑 initiative/group/timer 后立即重新派生输入权限；旧 `await_player` 不得允许玩家越过新排到前面的 NPC。
- `StepChanges` 不再使用数组下标定位不同效果类别。
- 回滚只消费记录的 before 值，不调用 LLM、planner、计算层或骰子。
- `projectWorkingSet` 对回滚目标、GM 前状态和普通当前状态均有表驱动测试。
- `prepareNextCommand` 在玩家输入、手动继续和自动继续三条路径共用，并有固定点、循环检测和迭代上限测试。

## 4. 无状态模型调用与 LLM 旁路日志

### 定位

GM、角色和正文都没有工具权，也不维护模型对话历史；每次激活都是一轮新的模型调用，连续性完全来自本次编译注入。因此它们不需要被建模为长期持有真相副本的自治 Agent，更准确的职责是三类无状态调用规则：

- Character activation：CharacterContext → DecisionPackage；
- GM activation：GmContext → AdjudicationPackage；
- Prose activation：ProseContext → text。

可保留 Character/GM/Prose 的模块名称表达协议边界，但实例不得长期缓存 recentEvents、proseWindow、currentScene、worldSnapshot、clock、cast 或 CharactersStore 引用。每次调用由 application context builder 从最新已提交真相和派生投影构建完整只读上下文。

不要求每个角色各持有一个长期 CharacterAgent 实例。可以由一个 `CharacterActivation` 调用规则服务所有 NPC；角色差异全部来自本次传入的 CID、manifest、私域快照、可见事件、relations、lore 和场景上下文。玩家不走模型调用，但其 DecisionPackage 进入与 NPC 相同的 actor effects planner。

### 调用端口

模型调用规则依赖最小 `ChatPort`，不依赖具体 OpenAI 客户端：

```ts
interface ChatPort {
  chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
}
```

AbortController 属于单次 activation，由 application 保存当前 request handle。当前仍保持角色串行，不提前引入并行 Agent；接口只消除共享 `LLMClient.current` 的隐藏状态，为未来并行留下安全边界。

Character 与 GM 共用轻量 `runStructuredActivation<T>`，统一模板编译后的模型调用、流式通知、JSON 提取、schema 校验、语义校验、重试和中止。第二次重试应携带第一次校验错误。Prose 使用独立文本调用流程，并继续保持无工具权。

### 跨存档隔离

曾出现的“新存档 NPC 记得上一存档事件”不能仅凭当前证据断定由长期 CharacterAgent 缓存造成。`SessionManager.reset()` 会创建新的 GameSession 和新 CharacterAgent，按正常路径旧实例不应被复用；已知问题记录也指出旧 session 在途任务/WS 广播残留是重要嫌疑。

但是当前 Agent 内长期缓存事件与上下文确实扩大了串档风险面：只要会话切换竞态、旧任务收尾或实例引用替换有一处不完整，旧缓存就可能继续参与调用。改为无状态 activation 后，NPC 能看到的内容只来自带明确 runId/revision 的本次 Context，结构上消除此类缓存泄漏通道；仍需另行收敛 SessionCoordinator 的旧会话任务与广播隔离，才能完整解决已报告现象。

### 可编辑步骤结果与 LLM 旁路日志

需要区分两类数据：

1. **最后有效结果文本**属于 Generation。每个角色、GM 和正文步骤只保存最后一次有效结果文本：角色/GM 结果是可解析为 package 的 JSON 文本，正文结果是正文文本。该文本可能来自模型，也可能来自用户编辑；不记录来源，也不额外保存一份重复的 package。需要使用结构化 package 时，从当前结果文本解析并校验；读档、回滚到该步骤或打开历史编辑时，直接把当前结果文本塞入过去的卡片，不依赖可能已滚动出窗的 LLM 日志。
2. **LLM 调试日志**不属于 Generation。提示词 messages 和思维链 reasoning 可继续保存在当前 runId 的旁路目录并按 seq 对齐，用于最近调用查看和诊断，不参与原子提交、调度、编辑或逻辑回滚。

建议但不强制在旁路日志中扩展保存模型 raw、attempt、status 或 call id；这些字段只服务诊断，是否实现不影响本轮架构决定。当前 `llm-recent` 继续维持滚动窗口即可，不要求随游戏回滚删除。

正常输出或用户编辑都只产生一个新的最终结果文本：角色/GM 文本提交前解析为 package 并校验，正文文本按正文规则校验；文本与本步其他 effects 在同一 Generation 中原子替换。旁路日志缺失或写入失败不得影响结果提交和后续编辑能力。

旁路日志必须严格使用 activation 创建时绑定的 runId，不得从可切换的全局 current session 临时读取。日志写入失败只告警，不得把已经成功的 LLM 响应改判为失败，也不得触发重复模型调用。

### 建议位置

```text
src/application/
  characterContextBuilder.ts
  gmContextBuilder.ts
  structuredActivation.ts
  textActivation.ts

src/llm/
  chatPort.ts
  openaiChatAdapter.ts
  callLog.ts
```

### 验收条件

- 连续两次 activation 使用不同 Context 时，第二次 prompt 不含第一次 Context 独有内容，除非最新 truth/projection 明确再次注入。
- 新建或载入 run 后的所有 Context、模型请求和旁路日志都携带同一 runId/revision；旧 run 在途完成结果不得注入或广播到新 run。
- Character activation 不持有 CharactersStore、cast 或跨调用事件缓存；动态增加/改名角色后下一次调用直接读取最新上下文。
- fake ChatPort 可独立测试 Character/GM/Prose 协议，无需 monkey-patch `LLMClient.prototype`。
- 两个重叠请求可以独立完成或中止，不共享单一 AbortController。
- recent/call log 写盘失败不改变模型调用成功语义。
- 日志按 runId、seq、agent、attempt/call id 可定位，游戏回滚不要求删除日志。

## 5. SessionCoordinator、会话隔离与增量同步

### 单一命令协调器

建立 `src/application/sessionCoordinator.ts`。所有会改变活跃会话或真相状态的操作进入同一个串行入口：player input、continue、rollback、rollback-and-continue、result edit、direct edit、new session 和 load session。

删除独立的 reroll 领域逻辑。重 roll 的语义保持为 rollback 到上一目标步骤后 continue，但前端不发送两条可插队消息；改为一条 `rollback_and_continue` 复合命令，由 Coordinator 在同一个队列任务中顺序执行两项已有操作。

mutation 携带客户端看到的 `baseRevision`。revision 不一致时拒绝陈旧输入或编辑，避免旧页面覆盖新状态。pause options 是运行策略，不产生 Generation，但冲突组合必须由服务端 schema 校验。

### 会话切换与强制结束

new/load 也必须排入 Coordinator。当前 activation 在途时，UI 提供等待和“强制结束并切换”选项；强制结束复用正常 stop 的中止能力：

1. 定向中止旧 run 的当前 activation；
2. 等待旧任务捕获中止并完成 interrupted 步骤收尾；
3. 禁止旧任务在此后提交或广播；
4. 创建/载入新 Session；
5. 增加 session epoch 并原子替换 active session；
6. 发布新会话 Snapshot。

若 SDK 中止超时，则使旧 epoch 失效，旧任务晚到结果必须被丢弃，不能提交真相、更新投影、写入当前 run 日志或广播。

stop 是队列外的定向中止信号，携带 `runId + activationId`，只在 LLM activation 在途时启用；中止后的真相收尾仍由原队列任务提交。pause 只在完整步骤边界阻止自动启动下一步，不中断 LLM，也不产生 interrupted 步骤。

### 消息身份

所有状态同步消息携带 `runId + revision`。流式消息发生在步骤提交之前，额外携带 `activationId`；前端只接受当前 run 和当前 activation 的增量。客户端 mutation 携带 `baseRevision`。

旧 run 或旧 revision 消息到达时直接丢弃。新建/载入会话后，旧 activation 即使完成也不得污染当前 UI。这与无状态 activation 一起关闭跨存档事件和输出泄漏通道。

### Snapshot 与增量 Transition

采用两类协议，不在每次命令后重复发送完整 world、characters 和 events：

```ts
interface SessionSnapshot {
  runId: string;
  revision: number;
  state: StateView;
  events: EventView[];
  history: HistoryView;
  pipeline: PipelineView;
}

interface SessionTransition {
  runId: string;
  fromRevision: number;
  revision: number;
  reason: string;
  pipeline: PipelineView;
  changed: {
    world?: WorldView;
    characters?: Record<string, CharacterView | null>;
    appendedEvents?: EventView[];
    truncateEventsAfterSeq?: number;
  };
  historyPatch?: HistoryPatch;
  editedResult?: { seq: number; kind: string; resultText: string };
}
```

Snapshot 用于首次连接、重连、新建/载入会话、客户端发现 revision 跳号或增量应用失败后的恢复。Transition 表示一次命令从 `fromRevision` 到 `revision` 的可见变化；前端只有在本地 revision 等于 `fromRevision` 时应用，否则请求新 Snapshot。

前端协议不直接暴露底层 `VarChange[]`。world 可按当前规模发送变化后的完整 world view；characters 只发送受影响 CID 的完整当前视图，`null` 表示删除；events 使用 append 或按 seq 截断；history 使用与卡片语义一致的 patch。一次命令只广播一个同 revision Transition，避免分开发送 turn_done/state/events/pipeline 造成部分刷新。

### 一致快照 query

query 不产生 Generation，也不必进入 mutation 队列，但必须在开始时捕获一个不可变的当前 Generation 根，并从同一个 revision 派生 state、events、history 和 pipeline。禁止分别从可变化的全局 Session/Store 零散查询后再拼装响应。

这项是未来局域网或其他联机功能的必要前置。联机意味着多个客户端可同时查询、观察和提交命令；如果 query 没有 revision 快照语义，即使只有一个前台 Session，也会出现不同客户端拿到不同提交时刻的 state/events/pipeline，无法可靠应用增量、检测丢包、拒绝陈旧命令或在重连后恢复一致状态。

联机层应建立在以下已完成能力上，而不是自行补救：

- 服务端权威单写 SessionCoordinator；
- mutation 串行化和 baseRevision 冲突检测；
- query 的不可变 revision Snapshot；
- `Snapshot + Transition` 同步；
- runId/revision/activationId 消息身份；
- 客户端 revision 跳号检测与全量重同步。

这些能力只解决一致性，不预先引入多人控制权、权限、认证或冲突合并策略；后者在真正实现联机时另行设计。

### 验收条件

- 延迟 LLM 期间强制切换会话后，旧 run 无任何真相提交或当前 UI 广播。
- stop 可立即中止当前匹配 activation，不等待普通命令队列尾部。
- rollback-and-continue 两步之间不能插入其他客户端命令，也不发布中间 rollback Transition。
- 每个 mutation 只发布一个 `fromRevision → revision` Transition。
- 客户端仅在 revision 连续时应用增量；跳号后请求 Snapshot 并恢复一致。
- 两个并发 query 各自返回内部一致的单 revision Snapshot，即使期间发生提交。
- 两个局域网客户端同时观察、查询和提交陈旧命令时，只有 revision 匹配的 mutation 被接受，双方最终收敛到同一 Snapshot。
- 用真实 WebSocket 客户端和可控延迟 ChatPort 测试会话切换、重连、双客户端、stop 与 revision 跳号，不再主要依赖源码正则断言。

## 6. 契约归属、三层可扩展资源与声明式规则

### 阶段定位

本节全部内容定位为 **P1 的收尾优化与 P2 的结构准备**。目标是建立可扩展变量、规则、提示词和世界包生态所需的所有权、版本、提交、回滚与依赖边界，不在本阶段填充具体 P2 玩法内容，不提前设计完整 TAG 语法、具体动作库、数值公式、UI 样式或可执行插件。

P1 收尾应完成结构承载能力和核心不变量；P2 再在这些稳定接口上定义、安装和编辑具体变量模板、声明式动作、计算规则、TAG 策略与界面模板。

### 契约与依赖方向

逐步建立稳定契约层，消除底层模块对具体执行模块的反向依赖：

- `CharacterManifest` 是具体角色实例的初始化契约，不是变量模板；迁入 `contracts/character.ts`。
- `CharacterState` 最终也归入角色真相契约；`CharactersStore` 只负责持久化。
- `PromptMessage` 迁入 `contracts/prompt.ts`，使 compiler 不依赖具体 LLM client。
- `safeSegment/runId` 校验迁入 application 输入契约，供 HTTP、WS、Coordinator 和存档加载复用。
- `VarChange`、path get/set/delete 与正反向应用迁入 `truth/varChanges.ts`，不再由 `worldStore.ts` 所有。
- 删除未使用且会与 `NextCommand` 重叠的旧 `Activation/PerceptionBrief` 契约。
- `types.ts` 不一次性搬空；在 Character、Decision、Adjudication、Event、Step、Prompt 和协议功能分别改造时迁入对应契约文件。

增加轻量 import architecture tests：contracts 不导入 truth/application/LLM/server；scheduler 不导入 IO、Store 或 LLM；truth 不导入 activation/application/server；compile 不导入具体 LLM client。

### 系统变量与常规变量

变量体系分为两类：

1. **系统变量**：核心引擎运行所依赖的稳定字段，例如 timer、group、initiative、acted、location、isPlayer、channel，以及事件的 id/seq/tags 等结构字段。其 schema 由系统固定。实时编辑可以修改 schema 允许的值，但不得删除字段、改变类型或改变结构格式；写入还须通过领域不变量校验。
2. **常规变量**：由默认资源、世界包或具体存档定义的扩展 world/character 变量。结构受当前存档的变量 schema 校验，可以在游玩中新增、修改或删除。

`reaction/level` 等字段是否属于系统变量，以实际引擎是否硬依赖为准：被 scheduler 或不可替换核心规则直接读取的保留为系统变量；只服务可替换规则的字段进入默认扩展 schema。

状态直编和工具层必须通过统一 SchemaRegistry 检查系统字段保护，不能依赖前端隐藏按钮。任何对系统变量的删除、类型变化或非法格式修改在生成 CommitPlan 前拒绝。

### 三层可扩展资源

变量模板、动作定义、计算规则、从动变量规则、提示词模板、lore 和 UI 描述均采用三层资源模型：

```text
系统默认层 → 世界设定包层 → 具体存档层
```

- 系统默认层提供可运行的基础版本；
- 世界包层按稳定资源 ID 覆盖或扩展默认内容，可分享、安装和编辑；
- 新会话创建时解析前两层并复制成该存档的独立资源版本；
- 游玩过程中新增或修改变量 schema、动作定义、计算规则、从动变量规则、lore 等，只修改存档层，不污染世界包和系统默认；
- 运行期读取只读取存档层解析结果，不在每轮重新混合外部世界包，避免世界包升级改变旧存档语义。

资源按文件或稳定 ID 覆盖，不对任意 JSON 做无规则深合并：prompt 按模板 ID，变量 schema 按命名空间/定义 ID，action 按 action ID，计算与从动规则按 rule ID，UI 按 panel/field ID。除 scheduler、系统变量不变量和 Generation 提交等不可替换核心计算外，所有可扩展计算规则均遵循这三层模型。

建议世界包扩展结构：

```text
data/worlds/<setId>/
  prompts/
  schemas/
    world.variables.json
    character.variables.json
  rules/
    actions.json
    calculations.json
    derived-fields.json
  ui/
```

存档 Generation 中保存解析后的存档层 schema/rules/UI/lore，使当前及上一 Generation 都是自足版本。

### 变量 Schema、动作定义与规则执行器

不要建立同时负责路径写入、类型校验、动作计算和 UI 的万能解析器。拆为：

- 通用 path/VarChange engine：记录状态差异，负责新增、修改、删除和反向恢复；
- SchemaRegistry：组合固定核心 schema 与存档层扩展 schema，验证状态结构；
- ActionRegistry：按稳定 action ID 管理当前存档可用的声明式动作；
- CalculationRegistry：按稳定 rule ID 管理当前存档可用的通用计算与从动变量规则；
- RuleEngine：执行受限算子、读取变量、投骰并生成 `VarChange[]` 和结构化计算结果；
- Prompt pipeline：读取经 schema 验证的状态并投影，不负责动作执行。

现阶段世界包和存档自定义动作只允许声明式规则，不允许携带任意 TypeScript/JavaScript。动作定义可以引用扩展变量路径、声明参数和前置条件、调用内置算子、产生 effects，并标记是否需要 GM 根据计算结果叙述后果。未来可执行插件属于另一个需要签名、权限和隔离的生态，不在本阶段范围内。

例如存档运行到第 20 轮新增 `world.teams` 时，同一个结构变更事务可以包含：

- 存档层 world variable schema 新增 Team/Task 定义；
- `world.teams.<id>` 实例值新增；
- 存档层 ActionRegistry 新增引用 team.level/task 的动作；
- 存档层 CalculationRegistry 新增动作所需公式或从动字段规则；
- 对应 UI 字段定义新增。

完整草稿先校验 schema、实例值、动作引用、计算规则依赖和 UI 引用，再作为一个 Generation 原子提交并立即生效。

### 结构变更、动作定义与回滚

`VarChange` 能表达对象字段的即时新增和删除：`before_exists=false` 表示新增前不存在，反向时删除；`after_exists=false` 表示本次删除，反向时恢复 before。对稳定 ID 对象映射天然适用。数组中间插入/重排不建议依赖易漂移下标，应记录整个小数组 before/after，或改用稳定 ID 映射。

变量 schema、动作定义、计算规则、从动变量规则和 UI 定义也属于存档真相资源，结构变更必须进入同一步骤的 `StepChanges.effects` 和 CommitPlan，而不是只改外部文件。回滚跨越该步骤时，按 before 值同时恢复：

- 变量实例；
- 变量 schema；
- 动作定义；
- 通用计算规则；
- 从动变量计算规则；
- UI 定义及其他关联资源。

由此，回滚到某变量尚不存在的时刻时，引用该变量的存档层动作与计算规则也会回到当时版本或被删除，不会留下悬空动作或用新公式解释旧状态。

提交和回滚后必须运行引用完整性校验：所有动作和计算规则的读取/写入/依赖路径必须能由当前核心或扩展 schema 解析；删除 schema/变量前必须同时删除或修改引用它的动作与规则，或者整个事务拒绝。工具修改若跨多个资源，必须形成一个原子 CommitPlan。

普通游戏步骤只反转其记录的状态变化；结构定义何时变化就锚定到哪个 seq。若未来工具操作使用独立计数，也必须带关联游戏 seq，使回滚跨越该结构版本时绑定恢复对应资源，不能只回滚变量实例。

### 从动变量

从动变量统一采用物化存储，不使用仅在 UI/query 阶段临时计算的视图派生值。原因是 Prompt provider、动作规则、GM/角色上下文和事件生成都可能读取这些变量；它们必须在同一 Truth Snapshot 中有明确、可审计、可回滚的当前值。

例如年龄可保存源字段与物化结果：

```text
character.vars.birth_time
character.vars.age
```

存档层 CalculationRegistry 保存 age 的声明式规则：依赖 `world.time` 与 `birth_time`，目标为 `character.vars.age`。当 world.time 或 birth_time 在事务草稿中变化时，`prepareNextCommand` 的确定性计算层按依赖图更新 age，并把 age 的 before/after 与源变化放入同一个 CommitPlan、同一个 Generation。任何后续 Prompt、规则或 UI 都直接读取已物化的 age。

从动变量规则形状可为：

```ts
interface DerivedFieldDefinition {
  id: string;
  target: string;
  dependsOn: string[];
  expression: DeclarativeExpression;
}
```

规则定义本身遵循系统默认层、世界包层、具体存档层三层版本；存档 Generation 保存当前解析版本。规则新增、修改或删除与变量 schema、目标字段当前值一起原子提交并绑定 seq。回滚跨越规则变更时同时恢复规则版本和物化值，禁止使用当前新规则重新解释旧轮次。

确定性计算层只在事务草稿上运行到固定点，随后一次提交；不为每个从动字段单独创建 Generation。依赖图必须拒绝循环，计算结果必须通过目标字段 schema。系统调度与 Generation 原子提交等不可替换核心计算不进入可自定义 CalculationRegistry；其他声明式通用计算和从动规则均可三层覆盖并随存档回滚。

TAG 过滤只控制数据是否进入具体提示词，不参与或改变从动变量的真相计算。

### 提示词组装与 P2 TAG

`PromptMessage` 契约迁移不改变 P2 组装能力。管线保持：

```text
Truth Snapshot
→ 收集候选数据
→ 数据条目级 TAG 过滤
→ provider 投影为 PromptFragment
→ 可选的片段级 TAG 过滤
→ 序列化占位符内容
→ 静态模板组装
→ PromptMessage[]
```

占位符是 provider 入口，不默认把 tag 绑定到占位符名称；tag 优先属于 event、lore、memory、变量节点等数据条目。为未来可能的第二次过滤，provider 可返回带可选 tags 的 `PromptFragment[]`，但在 P2 规则未冻结前不强迫所有 provider 标签化。compiler 继续只负责模板与已准备内容的纯组装。

### Event 的独立性

Event 属于真相但不是普通 world 状态变量。它具有稳定 ID、seq/time、known_by tags、追加与按 seq 截断、窗口查询和认知投影语义，应继续作为独立日志模型。普通变量表示“当前是什么”，Event 表示“发生过什么”。二者共用 Generation 原子提交和 TAG 基础设施，但不共用同一种集合操作接口。

### 验收条件

- 世界包缺少 prompt/schema/action/calculation/derived-rule/UI 时正确回落系统默认；新会话复制解析结果后，外部世界包升级不改变旧存档。
- 存档中新增 schema + 多个变量实例 + 动作定义 + 计算规则可以在一个 Generation 中原子生效。
- 系统变量实时编辑允许合法值修改，但拒绝删除、类型变化和结构变化。
- 回滚跨越结构变更时，schema、实例、动作、计算规则、从动规则和 UI 同时恢复，无悬空引用。
- ActionRegistry/CalculationRegistry 拒绝引用当前 schema 不存在的路径；删除变量定义时存在引用则整次事务拒绝。
- 普通世界包不能执行任意代码，声明式动作与计算规则只能调用白名单算子。
- 从动变量始终物化进入 Truth Snapshot，可供 Prompt、动作、GM/角色上下文和 UI 统一读取。
- 从动变量规则与物化值由计算层在单一草稿中收敛并与源变化一次提交；回滚同时恢复规则和数值，不重新计算或投骰。
- 第 6 项只验收 P1 收尾所需结构和 P2 接口准备，不要求本阶段填充完整 P2 TAG、动作库、公式库或 UI 内容。
- P2 TAG 过滤在 provider 前生效，可选片段过滤不会让 compiler 承担数据访问或权限判断。

## 7. Store 封装与存档整体完整性

### 当前问题

当前 `WorldStore`、`CharactersStore`、`EventsStore`、`ArchiveStore`、`LoreStore` 和 `TimeStore` 同时承担内存状态所有权、领域变更、回滚、查询和立即文件持久化。每个 Store 只能证明自己的文件形状大致合法，不能证明一个 revision 下的整份存档彼此自洽；这也与第 1 项已经确定的 `CommitPlan → Generation` 单一写入口冲突。

部分 getter 直接暴露可变内部引用：`CharactersStore.get/all`、`WorldStore.world/pipeline`、`TimeStore.get` 以及上层 `GameSession.getState` 都可能让调用者绕过 `VarChange`、校验和持久化直接修改对象。TypeScript 的浅层 `Readonly<Record<...>>` 既不是深度只读，也不提供运行时保护。

现有状态直编依次写 world、characters、events，失败后再写回旧快照。这只能处理可捕获异常；进程若在中间退出，磁盘仍可能留下跨文件混合状态。Generation 原子提交实现后，不再为各 Store 单独增加临时文件方案，而是统一由 Generation repository 解决。

### 不可变 Snapshot 与只读查询

当前 Generation 加载后形成不可变 `TruthSnapshot`。同一 query、scheduler、Prompt provider 和 application planner 在一次操作中共享同一个 revision 根：

- 查询接口返回 `DeepReadonly<T>` 视图，不暴露 mutation API；
- 只有 Commit executor 能从当前 Snapshot 建立 mutable draft；
- draft 经规则收敛和整体校验后冻结为下一 Generation；
- agent、scheduler、server 不再持有可写 Store；
- 开发模式可用递归 `Object.freeze()` 捕获越界写入，生产模式是否冻结由性能测试决定，正确性主要由依赖方向与能力隔离保证；
- 不采用“每次 getter 深拷贝”，避免把成本转移到频繁查询和 Prompt 组装。

Store 最终不再是各自独立的真相写入者，而收敛为文件 codec、领域只读 projection 或 Commit executor 内部的纯应用函数。建议核心边界为：

```text
GenerationRepository
├── loadCurrent()
├── loadPrevious()
├── commit(baseRevision, CommitPlan)
└── rollbackToPrevious(baseRevision)

TruthQuery
├── world()
├── character(cid)
├── characters()
├── events(...)
├── archive(...)
└── resources()
```

### 两级校验

文件 schema 与整档语义分开验证：

1. 文件 codec 校验 JSON、schema version、判别联合、字段类型和基础数值范围。
2. `validateSaveSet(snapshot)` 在完整加载一个 Generation 后检查跨领域不变量，不把所有逻辑塞入一个巨型 Zod `.superRefine()`。

整体校验至少包括：

- revision 与 schema version 一致；
- seq 是非负整数，pipeline/current/archive/events 的边界、顺序和对应关系合法；
- Event ID 非空、格式合法且全局唯一，ID 分配水位不会与现有 ID 冲突；
- working set、事件认知标签、动作、规则、schema 和 UI 引用指向当前 Snapshot 中存在且类型匹配的对象；
- 系统变量满足 scheduler 不变量；
- lore 条目 ID 唯一，变更记录与当前条目集关系合法；
- 三层资源解析结果形成完整引用闭包。

玩家模型不得写死为“仅 `C0` 或仅一个 `isPlayer: true`”。未来联机允许多个玩家角色，因此校验的是玩家身份集合及其引用一致性：CID 唯一、角色与控制权/连接身份映射合法、需要玩家主体的步骤引用现存玩家角色；不以多个 `isPlayer: true` 为错误。`C0` 若在过渡期仍承担默认本地主控身份，只作为兼容默认值，不上升为长期存档不变量。

当前 `restoreFromDisk()` 用 `events.length` 恢复 Event ID 计数。删除中间事件、直编 ID 或未来改变编号格式后可能与已有 ID 冲突；稳定 ID 必须由显式水位、UUID/ULID 或扫描并验证后的分配器产生，不能从数组长度推导。

### 类型化加载错误

不得把所有读取、JSON 解析、schema 校验和 I/O 异常统一包装为“版本不兼容”。建立可判别的错误类别：

```ts
type SaveLoadError =
  | SaveNotFoundError
  | SaveIncompleteError
  | SaveVersionError
  | SaveCorruptError
  | SaveInvariantError
  | SaveIoError;
```

- `NotFound`：runId 或目标 Generation 不存在；
- `Incomplete`：文件集合、`CURRENT` 或 Generation 内容不完整；
- `Version`：明确的 schema 版本不受支持；
- `Corrupt`：JSON 截断或当前版本单文件结构损坏；
- `Invariant`：文件各自合法但组合后矛盾；
- `IO`：权限、占用、磁盘等系统错误。

UI 根据类型给出不同恢复路径。Version 可提示新建会话；Corrupt/Invariant 可尝试上一 Generation；Incomplete 检查 `CURRENT` 和上一 Generation；IO 应展示路径与系统错误，不能误导用户放弃存档。

### 直接编辑

用户主动编辑存档继续走与正常输出相同的事务和整体校验入口：

```text
捕获 baseRevision
→ 在 draft 应用 world/characters/events/resource patch
→ validateSaveSet(draft)
→ prepareNextCommand(draft) 收敛确定性规则
→ 再次 validateSaveSet(draft)
→ 形成 CommitPlan
→ 一次提交新 Generation
```

系统变量保护、扩展 schema、动作/计算规则引用和玩家控制权引用均由 registry 与 `validateSaveSet` 校验，不依赖前端隐藏控件。校验失败不产生新 Generation。

### 建议目录边界

```text
src/truth/
  generationRepository.ts
  snapshot.ts
  validation/
    fileSchemas.ts
    saveSet.ts
    errors.ts
  query/
    truthQuery.ts
  varChanges.ts
  codecs/
    world.ts
    characters.ts
    events.ts
    archive.ts
    resources.ts
```

无需继续为每个文件保留一个同时可读、可写、可回滚和可持久化的 class。实际迁移时按功能逐步降级旧 Store，避免一次性重写全部调用方。

### 验收条件

- 普通 query 无法改变当前 Snapshot；同一次 query 的 world/events/history/pipeline 始终来自同一 revision。
- Event ID 重复、seq 为小数/负数/越界、archive 重复或乱序、pipeline current 与 pipeline seq 冲突时明确拒绝。
- working set、事件标签、动作、规则、schema 或 UI 引用未知对象时明确拒绝。
- 多个 `isPlayer: true` 的角色可以合法加载；玩家身份集合、控制权映射和当前步骤引用不一致时拒绝。
- 当前 Generation 损坏时能分类报告，并在策略允许时加载上一 Generation。
- 版本不匹配、数据损坏、文件缺失、跨文件不变量错误和 I/O 错误不会被混为同一提示。
- 用户编辑校验失败不产生 Generation；成功后 Snapshot、Transition 与磁盘 Generation revision 一致。
- 通过故障注入验证提交中断不会暴露混合 Store 状态。

## 8. 用户数据、API Secrets、预设与服务端配置分层

### 定位

本项安全标准对齐 SillyTavern 的本地优先模型，不采用“前端永远不能查看 API key”的更严格策略。系统允许用户在服务端配置中显式开启密钥暴露；常规情况下前端只获得掩码与元数据。当前 `config.json` 同时承担 LLM API 参数、密钥、运行配置和 Web 设置，应拆分为不同生命周期、不同权限的资源。

参考 SillyTavern 的实际边界：`src/endpoints/secrets.js` 集中定义密钥读写、删除、轮换、重命名、掩码状态和可选明文查看；每个用户的 `secrets.json` 位于其用户根目录；API presets 位于用户目录；根 `config.yaml` 管理 listen、SSL、IP/Host 白名单、认证、请求代理以及 `allowKeysExposure` 等服务端选项。

### 用户数据根

建立统一用户目录解析器。现阶段只有一个默认用户，固定 handle 为 `default_user`，但所有资源 API 从一开始都通过 `UserContext/UserDirectories` 解析路径，不在 endpoint 中硬编码全局 `data/`、`runs/` 或 `data/worlds/`：

```text
data/
  default_user/
    secrets.json
    api-presets/
    worlds/
    runs/
    prompts/
    resources/
    settings.json
```

其中世界包、API 预设、存档、用户可编辑 Prompt 与其他可安装资源均归用户目录。系统内置默认资源继续放在项目的只读默认目录；用户资源通过稳定 ID 覆盖或扩展默认资源。具体目录名可在实现时依资源职责细化，但必须由一个 `UserDirectories` 契约集中提供。

`default_user` 是单用户阶段的默认身份，不应散落为业务常量。未来增加账户系统时，请求认证层只需把 `request.user` 从默认上下文替换为真实用户上下文，资源服务和 endpoint 不改变路径规则。存档 Generation 仍属于对应用户的 `runs/`，用户目录隔离不改变第 1、5、7 项的 revision/Coordinator 设计。

### Secrets 独立管理

新增集中式 `SecretManager` 与 `/api/secrets/*`，职责对齐 SillyTavern：

- `write(key, value, label)`：新增一条密钥记录并生成稳定 secret ID；
- `read(key, id?)`：仅供服务端解析当前活动密钥，或在允许暴露时供受控查看；
- `delete(key, id)`：删除指定密钥；
- `activate/rotate(key, id)`：切换同类密钥的活动项；
- `rename(key, id, label)`：修改用户可读标签；
- `state()`：向前端返回 ID、标签、active 和掩码值；
- `view/find()`：仅在服务端配置 `allowKeysExposure=true` 时返回明文，否则 `403`。

建议存储形状：

```ts
interface SecretRecord {
  id: string;
  value: string;
  label: string;
  active: boolean;
}

type SecretsFile = Record<SecretKind, SecretRecord[]>;
```

同一 SecretKind 可以保存多把 key，但至多一个 active；删除 active 后按明确规则选择新的 active 或变为空。写入使用原子文件替换。普通前端读取显示掩码，例如仅保留末尾少量字符；`allowKeysExposure` 开启时才允许查看或复制原文。明文暴露开关属于服务端配置，不属于用户 settings，也不能由普通 Secrets API 自行修改。

环境变量密钥可继续作为部署级覆盖，但不复制进用户 `secrets.json`，前端仅显示其来源和可用状态；环境变量与用户 secrets 的优先级必须在统一 resolver 中固定。

### API 预设

API endpoint、model、JSON mode、reasoning effort 以及未来采样参数不再与 secret value 混存。建立用户级 API Preset：

```ts
interface ApiPreset {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  secretKind: string;
  secretId?: string;
  jsonMode?: boolean;
  reasoningEffort?: string;
  parameters?: Record<string, unknown>;
}
```

- preset 引用 `secretKind + secretId`，不复制 API key；省略 secretId 时可使用该 kind 的 active secret；
- character、gm、prose 分别引用 preset ID，允许共享或使用不同预设；
- 保存、删除、复制、重命名和选择预设由独立资源 API 管理；
- preset 与 secrets 均位于 `data/<username>/`，但权限和返回契约不同；
- 修改正在使用的 preset 或 active secret 时，先完整解析三个 activation 的有效配置，再以一次配置事务热应用，不能让三个 LLM 调用器处于混合版本。

### 服务端配置

原有根配置功能调整为服务端/部署配置，建议改为 `config.yaml` 或保持等价的独立 server config，不再保存用户 API key 和 API preset。职责包括：

- data root、默认用户与用户系统开关；
- listen host、port、广播/发现策略；
- SSL 证书、私钥路径和 passphrase 来源；
- IP 白名单、Host 白名单、反向代理信任；
- 用户凭证、登录/认证模式；
- 出站 request proxy 和 bypass；
- `allowKeysExposure`；
- 其他进程级日志、备份和网络策略。

其中影响监听地址、SSL、代理中间件或认证链的选项通常需要重启，不应声称热生效。用户 API preset、active secret 和 activation 参数才走运行时热更新。

### 配置事务与共享契约

同意保留事务化更新原则。无论是切换 preset、修改 preset，还是轮换 secret，流程均为：

```text
读取当前用户配置版本
→ 应用 patch 到草稿
→ 解析 character/gm/prose 的 preset 与 secret 引用
→ 验证三者均可构造
→ 原子保存用户资源
→ 将同一 resolved config 热应用到运行中 Session
→ 返回新 configRevision 与脱敏视图
```

磁盘写入成功但热应用失败时不能返回“已保存，立即生效”；应回退资源文件或明确返回“已保存但需重启/重新加载”的非成功状态，不能形成未说明的双重真相。`configRevision` 与游戏 Generation revision 分离，客户端 mutation 携带 `baseConfigRevision` 防止多个配置页面静默互相覆盖。

建立共享契约，消除当前 `src/config.ts` interface、`src/server/api.ts` 手工字段表和前端字段数组三份定义漂移：

```text
contracts/config.ts
  ServerConfigSchema
  UserSettingsSchema
  ApiPresetSchema
  ResolvedAgentConfigSchema
  PublicConfigViewSchema

contracts/secrets.ts
  SecretKindSchema
  SecretStateSchema
  SecretMutationSchema
```

Secrets 的原始值类型只存在服务端 SecretManager/SecretResolver 内，不进入普通公共配置响应、WebSocket 消息或日志。

### 网络与管理面

默认 loopback 模式允许按本地应用模型运行，但仍检查 WebSocket/HTTP 的同源或 Host 边界，防止任意网页直接驱动本机管理接口。启用非 loopback/listen 模式时，采用服务端 config 中的 IP 白名单、Host 白名单和用户凭证；HTTP、WebSocket、Secrets、资源编辑和会话控制共享同一认证用户上下文。

非 loopback 不再只是打印警告：若用户显式配置了 listen，则按其白名单/认证策略启动并给出风险提示；不额外强制超出 SillyTavern 模型的安全要求。SSL、可信反向代理和凭证部署由 server config 明确配置。

本阶段暂不把 HTTP/WebSocket 请求体大小限制列为优化任务；未来增加大型导入、上传或公网部署时再按端点设计。

### 类型化 API 错误

同意建立稳定的 HTTP 状态和机器错误码：

- `400`：格式或 schema 错误；
- `401`：未认证；
- `403`：无权限、白名单/Origin 拒绝或未开启密钥暴露；
- `404`：用户资源、preset、secret 或存档不存在；
- `409`：config/game revision 冲突或会话状态冲突；
- `500`：未预期服务端错误。

服务端错误响应不返回 secret、凭证、完整底层对象或不必要的绝对路径。详细 cause 进入本地脱敏日志。

### 验收条件

- 默认用户的 worlds、runs、API presets、secrets 和可编辑资源均通过 `UserDirectories(default_user)` 解析，endpoint 不拼接全局用户资源路径。
- 同类 API 可以保存多个带稳定 ID/标签的 secret，并可切换 active、重命名和删除。
- 常规 secret state 只返回掩码；`allowKeysExposure=false` 时 view/find 明文返回 `403`，开启后前端可查看。
- API preset 只引用 secret，不复制 key；三个 activation 可以引用不同 preset 或 secret。
- preset/secret 热更新成功后，磁盘与三个 activation 使用同一 `configRevision`；验证或热应用失败不声称立即生效。
- server config 只管理服务部署、SSL、代理、监听、白名单、广播、用户凭证和密钥暴露策略，不再承担用户 API preset 存储。
- loopback 与 listen 模式均按 server config 的 Host/IP/认证规则处理 HTTP 和 WebSocket。
- API 错误具有稳定状态码和机器错误码，响应与日志不意外泄漏 secret。

## 9. HTTP/WS 协议与服务端边界收敛

### 定位

本项是第 5 项 SessionCoordinator、Snapshot/Transition 和命令身份的 transport 落地，不另建并发或 revision 体系，也不涉及 P2。当前服务端虽然有 `ClientMessage/ServerMessage` TypeScript 联合，但浏览器、HTTP 路由和测试各自维护隐式协议，已经出现实际漂移。

### `rollback_and_continue` 复合命令

删除独立 reroll 领域逻辑和 `enqueueReroll` 命名。UI 可继续显示“重新生成”，协议/application 语义统一为：

```ts
interface RollbackAndContinueCommand {
  type: "rollback_and_continue";
  requestId: string;
  runId: string;
  baseRevision: number;
  targetSeq: number;
}
```

Coordinator 将 rollback 与 continue 作为一个不可插队的复合 mutation：验证 revision，在事务内回滚并继续，最终只提交一个 Generation、发布一个 Transition。两步之间不接受其他命令，也不发布中间 rollback 状态。当前前端依次发送 `rollback`、`continue` 的方式必须删除；源码正则测试不能继续把该错误方向固化为契约。

### 协议单一来源

采用适合无构建 Vanilla 前端的轻量方案：

```text
服务端 Zod schema = 权威协议
web/protocol.js = 浏览器唯一协议适配器
契约测试 = 两侧兼容保证
```

服务端用 Zod discriminated union 定义所有 WS 入站命令和关键 HTTP DTO，并由 schema 推导 TypeScript 类型。浏览器通过 `web/protocol.js` 集中构造命令、关联请求、解析响应和分发事件；`play.js` 及其他页面不再散落 `{type: ...}` 字面量或维护声称是协议定义的 JSDoc 副本。

现阶段不引入代码生成器。等协议稳定且手工 adapter 的维护成本有实证后再评估生成。服务端下行可在开发/测试模式做运行时 schema 校验，生产发送路径至少保持类型完备。

### 类型完备的 DTO

`parseClientMessage` 不得先将不可信 JSON 强制断言为联合类型，再手写检查部分字段。统一验证对象、判别字段和每种命令的完整字段；非法 JSON、null、数组、未知命令和字段类型错误返回稳定协议错误。

关键下行数据不再使用 `unknown` 或自由字符串：

- phase、step kind、query kind 和 error code 使用明确联合；
- state、events、history、pipeline、stats、edited result 建立窄 Web DTO；
- `SessionManager/Coordinator.query` 使用 `QueryResultMap` 保持 query kind 与返回类型对应；
- Web DTO 不直接暴露可写 Truth 内部对象。

示意：

```ts
type QueryResultMap = {
  snapshot: SessionSnapshotView;
  stats: CacheStatsView;
};

interface QueryCommand<K extends keyof QueryResultMap> {
  type: "query";
  query: K;
  requestId: string;
  runId: string;
}
```

状态编辑所需 world、characters、events 必须来自一个不可拆分、单 revision 的 Snapshot，不能由浏览器等待两条无关联的 state/events 消息后自行拼装。

### 回复、错误与广播分离

协议明确区分三类消息：

```ts
interface CommandResult<T = unknown> {
  type: "command_result";
  requestId: string;
  command: string;
  runId: string;
  revision: number;
  data?: T;
}

interface CommandError {
  type: "command_error";
  requestId: string;
  command: string;
  code: string;
  message: string;
  runId?: string;
  revision?: number;
}

interface TransitionMessage {
  type: "transition";
  runId: string;
  fromRevision: number;
  revision: number;
  reason: string;
  changed: TransitionChanges;
}
```

- command result/error 只发给发起 socket；
- Transition 广播给该 run 的观察者；
- Snapshot 是首次连接、重连和 revision 跳号恢复的完整响应；
- 不再复用 `state/events` 类型同时表示 query 回复和全局广播；
- `edit_done` 等操作结果通过 requestId 定向回复，实际共享状态变化进入 Transition。

所有 mutation 使用第 5 项的 `requestId + runId + baseRevision`。`requestId` 负责回复关联，`runId` 防止作用于切换后的会话，`baseRevision` 拒绝陈旧写入。LLM 流式消息额外使用 activationId。stop 是队列外信号，但仍携带 `requestId + runId + activationId`，只中止匹配 activation。

### HTTP envelope

HTTP 响应统一外围结构，不要求不同资源拥有相同 data：

```ts
type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
};
```

资源 mutation 按需附带 `configRevision` 或游戏 `revision`。错误状态沿用第 8 项规则；未知 method 返回 `405` 和 `Allow`，不与未知路径统一成 `404`。服务端未预期异常映射为 500，不能全部包装成 400。

### 服务端职责边界

不引入 Express 等重框架，按职责拆轻量模块：

```text
src/server/
  index.ts                 # composition root
  static.ts                # 静态文件
  ws-transport.ts          # upgrade、连接、序列化、单播/广播
  ws-controller.ts         # 协议解析、调用 Coordinator、形成回复
  http/
    response.ts
    errors.ts
    router.ts
    routes/
      secrets.ts
      presets.ts
      worlds.ts
      sessions.ts
      activeSession.ts

src/resources/
  userDirectories.ts
  runRepository.ts
  worldRepository.ts
  presetRepository.ts

src/shared/
  safeSegment.ts
```

`api.ts` 不再同时拥有协议、配置 schema、路径校验、资源仓储和所有路由。`safeSegment` 移出 API 模块，消除 SessionManager 对 transport 的反向依赖。

`index.ts` 只装配依赖并启动服务；WS controller 决定命令调用和 reply/Transition，transport 只处理连接和字节传输。SessionManager 最终收敛进第 5 项 Coordinator：保留生命周期、mutation 串行化和 application facade，移除 transport 专属 `onStateRefresh`；命令返回结构化结果，由 controller 发布。

### 迁移顺序

1. 定义 Zod WS 入站 schema、稳定错误码和窄 DTO；新增 `web/protocol.js`。
2. 将重新生成改为原子 `rollback_and_continue`，移除前端双消息及独立 reroll 领域函数。
3. 引入 requestId/runId/revision，分开 command result/error、Snapshot 和 Transition。
4. 提取 `ws-controller` 与 transport，随后拆 HTTP 分域路由。
5. 提取 user/run/world/preset repositories 与路径工具。
6. 最后收窄 SessionManager 并接入统一 Coordinator，避免先搬文件后仍保留旧职责。

### 测试收敛

逐步用真实 HTTP/WS 行为测试替代读取源码做正则断言。`startServer` 支持注入 host、`port: 0`、Coordinator、UserDirectories 和 session factory，并返回实际监听地址，测试不接触真实用户数据或真实 LLM。

高价值测试包括：

- 两个真实 WS 客户端同时提交 mutation，陈旧 revision 稳定拒绝；
- `rollback_and_continue` 中间无可见 rollback 状态且不能插队；
- query reply、command error 和 Transition 按 requestId/runId/revision 正确寻址；
- LLM 在途切换会话后，旧 activation 不向新会话提交或广播；
- stop 只中止匹配的 runId + activationId；
- 重连收到单 revision Snapshot，不拼接不同 revision 的 history/state/events；
- 每种 WS 判别联合至少一个合法和非法 fixture；
- 真实 HTTP 验证 400/401/403/404/405/409/500 及统一 envelope；
- HTTP mutation 成功后相关客户端只收到一个 Transition，失败不广播成功状态；
- Secrets/presets 请求遵循第 8 项用户身份与脱敏契约。

### 验收条件

- 浏览器不再直接手写业务协议消息；服务端权威 schema 与浏览器 adapter 有契约测试。
- WS 非法输入得到稳定 `command_error`，不会因强制断言在深层抛原生异常。
- query 与广播不共用无法寻址的消息形状；并发请求不会消费彼此的回复或错误。
- 所有 mutation 可关联到 requestId/runId/baseRevision，流式生成可关联 activationId。
- 重新生成只有 `rollback_and_continue` 一条复合命令、一个最终 Generation 和一个 Transition。
- `api.ts/index.ts/SessionManager` 不再混合 transport、仓储、协议、业务编排和广播职责。
- 关键 HTTP/WS 并发语义由真实连接测试证明，不依赖源码正则。

## 10. 前端状态、异步生命周期与资源编辑上下文

### 定位

保持 Vanilla ESM、无构建，不为维护性引入 React/Vue。`play.js` 的核心问题不是文件行数，而是服务端权威状态、请求状态、临时 UI 状态和 DOM 引用共享同一模块作用域，且没有统一会话身份和生命周期。应先明确状态所有权，再拆 UI 文件，避免把共享全局变量分散到更多模块。

### 三类状态所有权

1. `session-store`：currentRunId、revision、pipeline、Snapshot 中的 world/characters/events/history、当前 activation 和流式步骤。只接受 Snapshot、Transition 和流式协议消息，按 runId/revision/activationId 验证身份。
2. transient UI state：侧栏选择、滚动锁定、markers 草稿、暂停选项表单、当前 modal、pending request/edit、新会话 world 选择。明确切 run、revision 前进和路由离开时的 reset/失效规则。
3. view 局部状态：DOM 引用、输入框值、卡片流式缓冲、菜单开合和当前可见卡片索引，由对应 view/controller 所有。

当前 `session_started` 只清部分缓存；markers、pending edit、状态编辑器和旧卡片索引等不能继续依赖后续消息偶然覆盖。current turn 等能从 Snapshot/history 派生的字段不重复维护。

### 异步请求生命周期

扩展 `web/app.js` 的 API client 支持 `AbortSignal`、统一 envelope 和类型化错误。每次路由激活、资源加载、会话详情和 modal 请求都有 request epoch；响应落 UI 前同时检查 epoch 与资源身份。AbortController 用于停止无用工作，epoch/identity 检查负责最终正确性，不能只依赖取消。

当前需优先修复的实际竞态：

- 会话详情快速点击 A、B 时，A 的晚到响应可继续写入 B 共用的 detail 容器；
- world A→B 的角色 CID 请求逆序完成时，A 可覆盖 B 的 knownChars；
- WS 未连接时 `loadSession()` 静默不执行，但会话页仍导航到游玩页；
- 会话绑定 modal 请求晚到后可能展示上一 run 的内容。

`loadSession/newSession/save` 等操作返回 Promise，仅在匹配 requestId 的成功结果后推进 UI；连接不可用或命令失败必须可见，不得发送后立即假定成功。

### ResourceContext

世界与角色编辑页当前 GET/PUT 都不带 set，因此始终操作默认世界包，并非“读指定包写默认包”，而是完全无法编辑非默认包。建立统一资源上下文：

```ts
interface ResourceContext {
  username: string;
  worldSetId: string;
}
```

由 `resource-context.js` 集中生成 world、character、prompt、schema、action 等资源 URL。每个编辑表单打开时捕获不可变目标 `{username, worldSetId, resourceRevision}`；保存时继续明确写原目标，不重新读取当前 picker。界面持续显示“正在编辑”的资源包，避免打开 A 后切到 B 却把旧表单写入 B。

世界包、角色、Prompt、变量模板、动作与其他用户资源以后都复用该上下文；它与 Session 的 runId/revision 分离。

### 状态编辑器与 modal

状态编辑器打开时捕获 `{runId, baseRevision}`。切 run 后关闭或拒绝；revision 前进后保存返回 409 并要求刷新。成功由匹配 requestId 的 command result 确认，共享状态变化由 Transition 更新；任意下一条 WS error 不能被视为本次编辑错误。

会话 modal 持有 modalId、runId、revision、requestId 和 AbortController；会话切换、路由切换或关闭时取消，迟到响应核验身份。资源 modal 则核验 ResourceContext。挂在 `document.body` 的 modal 也必须进入统一生命周期，不因脱离页面容器而长存。

### SessionTransport

当前没有证据表明切页已造成重复 WS 连接或普通 DOM listener 泄漏，因此不做无依据的全面事件系统重写。但现有 reconnect 缺少 connection generation、timer 去重和 dispose，未来登出、切用户或手动重连后风险较高。

`session-transport.js` 独占 WebSocket：

- 任意时刻至多一个有效 socket、一个 reconnect timer；
- 所有回调捕获 connection generation，旧 generation 的 open/message/close 全部丢弃；
- 提供 connect/send/reconnect/dispose 和明确连接状态；
- 采用有限或指数退避；
- 未连接时命令明确失败或进入有界队列，不静默丢弃；
- transport 不访问 DOM，消息交给 protocol adapter 与 session store。

### 最小模块与迁移顺序

```text
web/
  protocol.js
  session-store.js
  session-transport.js
  resource-context.js
  views/
    play-stream.js
    play-input.js
    state-editor.js
```

顺序：

1. 先完成第 9 项 protocol.js 和命令身份；
2. 建立纯 reducer 的 session-store，让现有 play.js 先订阅，不改 DOM；
3. 提取 session-transport；
4. API client 增加 signal，router 增加 abort scope/epoch；
5. 建立 ResourceContext，并修复会话详情、CID、modal、读档和状态编辑器竞态；
6. 最后只先拆三个生命周期清晰的 view，不做过度组件化。

### 验收条件

- 延迟 A/B 会话详情并让 A 后返回，页面只显示 B。
- world A→B 的角色请求逆序完成，只接受 B；GET/PUT 始终使用同一捕获的 ResourceContext。
- 会话 A 的晚到 Snapshot/Transition/流式消息不能进入会话 B 的 store。
- 对两个临时 world package 做 GET→编辑→PUT，仅目标包发生变化。
- revision N 打开的状态编辑器在切 run 或 revision 前进后不能提交到当前会话。
- fake WebSocket 连续触发旧 generation 回调时始终只有一个有效连接和一个重连 timer。
- WS 断开时读档显示失败且不导航；重复 render 后一次点击只发送一条命令。
- 路由 A→B 后，A 的迟到成功或错误不修改 B，也不显示为 B 的错误。
- 测试以纯 store/transport/URL 构造器为主，少量真实 DOM 测试覆盖绑定和 modal 生命周期，不再主要依赖源码正则。

## 11. 测试体系与依赖方向收敛

### 当前结构

项目已有约 36 个测试文件、274 个场景和约 5500 行测试，问题不是数量不足，而是层级倒置。纯 scheduler/schema/compiler 测试质量较好，但大量业务行为只能通过完整 GameSession、临时世界包、真实文件系统和全局 LLM prototype 替换验证，形成中段肥大、失败定位困难且无法安全并发的准集成层。

当前主要脆弱模式：

- 多个测试读取生产/前端源码并做字符串或正则断言，重构即失败但不证明运行行为；
- 至少六个大型测试文件修改 `LLMClient.prototype`，形成进程级共享状态；
- 约 25/36 个测试文件直接使用 fs，application 规则测试被迫构造完整磁盘世界包；
- 临时目录创建散落且清理不统一；
- 测试以双重断言、`as never` 穿透私有实现或 OpenAI SDK 内部对象；
- 当前有效存档 fixture 中仍出现旧 schema version，测试语义已漂移；
- run ID 依赖墙钟，部分纯测试仍调用真实随机数；
- 只有一个总测试命令，没有独立 architecture/contract/application/integration 门禁。

### 测试金字塔

1. 纯单元（约 60–70%）：scheduler/derive、VarChange、planner、working set/history projection、schema、compiler、identity、配置解析、声明式规则、前端 reducer。不得访问磁盘、网络、墙钟或共享全局状态。
2. Contract：GenerationRepository、存档 codecs、ChatPort/OpenAI adapter、Prompt 文件、WS schema、Secrets/Preset repository、SaveLoadError。文件 repository contract 可使用真实 temp filesystem。
3. Application：直接驱动 Coordinator/use case，使用内存 repository 与 scripted fakes，验证输入→planner→CommitPlan→Generation、rollback/edit/continue、邀请/标记/GM/正文、规则收敛、配置热应用和 abort 语义，不启动 HTTP/WS、不构造真实世界目录。
4. Integration：少量验证真实 adapter 连线，包括建档→命令→关闭→重载一致、真实 filesystem 故障恢复、本地 fake OpenAI HTTP 的流式/abort，以及第 9、10 项的 HTTP/WS/DOM 测试。

每个业务规则尽量只在最低可证明层穷举；上层只证明 adapter 连线与跨边界不变量。现有大型场景不删除，而是迁入无 IO application harness。

### 最小测试端口

不引入 DI 容器，使用构造参数或轻量 RuntimePorts：

- `ChatPort`：生产 OpenAI adapter；测试 Scripted/Deferred/FailingChatPort，替代 prototype patch。近期记录与 cache stats 作为 observer/decorator，不迫使 application 测试落盘。
- `Clock.now()`：仅现实时间，用于 run ID、日志、备份等；不与 Truth 中的 world.time 混淆。
- Dice：沿用现有可注入函数或命名端口；纯测试不走 Math.random，回滚不重投。
- ID generators：run/event/activation/request ID 分清空间，调用者不从墙钟、数组长度或隐式全局计数推导。
- application 依赖语义 `GenerationRepository`，不模拟完整 Node fs；生产使用 JSON/filesystem adapter，测试使用 InMemoryGenerationRepository。

### 架构依赖审计

删除以源码 regex 检查 simulator import 的做法。利用项目已有 TypeScript Compiler API 建立 `scripts/check-dependencies.ts`：读取 tsconfig、解析静态/动态 import 与 re-export、用 TypeScript module resolution 建图、检查禁止边、传递依赖和强连通分量。

规则以单一数据结构维护，例如 contracts/domain 不依赖 application/adapters，scheduler/compile pure 不依赖 IO/LLM/server，application 只依赖领域与 ports，adapters 实现 ports，server/CLI 只负责装配。迁移期例外必须带原因和退出事项，不能永久静默放行。无需新增 madge/dependency-cruiser/ESLint 依赖。

### Builders、Fixtures、Fakes、Harness

```text
test/
  builders/     # 最小合法内存对象 + overrides
  fixtures/     # 必须逐字兼容的存档/世界包/OpenAI/prompt 外部格式
  fakes/        # ChatPort、Clock、Dice、IDs、内存 repository
  harness/      # tempRun、applicationHarness、serverHarness 与自动清理
```

Builder 不写盘；fixture 只测试外部兼容；fake 实现端口；harness 负责装配与生命周期。避免万能 `testUtils.ts`。当前有效 fixture 统一引用或由 helper 写入 `SAVE_SCHEMA_VERSION`，只有明确 legacy/mixed/corrupt fixture 固定旧值。所有临时目录和句柄由 harness 自动清理，尤其覆盖 Windows 文件锁与路径行为。

### 命令与门禁

继续使用 node:test，分出 `test:unit`、`test:contract`、`test:application`、串行 `test:integration`、`test:arch`、`test:fast` 和完整 `check`。日常/PR 至少运行 typecheck + arch + fast，完整验证再跑 integration；Windows 与 Linux 均覆盖 integration。移除 prototype patch 和共享目录后，unit/application 应允许并发。

暂不以覆盖率百分比作为首要门禁。优先门禁：纯层/application 无真实 IO；无源码正则行为测试；临时资源全清理；每个外部 adapter 有 contract；依赖禁止边和循环通过。

### 验收条件

- application 场景不创建真实世界目录、不写文件、不 patch prototype；同一进程可并发运行并使用不同 ChatPort 脚本。
- Store/Generation filesystem 语义集中在 contract/integration 测试，业务规则失败能定位到 planner/Coordinator，而非宽集成装配。
- TypeScript Compiler API 能发现直接及间接的 IO/LLM/server 违规依赖和跨层循环。
- 当前有效 fixture 不含过期版本号；legacy fixture 命名和预期明确。
- 每个 temp filesystem test 自动清理，Windows 下无残留句柄或目录。
- OpenAI adapter 的非流式、流式、usage、错误和 abort 由本地 fake HTTP contract/integration 验证，不穿透 SDK 私有对象。
- 默认 fast suite 稳定、可并发；完整 integration 数量少且验证明确边界。

## 12. 规模控制、接口收敛与实施顺序

### 改造的根本目的

本轮改造的根本目的不是增加架构层、文件数或接口数，而是让系统从“多个入口各自修改状态、各自解释规则、各自处理失败”的发散结构，收敛为少量可证明的一致路径：

```text
所有输入
→ 制式 application command
→ 统一 planner / deterministic preparation
→ 单一 CommitPlan
→ 单一 Generation commit
→ 单 revision Snapshot / Transition
```

需要实现的最终性质是：

1. **唯一真相写入路径**：正常输出、玩家输入、角色输出、GM 裁决、编辑重放、状态直编、规则计算和回滚不能各自拥有专线写法。
2. **同一语义只实现一次**：玩家与 NPC 只在取得 DecisionPackage 的方式上不同；正常执行与编辑重放使用同一效果规划器；HTTP、WS、CLI 只负责把输入转为同一 application command。
3. **状态在事务内收敛**：确定性规则、从动变量、调度准备和固定动作在同一 draft 中运行到固定点，一次提交，不暴露中间半状态。
4. **读取绑定单一 revision**：Prompt、scheduler、query、Web Snapshot 和 Transition 都从同一个不可变 TruthSnapshot 读取，不拼接不同提交时刻的数据。
5. **外部能力可替换**：LLM、文件系统、网络、随机数、墙钟、ID 和用户目录通过少量真实端口隔离，业务规则不依赖具体 adapter。
6. **失败路径可证明**：中止、写盘失败、陈旧 revision、非法编辑和损坏存档有明确边界，不依靠“按顺序刚好没出错”。
7. **扩展沿制式入口进入**：未来角色/世界变量膨胀、多角色批量修改、声明式动作、API presets、联机和多用户不再新增旁路，而是复用既有 command/query/commit/transition 接口。
8. **降低净认知复杂度**：虽然模块和文件会增加，但任何单一业务规则所需理解的上下文、可写入口和失败状态必须减少。

判断改造是否成功不能看“创建了多少新接口”，而应看：旧专线是否删除、同一规则是否只剩一个实现、一次命令是否只有一个提交、一个 query 是否只有一个 revision、测试是否无需穿透内部实现。

### 净删除与核心文件瘦身要求

改造不是在旧架构上叠加一套新架构。每阶段都必须产生净删除：删除旧 mutation、重复 planner、专用重放、专用 reroll、散落 persist、协议字面量、prototype patch 或全局路径旁路。短期兼容 adapter 必须只转发到新入口，不得保留独立状态和业务判断。

`src/loop.ts` 是最明确的收敛指标。当前约 1900 行，混合 Session 装配、调度、邀请、角色/GM/正文步骤、效果应用、持久化、编辑、回滚、直编、pause/stop、query 和配置热更新。改造后这些职责分别进入 SessionFactory/composition root、scheduler derive、application planners、CommitExecutor、GenerationRepository、TruthQuery 和 SessionCoordinator。

最终要求：

- `loop.ts` 缩减到约 100–300 行的兼容 facade/composition entry，或者直接删除；
- 不再包含文件 IO 或具体 LLM client；
- 不再直接调用 Store mutation/persist；
- 不再实现 effect、邀请推导、编辑专用重放、回滚细节或 HTTP/WS DTO；
- 只允许转发 application command、暴露只读 Snapshot/query，或装配 Coordinator；
- SessionCoordinator 自身也不得成为新的巨型 loop，建议控制在约 300–500 行，领域规则继续留在 planner/derive/policy 纯模块。

如果改造完成后 `loop.ts` 仍接近当前规模，或者 Coordinator 复制了原 loop 的全部分支，同时旧 Store/agent/session 入口仍然有效，则说明只是横向搬运和叠加抽象，改造应判定为失败。

生产代码总量增加主要来自当前确实缺失的 Generation 原子提交、整体校验、用户资源、Secrets/Preset、协议 DTO 和前端 store；原 `loop.ts` 现有行为应以迁移、合并和删除重复代码为主，而不是继续膨胀。

### 接口增加的原则

规划中的接口不是为了“模块化而模块化”，也不是把每个内部函数都包装成 interface。新增接口只有在满足以下至少一项时才保留：

1. **统一多个现有专线**：例如角色/GM/正文最终都通过统一 `ChatPort` activation；world/characters/events/archive 都通过统一 Generation commit；HTTP/WS/CLI 都进入同一 Coordinator mutation 入口。
2. **隔离外部变化**：例如 OpenAI SDK、文件系统、WebSocket、墙钟、随机数、用户目录和服务端认证不直接渗入领域/application。
3. **形成一致事务边界**：例如 `CommitPlan`、`TruthSnapshot`、`Transition` 和 `baseRevision` 让不同入口使用同一提交、查询和冲突规则。
4. **提供可替换测试端口**：例如 `ScriptedChatPort`、内存 Repository、FakeClock；测试不再修改 prototype 或依赖真实外部系统。

因此这些接口是实打实的制式接口：它们把当前凌乱的专线调用收敛为少量稳定入口，而不是仅增加类型名称。验收时必须能指出每个接口替代了哪些旧入口，并禁止旧入口继续作为旁路写入/调用。

建议采用“端口少而宽度合适”的原则：

```text
TruthQuery       # 单 revision 只读查询
CommitExecutor   # CommitPlan 唯一落地
ChatPort         # 单轮 activation
GenerationRepository # 当前/上一代存档读写
SessionCoordinator   # mutation/lifecycle 唯一编排
SessionTransport     # WS 连接与传输
ResourceContext      # 用户资源身份与路径
```

不建议为每个 Store getter、每个页面按钮或每个简单函数建立新 interface；值对象、纯函数和本地 helper 继续使用直接函数/类型即可。

### 轻量化约束

以下内容明确不做重型实现：

- 不引入 DI 容器；用构造函数参数或轻量 `RuntimePorts`；
- 不引入 CQRS/Event Sourcing 通用框架；只实现 CommitPlan、Generation、VarChange 和上一代保留；
- 不引入 Express/路由大框架；HTTP 采用分域 handler/轻量 route table；
- 不引入前端框架或构建步骤；使用 Vanilla ESM、纯 reducer 和少量 view；
- 不引入代码生成器；服务端 Zod schema + 浏览器 `protocol.js` adapter + contract test 足够；
- 不建立万能 JSON 解析器、万能 RuleEngine 或万能 `testUtils`；Schema、Action、Calculation、Prompt provider 和测试 builders 分责；
- 不提前实现完整多用户、权限角色、插件执行环境或联机控制权；先以 `default_user`、声明式规则和预留契约承载；
- 不一次性重写所有历史文档；README 暂不维护，历史术语和架构章节等目标结构完成后统一收口；
- 不拆前端为大量微型组件；先抽 `session-store`、`session-transport`、`resource-context` 和少量高耦合 view；
- 不为每个从动变量创建 Generation；确定性计算在同一 draft 内收敛后一次提交。

### 规模判断

当前约有：

- `src` 5600 行 TypeScript；
- `web` 1847 行 JavaScript；
- `test` 5464 行测试；
- 总计约 12900 行代码；
- 运行依赖仍只有 `openai`、`ws`、`zod`。

按最终清理完旧旁路入口的稳定状态估算：

- 生产 `src + web` 约 10000–13000 行；
- 测试约 7000–10000 行；
- 总代码约 17000–21000 行；
- 生产代码约增加 35%–75%，总量约增加 30%–60%；
- 文件数可能增加约 50%–100%，主要来自明确的 adapter、contract、repository、controller、测试 fake/harness 和少量 web store；
- 第三方依赖基本不增加。

这是结构显式化的增量，不应直接等同于运行时业务复杂度增加。领域规则复杂度目标是不明显增加；技术结构复杂度会增加；并发/协议复杂度会被显式化并变得可测试。

### 禁止双体系长期并存

真正会导致项目失控的不是接口数量，而是旧入口和新入口长期同时有效，例如：

```text
旧 Store.setVars/apply/persist + 新 CommitExecutor
旧 play.js WS + 新 SessionTransport
旧 reroll + 新 rollback_and_continue
旧全局 config key + 新 SecretManager
```

每引入一个新正式入口，必须在同一优化事项中登记：

- 它替代的旧入口；
- 迁移完成判据；
- 旧入口删除时间/阶段；
- 期间是否允许只读兼容 adapter。

原则上旧入口只能短期作为 adapter，不能继续拥有独立写入权或独立业务语义。

### 推荐实施顺序

按依赖关系和风险控制，建议分为以下阶段：

#### 阶段 A：先建立可验证边界，不改变主要行为

1. 建立 `ChatPort`、`Clock`、Dice/ID ports，替代 prototype patch 和墙钟/隐式 ID 依赖。
2. 建立测试 builders/fakes/harness，迁移高价值 application 场景；保留 Store filesystem contract。
3. 建立 TypeScript Compiler API 依赖审计和最小测试分层命令。
4. 建立轻量 `UserDirectories(default_user)`、资源路径工具和配置/Secrets/Preset 契约，但先保持兼容读取。

**结果：** 测试和外部边界先稳定，后续大改不再依赖全局 prototype、真实默认目录或源码正则。

**实施状态（已完成）：** ChatPort/OpenAIChatAdapter/CallLogChatPort 取代 LLMClient（无兼容壳，prototype patch 归零）；Clock/IdPorts/DicePort 落 `src/ports.ts`；`scripts/check-dependencies.ts` 依赖审计 + 四层测试套件（unit/contract/application/integration）；test/builders、fakes、harness 就位，临时目录统一收口；UserDirectories(default_user) 与 contracts/config、contracts/secrets 建立（legacy 路径兼容读取，未做数据迁移）。基线 293 场景全绿。

#### 阶段 B：收敛真相写入与回滚核心

5. 实现 `TruthSnapshot`、GenerationRepository、CURRENT/上一代管理和 `CommitPlan`。
6. 实现 `validateSaveSet`、类型化 SaveLoadError 和跨文件完整性校验。
7. 将 World/Characters/Events/Archive/Lore/Time Store 降级为 codec/query projection，移除旁路 `persist()`/公开 mutation。
8. 让正常执行、编辑重放、直接编辑、确定性计算和回滚都进入同一 CommitExecutor。

**结果：** 真相层形成唯一写入口；一轮一个 Generation，恢复和回滚不再依赖多 Store 顺序写入。

**实施状态（已完成）：** 存档 v6 Generation 布局（CURRENT + generations/ + 旁路留根）落地；六个 Store 纯内存化，唯一写盘出口为 `GenerationRepository.commit`（.tmp→重读校验→rename→CURRENT 原子切换→保留两代+灾备回退）；`validateSaveSet` 默认接入 commit 与 load；SaveLoadError 六类 + RevisionConflictError；VarChange 引擎迁 `truth/varChanges.ts` 且路径统一真相根（characters.* 前缀）；事件 ID 改 `scanEventWatermark` 水位；五路径（init/step/gm/rollback/admin_edit）全部经 `CommitExecutor`；editResult/rollbackTo/applyDirectEdit 全 draft 化（失败连内存都不动，GM「先反转后校验」缺陷已修）；恒冻结 + DeepReadonly 查询出口（炸出并修复一处测试越界写入与一处 working_set 玩家条目形状失真）。基线 349 场景全绿。**遗留指标**：`loop.ts` 2177 行，其瘦身（目标 100–300 行 facade）由阶段 C 承担并逐片验收净减。

#### 阶段 C：收敛调度与 application 编排

9. 抽出 `scheduler/derive.ts`、`scheduler/invitations.ts` 和动态 InvitationProjection。
10. 抽出统一 effect planner、`projectWorkingSet` 和 `prepareNextCommand`。
11. 建立单一 `SessionCoordinator`，把 new/load/mutation/rollback_and_continue/stop 生命周期收进统一边界。
12. 将未来固定动作、数值计算和投骰接入 `prepareNextCommand` 的声明式端口，但不填充具体 P2 内容。

**结果：** 正常输出、编辑、回滚和确定性规则共享一套规划与调度路径。

**实施状态（已完成）：** `scheduler/derive.ts`（NextCommand 判别联合，`d.cid!` 消除）+ `scheduler/invitations.ts`（InvitationProjection，增量 applyStep + 五重建点，`timer after===0` 猜测删除）落地；统一效果规划器 `application/{actorEffects,gmEffects,scheduleEffects,workingSetProjection}.ts`（玩家/NPC/编辑重放同一 planActorDecision，GM 同一 planGmAdjudication）；StepChanges(setup/effects) 取代 effects_from/markers_from 下标定位，phase 去持久化，存档 v7（一次 bump 覆盖两件事）；`prepareNextCommand` 统一三路径入口 + DeterministicRulePort 空壳（固定点+签名检测+迭代上限）；GM/character 激活循环收敛 `runStructuredActivation`；`SessionCoordinator`（247 行）收拢九命令串行入口，rollback_and_continue 单任务复合，baseRevision 校验就绪（协议接线留 D），CLI 同入口复用；**loop.ts 与 sessionManager.ts 整文件删除（合计 -1942 行）**，wsReroll 源码正则断言拆除。基线 429 场景全绿。**遗留**：§4 无状态 activation 主体（context builder/runId 绑定日志/第二次重试携带首次错误）为排期缺口，建议阶段 D 前单独立项。

#### 阶段 D：收敛协议与客户端

13. 用 Zod 权威 schema + `web/protocol.js` 建立 WS/HTTP DTO 和稳定错误 envelope。
14. 实现 requestId/runId/revision/activationId，Snapshot/Transition 与 command result/error 分离。
15. 提取 `ws-controller`、`SessionTransport`、HTTP 分域 routes 和 repositories；修复原子 `rollback_and_continue`。
16. 建立前端 session-store、session-transport、resource-context，修复异步竞态和非默认 world set 编辑。

**结果：** 网络层只是 Coordinator 的制式适配器，前端不再自行拼接不同 revision 的状态。

**实施状态（已完成）：** 入站协议唯一权威 `contracts/protocol.ts`（Zod discriminated union，`.strict()`，reroll 消息删除不留兼容映射，前端重 roll = 单条 rollback_and_continue）；下行收敛为 command_result/command_error/transition/snapshot/流式七种（全带 runId+activationId，activationId 经 Display 可选第 4 参注入，CLI 零改动）；每提交一条 Transition（引用差分，rollback_and_continue 合并单条），Coordinator.query("snapshot") 单 revision 一致读；会话切换 dispose+epoch 旧 run 不提交不广播；stop 幂等身份核对。服务端 api.ts（523 行）消亡，拆为 ws-transport/ws-controller/http 分域 routes + resources 仓储；HTTP 统一 envelope 与状态码矩阵（含 405+Allow、409、500 映射）；readRunArtifact 平铺回落与 readJson fallback 删除；config 三份定义漂移收敛为 contracts 一份（顺带修复直编自锁基线 bug）。前端 session-store（纯 reducer）/session-transport（generation 守卫+单 timer 退避）/protocol 工厂/resource-context 就位；四个点名竞态全部修复（会话详情 epoch、CID 逆序、读档失败不导航、modal 晚到 + runId 变化统一关闭）；非默认世界包编辑接通（?set= 前端接线）；play.js 1225→409 行纯编排，三个 view 抽出；busy 语义重建（selectBusy 单测锁定）消除瞬闪。真实双 WS 客户端 + DeferredChatPort 集成测试就位（revision 冲突/强制切换/合并 transition/重连单 snapshot/幂等 stop）；wsStateBroadcast 源码正则测试拆除。基线 504 场景全绿。**遗留**：中止超时强制失效计时器（dispose 旗标兜底，known-issues 登记）；historyPatch 恒整段重渲；两处源码正则测试仅最小修正未重写。

#### 阶段 E：资源管理、安全和文档收口

17. 实现 Secrets/多 API key/预设/脱敏查看和 configRevision 热应用。
18. 将 server config 与 user resources 分离，接入 SSL、代理、IP/Host 白名单、广播和用户凭证配置。
19. 优化完成后统一收口 `DESIGN.md`、`DESIGN-P1.md`、`CONTEXT.md`、ADR 和 `docs/architecture.md`；README 暂不维护。
20. 完成一次旧入口清理、文档路径检查、依赖审计和完整 integration 验证。

### 阶段完成判据

每阶段结束都必须满足：

- 新入口已被真实调用方使用，而不是只创建空接口；
- 旧入口不再拥有并行写入权；
- 至少有一条 contract/application/integration 测试证明边界；
- typecheck、相关测试和依赖审计通过；
- 失败恢复路径已验证；
- 文档只在阶段完成后把目标标记为 implemented，不提前伪装成现状。
