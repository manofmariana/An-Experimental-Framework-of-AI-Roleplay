# 改动指向地图

新文件必须先在此登记（路径 / 职责 / IO / 依赖方向），再写码。职责变化时同步更新本表。顶层目录布局见 AGENTS.md 目录结构段；依赖禁止边由 `scripts/check-dependencies.ts` 机械守护（`npm run test:arch`）。

## src/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `types.ts` | 全部契约（zod schema）：Event/DecisionPackage/AdjudicationPackage/IncidentPackage/Span/Location 等 | 无 | 不依赖 src 内模块 |
| `config.ts` | 路径常量（经 userDirectories 派生）、世界设定集定位、LLMConfig/AgentKind + 运行设置缺省常量（DEFAULT_PROSE_WINDOW_TURNS/DEFAULT_GM_INTERVAL_CYCLES）；旧版 config.json 分层解析的对拍基准在 `test/harness/legacyConfigResolver.ts` | 读 data/assets | → resources |
| `configResolver.ts` | 配置解析纯函数：resolveEffectiveAgentConfigs（settings+presets+secrets+env → 三 activation ResolvedAgentConfig；优先级：preset 显式 secretId > env > 该 kind active secret）+ mapLegacyConfig（旧版 config.json → secrets/presets/settings 迁移映射） | 无 | → contracts |
| `cli.ts` | CLI 入口（readline REPL；经 SessionCoordinator 发 player_input/continue/rollback/rollback_and_continue 命令；启动经 configService.loadConfigState 读配置——迁移闸对 CLI 同样生效） | 终端 | → application(sessionCoordinator/configService)/config/resources |
| `serverConfig.ts` | server.json 加载与 env 合成：resolveServerConfig 纯函数（listen/host白名单/IP白名单/allowKeysExposure；OFAIR_HOST/OFAIR_PORT 优先于 listen；缺文件=全默认 loopback 放开）+ loadServerConfig IO 壳（basicAuth/SSL/proxy/broadcast 接受但逐块 warn 未实现忽略） | 读 server.json | → contracts/config(PROJECT_ROOT) |
| `ports.ts` | 运行时端口：Clock / IdPorts / DicePort（单骰 (face)=>1..face）+ rollDice 统一投掷出口（dice 求和 × times 次取高/低，keep: high/low）及系统默认实现 | 墙钟 | 不依赖 src 内模块 |
| `display.ts` | Display 接口（UI 协议层）：CLI 与 WebUI 各一实现；agentStart 带可选第 4 参 activationId | 无 | → types |

