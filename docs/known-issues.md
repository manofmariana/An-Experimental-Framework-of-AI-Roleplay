# Known Issues（未复现/待现场）

记录已观察到但无法复现的 bug。复现路径明确或修复后移出本文件（修复以回归测试为准）。

## KI-001 读档后"NPC 已发言但 acted=false"

- **首次报告**：2026-07-31（M2-b 手测期）。
- **现象**：读取某存档后，当前轮 NPC 明明刚发过言（二人组新周期第一棒，NPC 先攻高于玩家），其 `acted` 却是 `false`；该存档 `phase=await_player` 与玩家先行动的表现自洽，但变量与"NPC 已行动"的事实矛盾。后续回滚到该轮后玩家无法发言（派生出 await_character）。
- **已排除**：常规路径无此问题——专项复现测试 `test/reproActedRollback.test.ts`（纯内存 / 存档→恢复→再走两变体，NPC 发言→玩家发言→NPC 再发言→回滚到首发言）均通过，跨周期回滚能正确恢复 `acted=true`。
- **可疑方向**：状态直编曾把机制变量改成不可能状态；中途 GM 激活与标记流（contact/leave/recall）交互；存档写盘与步完成的竞态。
- **临时对策**：状态直编手动修正 `acted`（直编已即时生效并广播 pipeline，2026-07-31 修复）。
- **状态**：未复现，等下一次现场（出现时保留 runs/{runId} 整个目录）。

## KI-002 新存档读到上一存档的事件

- **首次报告**：2026-07-31（M2-b 手测期，仅一次）。
- **现象**：新建存档后，事件列表里出现上一个存档的事件。
- **事实**：事件持久化在 `runs/{runId}/events.json`，按 runId 隔离；agent 内存事件是运行时从档内文件重建的副本，理论上不会串档。疑似进程内旧 session 的内存态/WS 推送残留（新会话建立与旧 session 推送、agent restore 的时序）。
- **进展（2026-08-03，§4 无状态 activation）**：agent 缓存通道已结构性关闭——三个 activation 不再持有事件/上下文缓存，注入全部由 `src/application/activationContexts.ts` 逐调用从当前真相现算，旧存档缓存参与调用的路径不复存在。剩余嫌疑通道 = 旧会话在途任务与 WS 广播隔离（属阶段 D 收敛范围）。
- **状态**：未复现，等下一次现场（出现时记录新旧 runId、是否同进程内新建、前端是否刷新过页面）。

## 已知简化登记（非 bug，有意取舍）

- **中止超时强制失效计时器未实现（D2，2026-08-03）**：docs/optimization-review.md §5「若 SDK 中止超时，则使旧 epoch 失效」的超时计时器不做；兜底 = `GameSession.dispose()` 旗标——commit 闸（commitGeneration/commitTruth）与 runPipeline 开步对已销毁会话一律抛 DisposedSessionError，旧会话晚到 onCommit 经 Coordinator 代际核对（session 身份 + disposed）不广播。集成测试：test/wsProtocol.test.ts「延迟 LLM 期间 new_session 强制切换」。
- **前端 transition 到达即清 busy（D2，2026-08-03；D4 已收敛）**：D4 起 busy 改为从 session-store 派生（`selectBusy` = streaming 槽非空 || pipeline.phase ≠ await_player），步间 phase 仍非 await_player → 输入权限不再瞬闪；按钮类闸（继续/停止/直接编辑/重 roll/编辑模态）按 streaming 槽单独判定，暂停点可操作（语义见 web/pages/play.js 头注「busy 语义终稿」，回归锁 = test/webStore.test.ts「selectBusy 语义锁」）。
- **前端 transition 的 historyPatch 恒整段重渲（D2 v1；D4 保持）**：每步提交后流式卡归位为历史卡（流式期累积的 raw/思维链游离节点随之替换，仍可从历史卡菜单读取）；D4 订阅化未改此口径，增量 history patch 与卡片级保留留 D5 抽 view 时一并评估。
