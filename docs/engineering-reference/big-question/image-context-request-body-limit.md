# 长工具轮图片累积与请求体字节上限

## 症状

读图密集的长任务先正常调用工具，随后某次 `read` 图片后持续返回转发服务的
Cloudflare `502 origin_bad_gateway`。等待数分钟、重新生成后仍失败；一次上下文
压缩后可能恢复，继续读图又再次失败。

首先检查请求体字节预算，不能只按上下文 token 使用量判断，也不能把所有 502
都认定为本问题。客户端预算修复已实现并通过 SDK 回归与历史离线重放；
转发服务为什么返回 502 而非 413，仍需服务端日志确认，真机验收尚未完成。

## 根因

### 客户端已确认的缺口

1. `pruneHistoricalImages` 以最后一条 `role: user` 为轮次边界。一个用户指令内
   连续运行上百次工具，期间读取的所有图片仍属于当前轮，不会被历史图片策略淘汰。
2. compaction 可以切在工具轮中间，移走原始 user，只留下 `compactionSummary`
   与 assistant / toolResult。图片清理发生在 `convertToLlm` 之前，summary 此时
   还不是 user；`lastUserIndex < 0` 会原样返回，完全跳过图片清理。
3. pi 的 `read` 与用户图片输入会执行单图尺寸 / 编码体积处理，但单图合格
   不代表完整请求合格。小于单图阈值的 PNG 可以原样保留。
4. Anthropic 请求映射将图片作为内联 base64 重发，没有在此阶段重新压缩图片。
   token 压缩预算不等于最终 JSON 的字节预算，当前图片钩子也没有整包体积守卫。
5. 手动 retry 在 supervisor 中走裸 `agent.continue()`，绕过 AgentSession 的
   post-run 重试 / 压缩调度。它不会自动把原本超大的请求变小，见
   [pi-auto-retry-willretry.md](pi-auto-retry-willretry.md)。

### 离线重放证据

调查会话 `01a101e8-d5c0`：只有一条 user 消息，共读取 65 张 PNG；最大单图
1,996,974 字节，最大边长 1800 px，未发现单图明显超限。另一被引用文件
`01a1027a-26ee` 当时只有 8 条记录、无图片、一次 `Request aborted` 和回退记录，
没有 502，不能将前一会话结论未经验证推广到它。

用 pi 0.87.1 的 `buildSessionContext` 重建各时间点投影，经过实际
`sanitizeContextMessages` / `convertToLlm`，再用 Anthropic adapter 的 `onPayload`
测量 JSON；使用 mock client 并在 `onPayload` 主动结束，API 请求数为 **0**。
以下是本地重建值，不是历史网络抓包；未重现外部扩展和历史运行时全部选项。
该会话没有 explore mark / fold 调用。

| 时间（2026-10-03 UTC） | 图片数 | 重建请求体字节数 | MiB | 历史结果 |
| --- | ---: | ---: | ---: | --- |
| 14:00:43，首次失败前一请求 | 37 | 32,199,078 | 30.707 | 随后工具调用成功 |
| 14:00:59，再读一图 | 38 | 33,636,663 | 32.078 | 随后连续 4 次 502 |
| 14:01:43，压缩完成 | 9 | 5,959,967 | 5.684 | 14:12:04 起再次成功调用工具 |
| 15:06:04，末次成功前 | 35 | 33,484,910 | 31.934 | 15:06:15 工具调用成功 |
| 15:06:16，再读一图 | 36 | 34,309,568 | 32.720 | 15:06:22 起持续 502 |
| 15:52:31，末尾重试投影 | 36 | 34,309,568 | 32.720 | 仍为 502 |

末尾 36 张图的 base64 **单独**占 33,659,228 字节，已经超过 32 MiB，
不依赖 system / tools / 文本估算。只在内存副本中排除最后一图，重建整包变为
33,485,378 字节（31.934 MiB）；没有改动 jsonl，也没有发送对照请求给上游。

两次跨过约 32 MiB 的边界都紧接失败、缩小后曾恢复，因此“累计图片使请求体过大”
是强证据支持的首要解释。但不能仅凭客户端重放证明转发服务的具体限制或错误映射。