## src/application/（应用层：统一效果规划器 + 调度派生收口 + 会话内核/装配/协调器；禁依赖 server）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `actorEffects.ts` | 角色决策规划器 planActorDecision（玩家/NPC/编辑重放统一入口）：working set/relations/acted/邀请应答（confirm 入组·拒绝还原）/五标记；只变异 draft 并返回 StepChanges.effects 段 | 无（纯内存变异） | → truth/stores/scheduler/types/ports |
| `gmEffects.ts` | GM 裁决规划器 planGmAdjudication（正常与编辑统一）：deltas/durations/location/复位/acted/组派生/事件 commit/工作集清算 | 无（同上） | 同上 |
| `activationContexts.ts` | activation 上下文构建器：三个无状态 activation 的全部注入上下文从最新真相 + 派生投影**逐调用现算**（cast 现建、lore 逐调用渲染档内副本、可见事件/正文滑窗/当前场景/被联系通知/fortune 透传）；突发 GM 上下文（gmIncident）+ 未裁决突发派生（pendingIncidentText：末 gm 边界后的 incident 步 → 角色与常规 GM 两侧当前场景前缀，GM 结算覆盖即自动消解）；持有世界集静态文本（setting/toneCard）；sceneForCid/remoteCidsOf 纯派生 | 无（纯读取组装） | → agents(Context 类型)/truth/scheduler/historyProjection/scheduleEffects |
| `scheduleEffects.ts` | 调度效应：applyScheduleSetup（轮首 setup 段落账）/rederiveGroups/cleanupChannels + 调度视图小工具（simChars/playerCid/cycleCount）；loop 与两个规划器共用 | 无（同上） | 同上 |
| `workingSetProjection.ts` | projectWorkingSet 纯函数：末个 gm/prose 边界后的 player/character 步（回滚/GM 编辑/普通切片由调用方传入） | 无 | → truth/workingSet/types |
| `prepareNextCommand.ts` | 执行入口统一收口（确定性计算层）：空 rules 短路直接 deriveNext；有 rules 时 draft 上跑固定规则至固定点（状态签名重复/超迭代上限 → 弃稿报错）→ 一次 commit → 重建投影 → deriveNext；投骰不进本层 | 无（commit 经注入回调） | → truth(stores/varChanges)/scheduler(derive) |
| `gameSession.ts` | GameSession 会话内核：DES 调度步编排（stepPlayer/stepCharacter/stepGm/stepProse/runPipeline）、**突发命中评估编排**（常规 GM 步 narrativity=skip 后及其正文步后：sleepingGroups 现组 → scheduler evaluateIncident → stepIncident（slim 突发包 + 目标组 timer 对齐时钟立即到期，归档 kind=incident 调度透明步；incident 步后不评估）；良恶/程度 fortune 现投现注入所有 GM 激活）、commit/adopt（commitGeneration/commitTruth/draft 机制）、pause 闸门、abortCurrent、applyResolvedConfig（配置热应用入口：adapter 原地换配置 + 滑窗/GM 间隔）、查询出口、editResult/rollbackTo/applyDirectEdit；**注入式构造**（GameSessionDeps，装配归 sessionFactory）；无独立 reroll（重 roll = Coordinator 复合命令）；onCommit 提交通知钩子（CommitNotice = prev/next 根引用，committedRoots 为差分基准）、activationId（`${runId}:act:${++seq}` 会话内单调计数器，三个 activation 点生成并经 Display.agentStart 可选第 4 参传出，currentActivationId getter 供 stop 核对）、dispose()（旗标 + abort 在途；commit 闸/runPipeline 开步抛 DisposedSessionError，已销毁会话的 agentEnd 晚到收尾不广播） | 经 CommitExecutor 整代落盘 | → agents/truth/scheduler/compile（间接）/llm/config/contracts/ports/application 内部 |
| `sessionFactory.ts` | 会话装配（configs/runId/options/worldSetId → GameSession）：ChatPort/adapter 装配、模板启动校验（读会话世界包内 prompts/ 四份模板：三 activation + gm-incident 突发变体）、**incident.json 突发公式配置读取**（缺文件即拒装）、世界设定集读取、存档 meta.json（world_set）读写、六 Store 初始/续档装载、无状态 activation 装配（三个 activation 各持对应 kind 的 ChatPort）；`SessionFactory` 端口 + `productionSessionFactory`（经 configService.loadConfigState 读配置（含迁移闸）+ save/ 存在性校验；settings 的滑窗/GM 间隔经 SessionOptions 固化进装配） | 读 data/assets、save/{runId}/meta.json | → gameSession/configService/agents/truth/compile/llm/config/resources/shared/ports |
| `sessionCoordinator.ts` | **单一命令协调器**：SessionCommand 分发 + 唯一串行队列（含 new/load）+ busy 闸 + baseRevision 乐观并发校验（RevisionConflictError）+ rollback_and_continue 复合命令（单任务内 rollback→continue，**只发一条合并 Transition**——suppressTransitions 抑制中间 rollback 提交）+ stale/pauseOptions 记忆/applyResolvedConfig 转发（配置事务热应用回调，同一份 resolved 对象，无会话 no-op）；onCommit → buildTransition → onTransition 广播；query = snapshot/stats（QueryResultMap；snapshot = 同步函数内单 revision 一致快照 + 末尾 revision 未变断言）；stop 定向中止（runId 不符 → SessionSwitchedError；activationId 不符 → 幂等空成功）；new/load 入队前 dispose 在途旧会话（强制切换）+ epoch 递增 + 旧会话晚到 onCommit 不广播 | 无直接网络/磁盘（装配委托 factory） | → gameSession/historyProjection/sessionFactory/transitionProjection/truth(errors)/ports/display |
| `historyProjection.ts` | 历史回显与正文素材投影：buildHistory（HistoryTurn/HistoryPayload；incident 步归入新一轮挂 incidents——interrupted 突发步跳过）+ proseWindow/proseWindowFor/proseWindowForRound/lastProse/participantTags；纯展示，零 IO | 无 | → truth(archive/worldStore/snapshot)/types |
| `transitionProjection.ts` | 提交 → 增量同步投影（纯函数零 IO）：CommitNotice（prev/next 根引用，恒冻结零拷贝）→ buildTransition **引用比较求差**（引用变再落 JSON 值比较兜底——draft 深拷贝引用必变）：world 根变 → 完整 world 视图；characters 逐 CID（变化 → 当前视图，消失 → null）；events 前缀比对（appendedEvents 尾切片 / truncateEventsAfterSeq + 尾部重放）；historyPatch 恒 `{type:"replace",history}`；edit_result 附 editedResult。另持 PipelineView/StateView/SessionSnapshotData/SessionTransition 下行载荷类型（application 不得依赖 server，信封 type 在 server/ws-protocol.ts 加） | 无 | → truth（类型）/scheduler(derive 的 DerivedPhase)/historyProjection/types |
| `configService.ts` | **配置事务唯一编排口**：loadConfigState（幂等迁移闸：config.json 存在且 secrets.json 不存在 → mapLegacyConfig 迁移 + 原子写三资源 + config.json 改名 .migrated.bak）→ resolved + 脱敏视图 + configRevision；applyConfigMutation（SecretMutation/PresetMutation/SettingsPatch 判别联合 + baseConfigRevision 校验 409 → 草稿应用 → resolveEffectiveAgentConfigs 解析三 activation（失败 400 零落盘）→ 原子保存 → 同一 resolved 对象热应用（注入回调；失败回写旧资源 + CONFIG_APPLY_FAILED 500）→ configRevision+1） | 读写 data/users/{user}/{secrets.json,api-presets/,settings.json} | → resources/configResolver/contracts |

