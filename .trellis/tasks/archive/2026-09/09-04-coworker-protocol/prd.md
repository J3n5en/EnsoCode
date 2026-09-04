# Coworker protocol improvements

## Background

用 coworker 做 TDD 角色分离（usage-stats 任务）后回看其 session jsonl，发现四个协作协议层面的缺口：

1. 主 agent 没有「阻塞等某个 coworker 本轮结束」的原语，只能 `sleep N` 轮询。
2. 轮次结果被截断（异步通知 1500 字、阻塞返回 4000 字），主 agent 拿不到全文。
3. coworker 不知道主 agent 正在 `wait:true` 阻塞，`message_main_agent` 在此时属于冗余上报，且工具回执文案误导。
4. 没有面向「测试先行者」的 agent type：用 `worker` 时注入的 `<role>` 是「实现并验证」，与 RED-only 指令矛盾；且 tester 可以随意改实现文件，红灯全靠自觉。

## Scope

1. coworker 工具新增 `wait {name, gate?}`（阻塞至该 coworker 当前轮结束，空闲时立刻返回）与 `report {name}`（返回最近一轮的完整结果，上限 20000 字）。
2. supervisor 记录每个 coworker 最近一轮的摘要；异步通知 / 阻塞返回被截断时提示用 `report` 取全文。
3. `message_main_agent` 感知父在阻塞等待：此时不投递通知，工具回执改为「主 agent 正在等本轮，你的收尾文本即结果」。
4. 新增内置 agent type `tester`：`tools: 'all'` + `writeScope: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'test/**']`；edit/write 越界即拒绝并说明；role prompt 明确「只写失败测试、不改实现、确认红灯原因」。`writeScope` 作为 AgentTypeEntry 可选字段，自定义类型也能用。

## Non-goals

- 不限制 tester 的 read（契约/类型必须可读）；bash 仍经审批门。
- 不改 UI（AgentTypesSettings 暂不暴露 writeScope 编辑；tester 显示为内置类型即可）。

## Acceptance

- `pnpm typecheck && pnpm lint && pnpm test` 绿；新增纯逻辑（glob 匹配、写范围包装、工具路由、messageMain 抑制）TDD。
- coworker.test.ts / messageMain.test.ts / 新 writeScope.test.ts 覆盖上述契约。

## Outcome (2026-09-04)

Commits b2054a5..25b59f7 on `enso/3085e88f`. Beyond the planned scope, on-device verification (fake provider + CDP) surfaced and fixed:
- tool-hired coworker sessions were never indexed in Main → user prompts from the coworker tab were silently rejected (`invalid prompt or stale session generation`); now `coworker-update` carries `coworkerIdentity` and the index registers it.
- parallel tool batches `spawn + wait/report/send` raced `spawnCoworker` → names resolve against in-flight spawns; a dispatched-but-not-started round counts as pending for `wait`.
- `wait` consuming a round no longer also triggers the async "finished a round" notice.
- registration-time `emitStatus` produced a bogus "(coworker produced no output)" summary (found by the tester coworker's it.todo).

Verified on device: tester type `write src/impl.ts` rejected by write scope, `write src/impl.test.ts` allowed; `spawn`+`wait`+`report` in one batch returns hired / round result / in-progress note.