Claude [官方错误文档](https://platform.claude.com/docs/en/api/errors)将 Messages API
全请求上限标为 **32 MB**，超限正常应返回 `413 request_too_large`；文档中的 MB
与本文测量的 MiB 不应混用。调查中的 502 属于第三方域名的 origin 错误，
其实际阈值、是否重映射上游 413 / 400 或异常断开，需要服务端日志验证。

### 上游核查

EnsoCode `origin/main` 核查到 `7c08c6ea`（v0.2.3，pi 1.0.0）：仅额外保留最近一张
computer 截图，仍无整包守卫。pi v1.0.0 及最新 1.0.1 / HEAD `8369268` 的
[models 文档](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/models.md)
明确说明，`inputLimits.maxRequestBytes` / 图片数量限制仅描述元数据，尚不据此改写
或拒绝历史。当前执行的单图默认是 2000 × 2000、4.5 MiB base64。

同一会话的 11 次 read 失败均为 ENOENT；66 次 powershell 无图片块、最长结果
4325 字符，未发现大段原图 base64 回传，不能把“read 失败后终端读图”当作已证实根因。

## 修法

- `withRequestBodyBudget` 装饰 native provider 的 raw / simple 两个出口，覆盖 parent、
  child、摘要、缓存预热和手动继续；OAuth 保持原鉴权，Responses 保持 routing 修补。
- 遵从模型 `maxRequestBytes`；缺省沿用 pi 已知协议元数据：Anthropic 32 MiB、
  OpenAI 512 MiB、Google Generative AI 20 MiB；未知协议不凭空设限，也不注入无效的 fetch /
  payload hook 覆盖其 native transport 默认值。自定义模型继承
  同协议 catalog 的 `inputLimits`，坏字节上限明确拒绝。
- caller / routing 的 payload hook 之后计量完整 UTF-8 JSON，正文、system、工具定义、
  图片和作为普通文本的 base64 一并计量；fetch 出口再次检查 SDK 实际序列化的字节。
  不依靠 `before_provider_request` 扩展内抛错阻止请求（pi 会捕获扩展错误后继续）。
  检查 Request 时仅消费 clone，流式 init.body 分支用 tee 保留待发送流、信号与 header。
- 仅 Anthropic 且超预算时，从旧到新替换已看过的 tool_result 图片。已看过定义为：
  该结果之后有非 error / aborted 的 assistant 响应；最新工具批次全部保护，user 附件
  不作为候选。匹配规范化 tool id、原始 base64 和 MIME，id 碰撞或 hook 注入的新图不淘汰。
- 占位复用图片上下文提示，保留文件路径 / 工具来源与 cache_control，不拆消息和工具
  配对，不降低新图画质。under-budget 请求不改图，原始 context / jsonl 保持不变。
- 仍超预算时本地返回不含正文或密钥的 `request_too_large`，发送请求数为 0；pi 可走
  有限的 overflow compaction recovery，不再误当瞬态 502 重发。不将普通 502 一律清图。
- 本次不混入 retry 调度重构、图片数量限额、其他协议的自动媒体淘汰或新设置 / IPC。
- 底部状态栏 `requestBody` 展示最近一次**对话请求**的真实字节数 / 上限和测量阶段，
  不把 token 占用当字节、无数据不显示 0。事件复用 worker 通道，按会话 generation /
  seq 投影，权威快照可恢复；不持久化计量、不向 renderer 暴露正文或凭证。
- provider 按共享实例注册，遥测必须按会话和请求绑定。AsyncLocalStorage 传播到 SDK
  payload / fetch，但摘要、预热也可能继承异步作用域：仅靠 modelId / providerId 过滤
  会让被阻止的 33 MiB 主请求被后续 1.24 KiB 维护请求覆盖。用 pi sessionId 和原始
  AbortSignal 身份限定主请求；摘要有独立 routing id，预热复用 id 但有独立 signal。
  过滤只影响状态栏，维护请求仍执行完整字节预算，不改变 SDK 鉴权或请求选项。

重放两处失败前的 SDK payload，分别从 32.078 MiB 降为 30.267 MiB、从
32.720 MiB 降为 31.859 MiB，最新图片全部保留；原始上下文字符串和 jsonl SHA-256
未变，真实网络请求数为 0。重建未覆盖历史全部扩展选项，不能替代上游日志和真机验证。

## 回归防线

- `supervisor.requestBodyBudget.test.ts`：真实 Anthropic serializer + 假网络，长单轮 /
  无 user 尾段、最新多图批次、用户附件、失败 assistant、单图合格但总量超限、普通
  base64 文本、UTF-8 system、caller hook、raw/simple、默认值及 refresh / resolve。
- `requestBodyBudget.test.ts`：精确字节边界、坏配置、最终 string / Request 发送形态、
  stream:true、caller 异常、未知协议、装饰幂等。`supervisor.responsesRouting.test.ts`
  使用真实 OpenAI Responses serializer 验证另一协议的两个出口及原 routing / 鉴权契约。
- 新核心集成测试先红：1 个正常用例通过、13 个缺失预算用例失败，随后实现转绿。
- `requestBodyTelemetry.test.ts`：并发会话不串值、无图 UTF-8 超限、payload / wire、
  摘要和预热不覆盖被阻止的主请求（先红：预期 1 次遥测，实际 7 次；修复后通过）。
- Windows 全量检查仍有软链接 / 文件权限、POSIX 路径、RTK 等失败和 CRLF 格式问题，
  不能以局部回归和两厂商真机验收通过宣称全仓绿色。

### 2026-10-04 预算修复阶段验证

- 最终相关 5 个测试文件：81 个用例全部通过；`scripts/rtk.test.mjs` 的 5 个用例通过。
- `pnpm typecheck`、本次 13 个源码 / 测试文件的 Biome 检查、`git diff --check` 通过。
  `pnpm knowledge:check` 通过且无坏链接，已有文档章节警告不在本次修复范围。
- 最终全量 Vitest：6093 个用例，6002 通过 / 80 失败 / 11 跳过；上述相关用例在全量中
  仍为 81 通过 / 0 失败。全仓 Biome 有 389 个错误，包含未改文件的 CRLF 格式问题；
  未通过全仓门禁，不作为已完成发布或真机验收的依据。
- supervisor 所剩的 `apply_patch 完整只读预检失败时不会进入 approval` 在清理临时目录
  时报 EPERM；在未包含预算修复的 HEAD `61aefe08` 临时工作树中复现同一失败。
  其他全量失败未逐项做基线对照，不笼统断言都是原有失败。
- 未修改会话 jsonl、当前分支或 pi 依赖版本；核查用 upstream checkout、基线工作树、
  临时报告已清理。此阶段尚未完成两厂商真机验收，后续结果见下。

### 2026-10-04 状态栏与真机验收

- 隔离 userData、CDP 9341，开发版重启到最终 worker 代码后，用真实 Claude 和 OpenAI
  模型经 composer 发送；两者均自主调用两次 `read`，读出文本标记并识别红色 PNG：
  Claude 最后一请求 31,906 字节（31.16 KiB）/ 32 MiB；OpenAI 32,254 字节
  （31.50 KiB）/ 512 MiB。两个上限是客户端协议预算，不承诺第三方网关实际限额。
- 无图片、无工具调用，隔离项目的大型 AGENTS.md 使主请求达到 34,633,203 字节：
  仅发出 blocked payload 遥测，主请求在网络发送前拒绝，明细弹层显示
  `33.03 MiB / 32.00 MiB · 103% · 超限，未发送`，后续摘要未覆盖它。
  有限压缩恢复仍可能发出独立摘要请求，不能将主请求被阻止说成整个操作零网络。
  此大文件场景不用于证明 token 窗口仍有余量；该独立边界由 500 汉字 / 1000 字节
  fixture 单测覆盖，说明不能假设 token 控制会代替 HTTP 字节控制。
- CDP 验证底部段位与设置明细、会话切换后的 32 / 512 MiB 归属、只读权威重读后
  计量保持。设置版本 14 仅给原默认 / 完整布局加入新段位，自定义布局不擅自改写。
  手机状态栏扩展不在本次范围。
- 相关 15 个测试文件 368 通过 / 0 失败；全量 Vitest 6171 个用例：6079 通过、
  81 失败、11 跳过；RTK 脚本测试 5 通过。typecheck、28 个相关文件 Biome 和
  `git diff --check` 通过。全仓 lint 仍有 393 个错误，未取得全仓绿色，除已做基线
  对照的 EPERM 外，不把其余失败笼统认定为既有问题。
- 验收进程已正常关闭；隔离 userData（含复制的凭证）、fixture、截图、一次性脚本
  和临时报告均删除。真实持久化中无隔离项目 / 路径标记；用户生产会话同期正常
  更新，不回滚这些并发数据，也不将整份 settings.json 的 hash 相等作为验收条件。

### 2026-10-04 main / Pi 1.0 移植验证

- 从 main `7c08c6ea` 单独移植请求体修复，不合并 EnsoBot 历史；按主线锁文件安装
  Pi 1.0.0（pnpm 10 frozen install），未更改依赖版本、清单或锁文件。
- 保留主线模型累积注册与 OAuth catalog clone，再装饰 native provider；保留 computer
  默认关闭的 v14 迁移。请求体段位单独用 v15 迁移：v14 默认布局缺段位的用例先红，
  升级后通过；自定义布局和工具配置不改写。
- 主线相关 15 文件 383 用例、typecheck、全仓 lint、knowledge:check、diff 检查通过；
  RTK 脚本 5 用例通过。全量 Vitest 6426 用例：6316 通过、95 失败、15 跳过。
  失败涉及 Windows 权限 / 软链接 / 路径、RTK、平台差异等；未对全部失败做基线对照，
  不将其一律断定为旧问题，也不宣称全量绿色。
- 上面的跨两厂商真机记录来自先前 Pi 0.87.1 开发实例；本段是 Pi 1.0 主线的 SDK /
  单测兼容验证，不将此前的真机结论冒充一次新的主线真机运行。

## 相关代码

- `src/agent/imageContext.ts`：`pruneHistoricalImages` / `sanitizeContextMessages`
- `src/agent/requestBodyBudget.ts`：最终请求字节预算与已看工具图的安全占位
- `src/agent/requestBodyTelemetry.ts`：按会话 / 主请求隔离脱敏测量
- `src/shared/requestBodyUsage.ts`、`src/shared/types/agent.ts`：计量及事件信任边界
- `src/renderer/components/chat/StatsLine.tsx`、`requestBodySegment.ts`：底部明细
- `src/agent/supervisor.ts`：inline `image-context` 扩展、`case 'retry'`
- `src/agent/ensoCompact/budget.ts`：token 预算（不是 HTTP 请求体预算）
- pi-coding-agent：`core/session-manager.js`、`core/messages.js`、`core/sdk.js`、
  `utils/image-process.js`、`utils/image-resize-core.js`、`core/agent-session.js`
- pi-ai：`api/anthropic-messages.js` 的 image base64 映射与 `onPayload`