## src/agents/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `character.ts` | 无状态角色 activation：CharacterContext（逐调用由 activationContexts 现算传入）→ DecisionPackage；单一实例服务全部 NPC；占位符注册表；构造注入包内 promptsDir（会话级静态，非跨调用缓存） | 经 ChatPort + 读包内 prompts/ | → compile/truth(类型)/llm/chatPort（禁 openaiChatAdapter/callLog） |
| `gm.ts` | 无状态 GM activation：GmContext → AdjudicationPackage（重裁决 + @ID 转写；validateAdjudicationRound 语义校验）；**突发变体**：GmIncidentContext → IncidentPackage（gm-incident 提示词组——"同一身份 × 不同功能 = 不同提示词组"首个实例；slim 契约独立轻校验，不复用 durations 覆盖校验）；fortune 占位符（良恶/程度判定，所有 GM 激活前注入）；占位符注册表；promptsDir 注入同上 | 同上 | 同上 |
| `prose.ts` | 无状态正文 activation：ProseContext → text，无工具纯渲染器；占位符注册表；promptsDir 注入同上 | 同上 | 同上 |
| `json.ts` | 模型输出 JSON 提取/修复工具 | 无 | 纯函数 |
| `structuredActivation.ts` | 结构化 activation 统一控制流：ChatPort 调用（流式透传）→ parse → retry 通知重试一次（**重试 messages 尾部追加首次校验错误 + 重新输出指引**，首次 messages 不变）→ 带 failureLabel 抛错；LLMAbortedError 不重试直接上抛；character/gm 共用，prose 不同构不用 | 经 ChatPort | → llm/chatPort/display |

## src/compile/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `template.ts` | 模板 schema/加载/占位符校验；目录参数必填（调用方传入包内 prompts/ 路径，无全局默认模板目录） | 读 data/assets/{包}/prompts | 纯逻辑 + fs |
| `compiler.ts` | 纯渲染器：模板 × 占位符注册表 × 注入上下文 → ChatMessage[] | 无 | → llm/chatPort（仅 ChatMessage 类型，例外已登记，待契约迁移） |

## src/llm/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `chatPort.ts` | ChatPort 端口契约：ChatRequest/ChatResult/ChatMessage/LLMAbortedError | 无 | 不依赖 src 内模块 |
| `openaiChatAdapter.ts` | OpenAI 兼容协议 adapter（流式/非流式/usage 提取/请求参数组装） | 网络 | → chatPort/config（禁 server/loop/agents） |
| `callLog.ts` | 记录 decorator：recent/cacheStats 落盘（失败只告警） | 写 save 旁路 | → chatPort/cacheStats/recent |
| `cacheStats.ts` | 缓存埋点（cache-stats.jsonl） | 写 save 旁路 | → config |
| `recent.ts` | llm-recent/{agent}.json 最近 5 轮滚动窗 | 写 save 旁路 | → config |

## src/scheduler/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `simulator.ts` | 纯逻辑派生函数集：nextDue/reconcileGroups/orderGroups/visibleEvents/initiative 系列 | 禁 IO/LLM/server/truth（审计守护） | 纯逻辑 |
| `derive.ts` | 调度派生：SchedulerSnapshot → NextCommand（deriveNext/selectFront/phaseOf/expectedGmDurationCids）；组合 simulator 算法，不读 Store/archive/LLM | 禁 IO/LLM/server/truth（审计守护） | → scheduler/simulator |
| `invitations.ts` | 邀请历史解释：InvitationProjection（增量 applyStep / 全量 rebuild / nextPending 输出 PendingInvitationView）；派生缓存，不进 Generation/CommitPlan | 禁 IO/LLM/server/truth（审计守护） | → scheduler/derive（仅类型） |
| `incident.ts` | 突发事件配置契约与求值编排：IncidentConfig schema + compileIncidentConfig（编译世界包表达式 + 变量闭包校验）+ mismatchD/hitF/hitG/hitProbability/malignPercent/rollFortune/evaluateIncident（按编译后公式求值，骰子经 DicePort 注入）；公式结构与参数唯一出处 = 世界包 incident.json | 禁 IO/LLM/server/truth（审计守护） | → ports/shared/formula |

