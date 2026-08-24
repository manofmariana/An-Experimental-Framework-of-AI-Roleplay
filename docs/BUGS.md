# BUGS（未解决、难复现）

记录已观察到但无法复现的 bug。复现路径明确或修复后移出本文件（修复以回归测试为准）。

## KI-001 读档后"NPC 已发言但 acted=false"

- **首次报告**：2026-07-31。
- **现象**：读取某存档后，当前轮 NPC 明明刚发过言（二人组新周期第一棒，NPC 先攻高于玩家），其 `acted` 却是 `false`；该存档 `phase=await_player` 与玩家先行动的表现自洽，但变量与"NPC 已行动"的事实矛盾。后续回滚到该轮后玩家无法发言（派生出 await_character）。
- **已排除**：常规路径无此问题——专项复现测试 `test/reproActedRollback.test.ts`（纯内存 / 存档→恢复→再走两变体，NPC 发言→玩家发言→NPC 再发言→回滚到首发言）均通过，跨周期回滚能正确恢复 `acted=true`。
- **可疑方向**：状态直编曾把机制变量改成不可能状态；中途 GM 激活与标记流（contact/leave/recall）交互；存档写盘与步完成的竞态。
- **临时对策**：状态直编手动修正 `acted`（直编即时生效并广播 pipeline）。
- **出现时请保留**：`data/users/{user}/save/{runId}/` 整个目录。

## KI-003 编辑删除 recall 标记后目标仍在组内

- **首次报告**：2026-08-04（单次）。
- **现象**：编辑角色步原始返回、删除 recall 标记后，目标角色仍留在组内（召回效应未撤销）。
- **已排除**：机制链路完整——回归测试（回滚到 recall 步 → editResult 删除 recall → 目标回 group=0/timer=null）通过（`test/editMarkers.test.ts`）；commit → 广播 → 前端渲染逐环静态追踪无断点。
- **可疑方向**：编辑目标步不是 recall 所在步（仅最新步可编辑，回滚位置偏差）。
- **出现时请记录**：recall 所在步的 seq/kind、回滚目标、编辑的卡片 seq。

## KI-002 新存档读到上一存档的事件

- **首次报告**：2026-07-31（仅一次）。
- **现象**：新建存档后，事件列表里出现上一个存档的事件。
- **事实**：事件按 runId 隔离，持久化在 `data/users/{user}/save/{runId}/` 的 Generation 内；activation 无状态，注入全部由 `src/application/activationContexts.ts` 逐调用从当前真相现算，结构上不存在跨档缓存通道。剩余嫌疑通道 = 旧会话在途任务与 WS 广播隔离。
- **出现时请记录**：新旧 runId、是否同进程内新建、前端是否刷新过页面。
