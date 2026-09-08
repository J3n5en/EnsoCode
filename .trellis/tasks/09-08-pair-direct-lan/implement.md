# Implement：配对直连

每步独立可提交（小步提交纪律）；纯逻辑步骤先红后绿（TDD）。步骤 1–3 是纯逻辑，推荐 coworker tester 角色分离。

## 0. 前置

- [x] 读 `design.md` §6 + `research/webrtc-electron-main.md`。`pnpm add node-datachannel@0.33.2`（无 install 脚本）；electron-vite 默认 external（`out/main/index.js` 保留 `import("node-datachannel")`）；electron-builder 无需改配置：`@node-datachannel/darwin-arm64/node_datachannel.node` 自动落到 `app.asar.unpacked`。
- [x] **Spike gate**（darwin-arm64）：`electron-builder --mac --dir` 产物里用 `ELECTRON_RUN_AS_NODE=1 EnsoCode.app/Contents/MacOS/EnsoCode` 从 `app.asar` require `node-datachannel` → 加载成功，本机 loopback DataChannel 20000B 二进制往返 OK。其他平台同 `@mariozechner/clipboard` 模式（各 OS 的 CI 各自安装自己的 optional 二进制）。iPhone Safari 真机验证留到步骤 8 手工项（dev worker 已部署）。
- [x] `pnpm typecheck && pnpm test` 基线绿。

## 1. 协议扩展（`packages/pair/src/protocol.ts`）— 纯类型 + 白名单

- [ ] `HostToPhone`：`host-info` 加 `capabilities?: DirectCapability[]` 与 `iceServers?: { urls: string[] }[]`；新增 `direct-answer` / `direct-ice`。
- [ ] `PhoneToHost`：新增 `direct-offer` / `direct-ice` / `direct-close`；加入 `PHONE_COMMAND_TYPES`。
- [ ] 红：`packages/pair/src/protocol.test.ts`（或现有 `pairPolicy.test.ts`）断言 `isPhoneCommand({type:'direct-offer',...})` 为真、main 侧 `parsePhoneCommand` 接受并保留字段。
- [ ] 若 `parsePhoneCommand` 有逐字段收窄，为三种新帧补结构校验（`gen` 为非负整数、`sdp`/`candidate` 为字符串、长度上限如 16KB 防滥用）。
- commit: `feat(pair): 协议新增直连信令帧与 host 能力声明`

## 2. 分片编解码（`packages/pair/src/direct/chunk.ts`）

- [ ] 红：`chunk.test.ts` — 空帧 / <16KB 单片 / 恰好 16KB 边界 / 1MB 多片往返一致；接收端收到非法头字节丢弃并重置；超过 `MAX_FRAME_BYTES` 累计时重置。
- [ ] 绿：`encodeChunks(bytes): Uint8Array[]`、`createReassembler(): { push(chunk): Uint8Array | null }`。
- commit: `feat(pair): DataChannel 16KB 分片编解码`

## 3. 直连状态机（`packages/pair/src/direct/directSession.ts`）

- [ ] 红：`directBackoffDelay(attempt)` 上限 5 分钟。
- [ ] 红：`directSession.test.ts` 覆盖 design §3 表格每一行，重点：
  - gen 不匹配的 offer/answer/ice 被丢弃；
  - `dc-open` 产出 `switch:direct` + `resync`；`dc-close` 产出 `switch:relay` + `resync` 且 attempt+1；
  - `network-change` 任意态回 idle 且 attempt 归零；`peer-capable` 在 connected/negotiating 下为 no-op；
  - `cooldown-elapsed` 仅在 capable && peerOnline 时重新协商；
  - host 侧只接受 gen 递增的 offer。
- [ ] 绿：`reduceDirect(state, event): { state, actions }` 纯函数；`pickTransport(state, dcOpen, wsOpen)`。
- commit: `feat(pair): 直连协商状态机与通道选择`

## 4. DirectPeer 实现（不单测，接口按 design §5）

- [ ] `packages/pair/src/direct/peer.ts`：`DirectPeer` / `DirectPeerFactory(iceServers)` 类型 + `isAllowedCandidate(candidate: string)` 纯函数（含单测：`typ host` ✓ / `typ srflx` ✓ / `typ relay` ✗ / mDNS `.local` ✓ / IPv6 ✓）。
- [ ] `packages/phone/src/directPeer.ts`：`RTCPeerConnection({ iceServers })`，`createDataChannel('pair', { ordered: true })`，`binaryType = 'arraybuffer'`，文本 `"ping"` → 回 `"pong"`；暴露 WebSocket 风格外观供 `attachHeartbeat`。
- [ ] `src/main/services/pairDirectPeer.ts`：按选定库实现同一接口；库加载失败（`try import`）时工厂返回 `null`。
- commit: `feat(pair): 浏览器与 main 侧 DirectPeer 实现`

## 5. host 接线（`src/main/services/pairHost.ts`）