## src/truth/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `worldStore.ts` | world/pipeline 状态容器（纯内存）+ world 域 VarChange 生产/恢复（applyDeltas）+ **StepChanges 分段契约**（setup/effects；flatChanges 扁平化出口；phase 不落盘、一律现算） | 无（落盘归 generationRepository） | → types/config（禁 agents/server/llm/application） |
| `stores.ts` | **TruthStores 六 Store 成组视图 + cloneTruth/adoptTruth/collectSave**（loop 与 application 规划器共用；纯内存，draft 失败即弃零副作用） | 无 | → truth 各 Store/generationRepository（SaveSet 类型） |
| `varChanges.ts` | VarChange 契约 + 真相根路径引擎（get/set/deleteByPath、makeVarChange；路径口径 `world.*` / `characters.CID.*`） | 无 | 纯逻辑（不依赖 truth 内其他模块） |
| `charactersStore.ts` | 角色状态容器（纯内存）+ relations/长期记忆 VarChange | 无（同上） | 同上（CharacterManifest type-import 为例外，待契约迁移） |
| `events.ts` | 事件日志容器（纯内存；append/截断/认知过滤）+ scanEventWatermark（事件 ID 水位，纯函数） | 无（同上） | 同上 |
| `archive.ts` | 正文结果持久化 participants+scenes；步骤归档（纯内存） | 无（同上） | 同上 |
| `loreStore.ts` | lore 条目 + changelog（纯内存） | 无（同上） | 同上 |
| `timeStore.ts` | time.json 档内副本（纯内存）+ 结构化时间渲染 | 无（同上；loadWorldTime 读 data/assets 例外） | 同上 |
| `generationRepository.ts` | **存档唯一写盘出口**：Generation 布局（CURRENT + generations/{rev}/ 六文件）、SaveSet 信封读写、**原子提交**（临时目录 → 重读 codec + validateSaveSet（默认 = validation/saveSet.ts，可注入替换）→ rename → CURRENT.tmp rename 切换；保留 current+previous，更旧 best-effort 清理；构造清理 .tmp 残留）、**灾备回退**（loadCurrent 对 corrupt/incomplete/invariant 回退上一代 + recoveredFrom；loadPrevious 显式灾备读取；加载与提交同一校验口径）、**类型化 SaveLoadError 错误分类**、baseRevision 乐观并发闸（RevisionConflictError）、无 CURRENT 的平铺档拒载 | 读写 data/users/{user}/save/{runId} | → truth 内部/types（runDir + RepoIo/validator 注入，禁 config/agents/server/llm） |
| `validation/errors.ts` | 类型化存档错误：SaveLoadError（kind = not_found/incomplete/version/corrupt/invariant/io）+ RevisionConflictError（base/current 双值） | 无 | 纯类型（不依赖 truth 内其他模块） |
| `validation/saveSet.ts` | **两级校验第二级**：validateSaveSet 整档跨文件不变量（pipeline/archive/events 边界与对应、事件 id 唯一、working_set/archive 角色步引用闭包、CID 键形、lore id 唯一与 changelog seq 整数；只校验可提交态，多个 isPlayer 合法），失败抛 invariant | 无 | → generationRepository（SaveSet 仅 type-import）/errors |
| `validation/fileSchemas.ts` | 六个 File schema 汇聚出口（两级校验第一级 = 文件 codec；本体留各 Store 文件，本文件仅 re-export） | 无 | → truth 各 Store |
| `commitExecutor.ts` | **一次命令一个提交的唯一落地入口**：CommitPlan（transactionId=`tx-{next}` 确定性 / baseRevision / reason=init·step·gm·rollback·admin_edit / changes=与归档 changes 同一份；plan 不落盘）→ baseRevision 校验（经 repo 闸）→ validateSaveSet（repo 钩子）→ repo.commit；GameSession 六条写盘路径全经它 | 经 generationRepository | → generationRepository/varChanges（禁 agents/server/llm） |
| `workingSet.ts` | 工作集（当前轮未清算言行） | 无 | → types |
| `saveSchema.ts` | SAVE_SCHEMA_VERSION 常量 + version 类错误统一措辞（INCOMPATIBLE_SAVE_MESSAGE；schema_version 不符/平铺档拒绝，判别走 SaveLoadError.kind="version"） | 无 | 无依赖 |
| `snapshot.ts` | 注入层状态序列化（timer 结构化渲染等）+ **DeepReadonly/deepFreeze**（恒冻结策略：repo.loadGeneration 返回前 + GameSession 每次 commit/adopt 后递归 Object.freeze，查询出口返回 DeepReadonly，越界写入测试期立刻爆炸） | 无 | → truth 查询 |
| `varDiff.ts` | 状态直编 diff：净额并入当步 changes | 无 | 纯逻辑 |
| `identity.ts` | @CID 占位渲染/姓名替换 | 无 | 纯逻辑 |
| `lorebook.ts` | 世界书条目模型与匹配 | 读 data/assets | → config |

## src/contracts/（禁依赖 truth/agents/server/llm/application）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `config.ts` | 配置契约：ServerConfig/UserSettings/ApiPreset/ResolvedAgentConfig/**ConfigStateView**（GET /api/config 脱敏视图）+ **配置事务 mutation 契约**（PresetMutation/SettingsPatch/ConfigPutBody/ConfigMutation 判别联合）+ **FileConfigSchema/validateFileConfig**（旧版 config.json 文件形状唯一出处，唯一消费方 = configService 迁移闸） | 无 | zod + contracts/secrets |
| `secrets.ts` | 密钥契约：SecretKind/Record/File/State/Mutation + 掩码 | 无 | zod |
| `protocol.ts` | **WS 入站协议唯一权威**：ClientCommandSchema（zod discriminated union，.strict() 分支）+ parseClientCommand（非法 JSON/null/数组/未知 type/字段错误 → ProtocolError 稳定 message）+ PauseOptionsSchema；消息身份字段（全部可选）：mutation 带 requestId/runId/baseRevision，pause_options·stop·query·new_session·load_session 免 baseRevision，player_input 的 runId 可省略（首次输入自动建会话），new_session 无 runId，stop 另带可选 activationId；重 roll = rollback_and_continue 复合命令 | 无 | zod |

## src/resources/（只允许依赖 shared/contracts + types；禁反向依赖 config）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `userDirectories.ts` | 用户目录解析：data/assets/{世界包}/（设定集 + incident.json 突发公式配置 + 包内 prompts/ 完整提示词副本：三 activation + gm-incident）+ data/users/{username}/（secrets.json / api-presets/ / settings.json / save/ 存档家目录）；default_user 唯一出处；config.ts 路径常量由此派生 | 无（纯路径计算） | → shared |
| `secretsRepository.ts` | 密钥仓储：secrets.json 原子读写（.tmp→rename；缺文件=空；损坏 → 类型化错误）+ applySecretMutation 纯变换（write/delete/activate/rotate/rename；delete active 后取剩余首条继任）+ toSecretState 掩码投影 | 读写 data/users/{user}/secrets.json | → shared/contracts(secrets) |
| `presetsRepository.ts` | API 预设仓储：api-presets/{id}.json 逐文件 CRUD/duplicate（id 经 safeSegment；ApiPresetSchema 校验） | 读写 data/users/{user}/api-presets/ | → shared/contracts(config) |
| `settingsRepository.ts` | 用户设置仓储：settings.json（UserSettings + configRevision）读写；缺文件=默认 | 读写 data/users/{user}/settings.json | → contracts(config) |
| `runRepository.ts` | 存档仓储：listRuns/别名读写/deleteRun/readRunArtifact；RunRepositoryError 稳定码（RUN_NOT_FOUND/LEGACY_RUN_UNSUPPORTED/RUN_CORRUPT/SESSION_ACTIVE/INVALID_ALIAS）；无 CURRENT → LEGACY_RUN_UNSUPPORTED；产物缺失 → RUN_NOT_FOUND；JSON 损坏 → RUN_CORRUPT | 读写 data/users/{user}/save/ | → shared/types(zod) |
| `worldRepository.ts` | 世界仓储：listWorldSets/resolveWorldDir（canonical 实现，config.ts 委托于此）+ 世界三文件读写 + 角色 manifest 路径/读写 + **包内提示词模板文件读写（{packDir}/prompts/{agent}.prompt.json）** + validateLorebookPayload；WorldRepositoryError（WORLD_SET_NOT_FOUND/CHARACTER_NOT_FOUND/INVALID_WORLD_SET）；结构校验（CharacterManifest/PromptTemplate schema 属 agents/compile）留在 server 路由层 | 读写 data/assets/{包}/ | → shared/types(zod) |

## src/shared/（禁依赖 src 内任何模块）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `safeSegment.ts` | 路径段安全校验（防目录穿越） | 无 | 纯函数 |
| `formula.ts` | 世界包公式求值器：小型数学表达式语言（数字/标识符/+ − * / ^/括号/一元负号/函数 ln·exp·sqrt·abs·tanh·sigmoid·clamp·min·max/骰子项 NdM）编译为可复用闭包；解析期报语法/未知函数错，未知变量求值期报错；骰子经结构化 `(face)=>number` 注入（不 import ports） | 无 | 纯函数 |