- [ ] `Connection` 增 `direct: DirectState`、`peer: DirectPeer | null`、`directHeartbeat`。
- [ ] `sendMeta` 的 `hostInfo` 带 `capabilities: directFactory ? ['direct-v1'] : []` 与 `iceServers: PAIR_STUN_SERVERS`（常量放 `src/main/services/pairDirectConfig.ts`；保留 `PAIR_DIRECT_ENABLED` 作紧急开关）。
- [ ] `handleFrame` switch 新增 `direct-offer` / `direct-ice` / `direct-close` → 喂状态机；`peer.onMessage` → 拆片 → 同一 `handleFrame`。
- [ ] `send()`：`pickTransport` 为 direct 时走 `encodeChunks` + `peer.send`，否则原 ws 路径。
- [ ] `reviveAll('network-change')` → 状态机 `network-change`；`revoked` / `forgetDevice` → `peer-gone`。**ws close / peer-left 不碰直连**（AC1）。
- [ ] `getPairStatus()` 输出 `transport`；`switch:*` 动作后 `notifyStatus()`。
- [ ] `src/shared/types/pair.ts PairStatusDevice.transport?`。
- commit: `feat(pair): host 支持直连协商与回退`

## 6. 手机接线（`packages/phone/src/client.ts` + UI）

- [ ] `PairClient` 构造注入 `directFactory`（默认 `createBrowserDirectPeer`，`typeof RTCPeerConnection === 'undefined'` 时为 null）。
- [ ] `handleFrame`：`host-info` 有 caps → `peer-capable`（携带 `iceServers` 交给工厂）；`direct-answer` / `direct-ice` → 状态机；`peer.onMessage` → 拆片 → `handleFrame`。
- [ ] `send()`：按 `pickTransport` 出口；`switch:*` 后执行 `resync`（`snapshot` + `subscribe(subscribedId)`）。
- [ ] `nudge('online')` → 状态机 `network-change`；`revoked` / `close()` → `peer-gone`。**ws close / host-offline 不碰直连**（AC1）。
- [ ] `ClientEvents.onTransport?(t)`；`App.tsx` 状态条附「直连/中继」。
- commit: `feat(phone): 手机端直连与状态指示`

## 7. 桌面 guest 接线（`src/main/services/pairGuest.ts`）

- [ ] 与步骤 6 同构，DirectPeer 用 main 实现；`RemoteNodeStatus.transport?`。
- [ ] `DevicesSettings.tsx` 设备行 + 节点行标签。
- commit: `feat(pair): 桌面节点直连与设置页通道标签`

## 8. 验证

```bash
pnpm typecheck && pnpm test && pnpm exec biome check .
git diff --stat -- packages/relay      # 必须为空（AC5）
```

- [x] 自动门禁全绿；`packages/relay/src` 零 diff（仅新增 `wrangler.dev.jsonc` + `release:dev` 脚本）。
- [x] 审查修正（eb687876）：中继 ws 断开时直连存活则保留 phoneOnline（否则 forwardAgentEvent 会停发，AC1 不成立）；多片帧半途失败作废本代通道；guest resync 重发最后一次 subscribe；手机 1008 拆直连；建不出 peer 时 host 不空等 15s。
- [ ] 手工（需真机）：桌面「设置 → 设备 → 中继地址」填 `https://enso-pair-relay-dev.j3.workers.dev`，扫码后按下方场景验收。

### 打洞诊断（c3427730）

每代协商结束桌面主进程日志（手机在 Safari 控制台）会打一行：

```
[pair] iPhone: direct open gen=1 local[host×2 srflx×1 v6 nat=cone] remote[srflx×2 v6 nat=symmetric]
[pair] direct open via host/v6↔prflx/v6
[pair] iPhone: direct failed gen=3 local[host×1 srflx×2 nat=symmetric] remote[srflx×2 nat=symmetric]
```

读法：
- `nat=symmetric` 两侧都出现 → 纯 STUN 打不通是预期，只能靠 v6 或加 TURN/UPnP；一侧 `cone` 就应该能通。
- `nat=none` 且无 srflx → UDP 被封或 STUN 不可达（代理 fake-ip 环境下也会这样）。
- 有 `v6` 但选中候选对是 v4 → 查路由器 v6 防火墙 / 手机是否拿到 v6 srflx（只有 `stun.cloudflare.com` 有 AAAA，另两台只有 v4）。
- 本机开发环境无公网 v6，**libjuice 的 v6 host 候选收集未实测**，需在双栈网络下确认 `local[... v6 ...]`。

手工（AC1/AC2/AC7/AC8）：同一 Wi‑Fi 桌面 + 手机 → 标签变「直连」；`/etc/hosts` 屏蔽 relay 域名后手机仍能收流式输出；手机切蜂窝 → 数秒内「中继」，若 NAT 可打洞 15s 内重回「直连」（日志打印 selected candidate pair 确认为 srflx/prflx）；屏蔽全部 STUN 域名后同 Wi‑Fi 仍能 LAN 直连；回 Wi‑Fi → 自动「直连」。
兼容（AC3/AC4）：旧版桌面 build 配新 PWA、新桌面配 SW 缓存的旧 PWA，各观察 5 分钟无 warn 刷屏、行为同现状。

## 风险文件 / 回滚点

- `pairHost.ts` `send()` / `handleFrame()` 是全部手机流量的咽喉：每步改完立即跑手工回归（发一条 prompt、收流式）。
- 任一步失败可单独 `git revert` 该 commit；步骤 1–4 不影响运行时行为，步骤 5 之前随时可停。
- 原生模块若打包失败：`pairDirectPeer.ts` 工厂返回 null 即退化为现状，不阻塞发版。