## src/server/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `index.ts` | **组成根**：只装配依赖并启动——WsTransport + WsController + createApiHandler + serveStatic；Coordinator 的 displayFactory/onTransition 重绑到本服 transport 广播；loadServerConfig → 接入边界（HTTP handler/WS upgrade 入口过 accessControl，拒绝 → 403）+ allowKeysExposure 注入 ApiDeps；startServer(options?: {host, port, coordinator, dirs, configFile, serverConfigFile, serverConfig}) 可注入（测试基建：临时资源目录 + fake factory，缺省走 env/生产现状） | 网络 | → server 内部/application(sessionCoordinator)/resources/config/serverConfig |
| `static.ts` | 静态文件服务（伺服 web/，拒目录穿越） | 读 web/ | → config(PROJECT_ROOT) |
| `ws-transport.ts` | WS transport：upgrade（只认 /ws；attach 接受 checkUpgrade 注入——接入边界判定在 accessControl，拒绝 → 403 响应后 destroy）/连接集/序列化/单播/广播；onConnect/onMessage 回调注入——不认识 ClientCommand | 网络 | → ws-protocol（类型） |
| `ws-controller.ts` | WS controller（线协议不变）：parseClientCommand → Coordinator → 定向 command_result/command_error（requestId 关联，异常 → 稳定 code：REVISION_CONFLICT 附 details 双值）；runId 身份核对（不符 → SESSION_SWITCHED）；重连单播/会话切换广播/query 跳号恢复的一致 snapshot | 网络（经 transport） | → application(sessionCoordinator)/contracts/truth(errors)/ws-transport |
| `ws-protocol.ts` | WS 下行 ServerMessage 类型唯一出口：command_result/command_error（ProtocolErrorCode 七值）/transition/snapshot（载荷类型来自 application/transitionProjection.ts）/流式七种（agent_start·delta·reasoning·agent_end·retry·decision·adjudication，全部带 runId+activationId） | 无 | → application(transitionProjection 类型)/types |
| `display.ts` | WebDisplay（Display 接口的 WebUI 实现；构造绑定 runId，agentStart 记录 activationId，全部流式消息盖 {runId, activationId}，agentEnd 清空） | ws 推送 | → display 接口/ws-protocol |
| `http/response.ts` | HTTP envelope：成功 {ok:true,data} / 失败 {ok:false,error:{code,message,details?}}；sendJson/sendOk/sendFailure + readBody/parseJsonBody（非法 JSON → 400 BAD_JSON）/requireStringField | 网络 | → errors |
| `http/errors.ts` | ApiError{status,code,details?} + toApiError 收敛（ZodError→400；RunRepositoryError/WorldRepositoryError/配置三仓储按码映射；ConfigServiceError→400/409/500（CONFIG_INVALID/CONFIG_REVISION_CONFLICT·PRESET_IN_USE/CONFIG_APPLY_FAILED）；RevisionConflictError→409 附双值；「LLM 运行中」→409 SESSION_BUSY；未预期→500 INTERNAL_ERROR）+ validate() 校验段包装；403 FORBIDDEN（secrets view 未开 allowKeysExposure）；401 留码位未启用 | 无 | → application(configService)/resources/truth(errors)/zod |
| `http/router.ts` | {method,pattern,handler} 轻量路由表 + :param 段匹配；路径无匹配 → 404 UNKNOWN_ENDPOINT，路径匹配方法不符 → 405 + Allow；createApiHandler 组装八个分域 routes（唯一收口）；ApiDeps.config = ConfigServiceDeps（配置事务注入位）+ allowKeysExposure（由组成根从 server.json 注入） | 网络 | → routes/*/errors/response |
| `http/routes/config.ts` | GET/PUT /api/config（GET 返回 ConfigStateView 脱敏视图；PUT = settings/agent 绑定 patch，带 baseConfigRevision，走 configService 事务） | 经 configService | → application(configService)/contracts/config/errors/response |
| `http/routes/secrets.ts` | /api/secrets/*：GET state / POST write / activate / rename / DELETE / view（allowKeysExposure=false → 403 FORBIDDEN） | 经 configService | → application(configService)/errors/response |
| `http/routes/presets.ts` | /api/presets CRUD + duplicate（被任一 agent 绑定引用的 preset 拒删 → 409 PRESET_IN_USE） | 经 configService | → application(configService)/errors/response |
| `http/routes/worlds.ts` | GET /api/worlds、GET/PUT /api/world/:name（?set=；PUT markStale 新会话生效） | 经 worldRepository | → resources/config(DEFAULT_WORLD_SET)/errors/response |
| `http/routes/characters.ts` | GET /api/characters[/:id]（?set=）+ PUT（validateCharacterManifestForPath：schema + 路径 id 对拍，C0 唯一 isPlayer；markStale） | 经 worldRepository | → agents(character schema)/resources/errors/response |
| `http/routes/prompts.ts` | GET /api/prompts[/placeholders] + PUT /api/prompts/:agent（?set= 定位包内 prompts/，缺省 DEFAULT_WORLD_SET；validatePromptPayload：结构 + 占位符合法性对注册表；热加载下一轮生效；包选择器界面未做） | 经 worldRepository | → agents(注册表)/compile/resources/errors/response |
| `http/routes/sessions.ts` | GET /api/sessions、GET /api/sessions/:id/:kind（回放产物）、GET llm-recent/:slug、POST rename、DELETE（拒删活跃 409） | 经 runRepository/llm(recent) | → resources/llm/shared/errors/response |
| `http/routes/activeSession.ts` | PUT /api/session/state 直编（Coordinator direct_edit 入队；busy → 409 SESSION_BUSY，域校验失败 → 400；commit → transition 广播；body 可选 baseRevision 乐观并发闸 → 409 REVISION_CONFLICT） | 无直接 IO | → application(errors/response) |
| `accessControl.ts` | HTTP/WS 接入边界纯判定：checkHttpAccess/checkWsUpgrade——Host 头须等于监听地址或命中 hostWhitelist（loopback 默认放行 localhost/127.*/[::1]）；WS Origin 存在时其 host 须匹配 Host；ipWhitelist 非空时 remoteAddress 须命中（::ffff: 归一）；拒绝 → 403 | 无 | → serverConfig(类型) |

## web/（无构建 Vanilla ESM 前端）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `protocol.js` | 浏览器唯一协议适配器：buildCommand（字段白名单，未知字段抛错）+ serialize；`createProtocol({transport, store, onStreaming, onUncorrelated})`——sendCommand 自动附加消息身份（requestId 随机 + 从 store 读 runId/revision，未连接立即 reject）并返回 Promise（pending Map 按 requestId 关联 command_result/command_error）；handleMessage 路由：result/error→pending、snapshot/transition→store（needsResync 自动补 snapshot query）、流式七种→store 身份槽校验后直通 onStreaming；纯 ESM 零 DOM 零 socket 构造（node:test 可直接 import；`protocol.d.ts` 供 TS 契约测试） | 无 | → session-store/session-transport（仅类型，运行时装配注入；与 contracts/protocol.ts 契约测试对拍） |
| `session-store.js` | 会话状态 store：服务端权威状态唯一前端持有者（runId/revision/connection/world/characters/events/history/pipeline/streaming 槽/needsResync）；纯 reducer（dispatch snapshot/transition/流式/connection 内部消息）+ subscribe（meta 带 runIdChanged 信号/changed 域）；transition 仅 runId 匹配且 fromRevision 连续才应用否则置 needsResync；selectBusy = streaming 非空 \|\| phase ≠ await_player（输入权限唯一数据源，busy 语义单测锁死）；零 DOM 零网络（`session-store.d.ts` 供 TS 测试） | 无 | 无依赖 |
| `session-transport.js` | WebSocket 传输层：独占唯一 socket——connect/send/reconnect/dispose + getState；connection generation 守卫（每次 connect ++gen，旧 gen 回调一律丢弃）；单一 reconnect timer（先清后挂）+ 指数退避 1s→2s→4s 封顶 10s（open 复位）；send 未连接返回 false；dispose 后无重连；WebSocket 构造器/url/时钟全部注入（测试 fake；`session-transport.d.ts` 供 TS 测试） | WebSocket | 无依赖 |
| `resource-context.js` | 资源上下文：世界/角色等用户资源 URL 唯一构造口——`createResourceContext({username, worldSetId})` 捕获即不可变（冻结），worldUrl/worldFileUrl/charactersUrl/characterUrl 全携带 `?set=`（worldSetId 必填即抛）；编辑表单打开时捕获、保存写同一 ctx，不随 picker 漂移；纯 ESM 零 DOM 零网络（`resource-context.d.ts` 供 TS 测试） | 无 | 无依赖 |
| `async-guards.js` | 四个竞态的可测纯逻辑（零 DOM 零网络，fake 注入驱动单测）：createEpochGuard（会话详情 epoch 守卫）/ fetchRunDetail（回放五端点取数归一，数据与渲染分离）/ fetchKnownChars + sameCharsIdentity（CID 取数与晚到写闸）/ isModalLive（modal runId 身份 + isConnected 双核验）/ loadSessionThenNavigate（command_result 成功才导航）（`async-guards.d.ts` 供 TS 测试） | 无 | 无依赖 |
| `views/play-stream.js` | 游玩页流区 view：流式卡片（三 agent 同构 panel + 突发 incident 轻量卡（无菜单不可编辑）+ 思维链/原始返回/提示词模态 + 回滚/重 roll/编辑菜单）/ 决策分节渲染 decisionSections（NPC 卡与玩家卡共用，玩家卡带"你"标签、菜单含原始返回编辑/回滚、data-kind/seq 寻址 + onEditedResult 原地重渲）/ panels 卡片 Map / renderHistory / 钉底滚动；会话 modal 打开捕获 runId、await 后 isModalLive 核验，全部经注入的 trackModal 进统一生命周期；el/api/getState/命令通道/confirm 全注入（import 期零副作用；fake element 桩可测，`play-stream.d.ts` 供 TS 测试） | 无（DOM 经注入 el） | → async-guards |
| `views/play-input.js` | 游玩页输入区 view：三块输入（台词/行动/内心）+ 五标记区（chips + 召回/联系参数表单）+ relations 记录条（复用联系标记目标选择模式，name/impression 至少其一，缺 target 或全空即禁发送）+ 暂停选项行（localStorage 持久化）；持有 transient UI 态（markers/relations/knownChars/blockEls/pauseState）；refreshCids 捕获 {runId, worldSetId} 晚到核验弃写；el/api/身份读取/回调全注入（fake element 桩可测，`play-input.d.ts` 供 TS 测试） | 无（DOM 经注入 el） | → async-guards |
| `views/state-editor.js` | 直编 modal view：打开捕获 {runId, baseRevision}；保存 PUT /api/session/state 带 baseRevision（409 REVISION_CONFLICT → 编辑器内提示「状态已变化，请刷新」不静默覆盖）；保存前核验 store runId（切 run 拒写）；overlay 经 trackModal 注册；el/api/getState/trackModal/mountModal 全注入（fake element 桩可测，`state-editor.d.ts` 供 TS 测试） | 无（DOM 经注入 el） | 无依赖 |
| `pages/play.js` | 游玩页编排层：装配 store←transport→protocol + 两个 view；store.subscribe → 侧栏/权限/runId 行重渲 + snapshot 整段重渲历史 + runId 变化 transient reset（inputView.resetTransient + closeSessionModals 统一关 modal）；onStreaming 直通 streamView；busy/权限全部从 store 派生；sendSessionCommand 供会话页读档 | WebSocket（经 transport）+ fetch（api） | → app/protocol/session-store/session-transport/views/* |
| `pages/sessions.js` | 会话页：loadRun 模块级 epoch 守卫 + AbortSignal（快速点击晚到弃写；取数 = async-guards.fetchRunDetail，渲染分离）；「读取」改 async——load_session 成功才 navigate("play")，失败（含 WS 未连接）原页报错不导航 | fetch（api） | → app/async-guards/play（sendSessionCommand） |
| `pages/world.js` | 世界页（ResourceContext 接线）：世界包选择器（/api/worlds）+ setting/tone-card 编辑器 + lorebook 表格；打开即捕获不可变 ctx（GET/PUT 全程 ?set=），切包 = 重新捕获 + 重载表单，界面常显「正在编辑」包名 | fetch（api） | → app/resource-context |
| `pages/characters.js` | 角色页（ResourceContext 接线）：世界包选择器 + manifest 表单；同 world 页口径（ctx 捕获 + ?set= 全程 + 切包重载） | fetch（api） | → app/resource-context |
| `pages/config.js` | 配置页：密钥（增/激活/重命名/删/查看明文 403 提示）+ API 预设（增删改/复制，409 PRESET_IN_USE 提示）+ Agent 绑定 + 运行设置四区；页面持有 configRevision，全部 mutation 携带 baseConfigRevision，成功用返回 {configRevision, view} 原地更新不重取，409 CONFIG_REVISION_CONFLICT → 提示并重取；请求体构造全走 views/config-form.js（密钥值绝不回填） | fetch（api） | → app/views/config-form |
| `views/config-form.js` | 配置页请求体构造纯逻辑（零 DOM 零网络）：留空=保持不变 patch 语义、掩码值出现即拒构造防呆、preset 表单→payload | 无 | 无依赖 |

## scripts/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `check-dependencies.ts` | 依赖审计：禁边/传递依赖/import 循环（TS Compiler API） | 读 src | 独立脚本 |
| `run-suite.ts` | 测试套件 runner（读 test-suites.json，spawn node --test） | 进程 | 独立脚本 |
| `test-suites.json` | 四层套件清单：unit/contract/application/integration | 无 | — |

## test/

| 路径 | 职责 |
|---|---|
| `builders/index.ts` | 最小合法内存对象 + overrides（不写盘） |
| `fakes/chatPort.ts` | ScriptedChatPort / FakeChatScript（替代 LLM prototype patch） |
| `fakes/deferredChatPort.ts` | DeferredChatPort（集成测试）：chat() 挂起由测试手动 resolve/reject，abort → LLMAbortedError；auto 非空走脚本化快速应答 |
| `harness/tempDir.ts` | 统一临时目录 + 自动清理（Windows rm 重试） |
| `harness/session.ts` | SessionHarness：临时 save/assets（世界包含包内 prompts/ 四份模板拷贝 + incident.json 突发公式默认配置）+ fake LLM + 队列骰子装配 |
| `harness/server.ts` | serverHarness：tempDir + fake SessionFactory（真实 GameSession + DeferredChatPort）+ startServer 注入（port 0 + 临时 UserDirectories/configFile，不触碰真实用户数据）+ 真实 ws 客户端 helper（消息全录 + waitFor 谓词等待） |
| `harness/legacyConfigResolver.ts` | 旧版 config.json 分层解析（resolveAgentConfigs）对拍基准（纯函数零 IO，仅迁移等价性测试消费） |
| `incident.test.ts` | 突发公式单测：D 双算法/f(D)/g(T) 锚点、p恶性 clamp、程度区间、evaluateIncident 逐组投骰与多组取高 |
| `formula.test.ts` | 公式求值器单测：优先级/^右结合/一元负号/函数库/骰子项顺序消费/语法与未知变量报错 |
| `incidentFlow.test.ts` | 突发管线集成（SessionHarness）：命中 → incident 步归档 → 目标组 timer 对齐 → 角色/GM 两侧当前场景注入 → GM 转写后注入消解 → 回溯复活重评 |
| `httpEnvelope.test.ts` | HTTP envelope 集成测试：真实 HTTP 逐端点 envelope 形状 + 状态码矩阵（400/404/405+Allow/409/500 故障注入）+ HTTP mutation 成功恰一条 transition/失败无广播 |
