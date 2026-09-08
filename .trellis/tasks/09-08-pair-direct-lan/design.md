# Design：配对直连（WebRTC DataChannel：LAN + STUN 打洞，中继回退）

## 1. 边界与架构

```
                 ┌──────── 中继 WS（常连，控制面 + 信令 + 回退数据面）────────┐
   host (main)   │                                                          │  guest (phone PWA / main)
   pairHost.ts ──┤  E2E sealFrame: host-info{caps} / direct-offer|answer|ice ├── client.ts / pairGuest.ts
                 └──────────────────────────────────────────────────────────┘
        ▲                                                                          ▲
        └──── WebRTC DataChannel（host 候选 = LAN，srflx 候选 = STUN 打洞；优先数据面）────┘
                       载荷 = 同一份 sealFrame 密文（双重加密，不引入新信任）
```

- **中继不改**：信令与能力声明都是 E2E 加密业务帧，relay 只见密文（room.ts 只转发）。
- **中继常连是控制面**：在线状态、解绑、信令永远走中继；直连只是业务帧的优先出口。回退 = 改写发送目标，不重连。
- **host 声明、guest 发起**：host 在既有 `host-info` 帧新增 `capabilities: ['direct-v1']`；guest 收到才发 offer。旧 PWA 忽略多余字段、旧桌面永不声明 → 三种新旧组合零噪音（旧桌面不会收到未知 PhoneToHost 而刷 `command rejected` warn）。
- 新增代码分三层，前两层可单测：
  1. `packages/pair/src/direct/`（三端共用纯逻辑）：信令帧类型、直连状态机 reducer、分片编解码、通道选择。
  2. `DirectPeer` 接口（可注入）：浏览器实现 `packages/phone/src/directPeer.ts`（`RTCPeerConnection`）；main 实现 `src/main/services/pairDirectPeer.ts`（选型见 §6）。
  3. 三端接线：`pairHost.ts` / `pairGuest.ts` / `client.ts` 的 send / handleFrame / status / revive 四个接缝。

## 2. 线协议扩展（`packages/pair/src/protocol.ts`）

```ts
// HostToPhone 新增/扩展
| { type: 'host-info'; hostname; appVersion;
    capabilities?: DirectCapability[];                 // 扩展：['direct-v1']
    iceServers?: { urls: string[] }[] }                // 扩展：STUN 列表，guest 跟随 host
| { type: 'direct-answer'; gen: number; sdp: string }
| { type: 'direct-ice'; gen: number; candidate: string; sdpMid: string | null }
// PhoneToHost 新增（同步加入 PHONE_COMMAND_TYPES 白名单）
| { type: 'direct-offer'; gen: number; sdp: string }
| { type: 'direct-ice'; gen: number; candidate: string; sdpMid: string | null }
| { type: 'direct-close'; gen: number }   // guest 主动放弃本代（超时/网络变化），host 释放 pc
```

- `gen`（generation）由 guest 递增，每次发起协商 +1；双方丢弃 `gen` 不等于当前代的任何信令，杜绝网络切换后迟到的 ICE 候选污染新一轮。
- host 侧仅当 `gen > 当前 gen` 才接受新 offer（同代重复 offer 忽略）。
- `direct-ice` 放行 `typ host`（含 mDNS `.local`）与 `typ srflx`，过滤 `typ relay`（不用 TURN）。ICE 自身按优先级先试 host–host 对，同内网自然落在 LAN 路径。

## 3. 直连状态机（`packages/pair/src/direct/directSession.ts`，纯 reducer）

状态：`idle → negotiating(gen) → connected(gen) → idle`，附 `cooldown`（退避等待再试）。

| 事件 | 来源 | 转移 / 动作 |
|---|---|---|
| `peer-capable` | guest 收到带 caps 的 host-info | idle → negotiating(gen+1)，动作 `create-offer`；negotiating/connected 下忽略（中继重连后 host 会重发 host-info，不能打断活着的直连） |
| `offer/answer/ice(gen)` | 信令帧 | gen 匹配才 apply；否则 drop |
| `dc-open` | DirectPeer | negotiating → connected；动作 `switch:direct`、`resync` |
| `dc-close` / `pc-failed` / `heartbeat-dead` | DirectPeer / heartbeat | connected|negotiating → cooldown(attempt++)；动作 `switch:relay`、`resync` |
| `negotiate-timeout`（15s） | 定时器 | negotiating → cooldown；动作 `send direct-close`。需等 STUN 往返 + 跨网 ICE 检查，比 LAN-only 长 |
| `network-change` | 既有 revive（本机网卡指纹变 / 手机 `online`） | 任意 → idle（销毁 pc，attempt=0）；动作 `switch:relay` |
| `peer-gone` | 中继 `revoked` / 本端解绑 / close() | 任意 → idle，销毁 pc |

**不触发拆直连的事件**：中继 ws 关闭 / 重连、`peer-left` / `host-offline`。直连的生死只由自身（pc 状态 + 心跳）与本机网络变化决定，否则 AC1（中继不可达时直连继续服务）不成立。对端真掉线时 pc `disconnected/failed` 秒级可见，心跳 ≤35s 兕底。
| `cooldown-elapsed` | 定时器 | cooldown → 若对端仍 capable 且在线 → negotiating(gen+1) |

- 退避：`backoffDelay(attempt)` 但上限抬到 5 分钟（新增 `directBackoffDelay`，纯函数）——打洞失败的对称 NAT 场景会持续失败，每 30s 一次 STUN gathering 对手机电量不友好。网络变化事件仍归零 attempt 立即重试。
- 中继 WS 重连成功后 host 会重发 `host-info`（既有 peer-joined → requestMeta 路径），天然触发 guest 重新发起——**网络变化后的重协商不需要额外机制**。
- `resync` 动作 = guest 侧按既有重连语义执行 `snapshot` + `subscribe(sinceIndex)`；切通道瞬间在旧通道丢失的帧由游标增量/全量 snapshot 修复（R4）。

### 3.1 接口契约（`packages/pair/src/direct/directSession.ts`，测试依据）

```ts
export type DirectRole = 'guest' | 'host';
export type DirectPhase = 'idle' | 'negotiating' | 'connected' | 'cooldown';
export interface DirectState {
  role: DirectRole;
  phase: DirectPhase;
  gen: number;        // 当前代，0 = 尚未协商过
  attempt: number;    // 连续失败次数，退避用
  capable: boolean;   // guest：已见到 host 声明能力；host：始终 false，不用
  peerOnline: boolean;
}
export type DirectEvent =
  | { type: 'peer-capable'; capable: boolean }  // guest：收到 host-info（有/无 caps）
  | { type: 'peer-online'; online: boolean }    // 中继控制帧 host-online/offline, peer-joined/left
  | { type: 'offer'; gen: number }              // host 收到 direct-offer
  | { type: 'answer'; gen: number }             // guest 收到 direct-answer
  | { type: 'ice'; gen: number }
  | { type: 'remote-close'; gen: number }       // host 收到 direct-close
  | { type: 'dc-open'; gen: number }
  | { type: 'dc-close'; gen: number }           // 含 pc failed / 心跳判死
  | { type: 'negotiate-timeout'; gen: number }
  | { type: 'cooldown-elapsed' }
  | { type: 'network-change' }
  | { type: 'peer-gone' };                      // revoked / 本端解绑 / close()
export type DirectAction =
  | { type: 'create-offer'; gen: number }       // guest：新建 peer，发 offer
  | { type: 'accept-offer'; gen: number }       // host：新建 peer，回 answer
  | { type: 'apply-answer'; gen: number }
  | { type: 'apply-ice'; gen: number }
  | { type: 'start-timeout'; gen: number }      // 15s 协商超时
  | { type: 'destroy-peer' }
  | { type: 'send-close'; gen: number }         // guest 通知 host 释放本代
  | { type: 'switch'; transport: 'direct' | 'relay' }
  | { type: 'resync' }                          // guest: snapshot+subscribe; host: bump meta epoch
  | { type: 'schedule-retry'; attempt: number }; // guest：调用方用 directBackoffDelay(attempt)
export function initialDirectState(role: DirectRole): DirectState;
export function reduceDirect(state: DirectState, event: DirectEvent): { state: DirectState; actions: DirectAction[] };
export function pickTransport(state: DirectState, dcOpen: boolean, wsOpen: boolean): 'direct' | 'relay' | null;
export function directBackoffDelay(attempt: number, random?: () => number): number; // 1s·2^attempt，上限 300_000，±30% 抖动
```

语义（guest）：
- `idle` 且 `capable && peerOnline` 成立的那一刻（由 peer-capable(true) 或 peer-online(true) 触发）→ `negotiating`，gen+1，actions `[create-offer, start-timeout]`。
- `negotiating`/`connected` 下的 peer-capable / peer-online(true) 只更新字段，不重协商。peer-capable(false)（host 降级）在任意态 → 如 phase≠idle：`[destroy-peer, (connected 时 switch relay, resync)]` → idle。
- `answer(gen==)` 仅 negotiating → `[apply-answer]`；`ice(gen==)` 在 negotiating/connected → `[apply-ice]`；gen 不等 → 无动作、状态不变。
- `dc-open(gen==)` 仅 negotiating → connected，attempt=0，`[switch direct, resync]`。
- `negotiate-timeout(gen==)` 仅 negotiating → cooldown，attempt+1，`[send-close, destroy-peer, schedule-retry]`。
- `dc-close(gen==)`：connected → cooldown，attempt+1，`[destroy-peer, switch relay, resync, schedule-retry]`；negotiating → cooldown，attempt+1，`[send-close, destroy-peer, schedule-retry]`。
- `cooldown-elapsed` 仅 cooldown → 若 `capable && peerOnline` → negotiating gen+1 `[create-offer, start-timeout]`；否则 idle（无动作）。
- `network-change`：attempt=0；phase≠idle 时 `[send-close(当前 gen), destroy-peer, (connected 时 switch relay, resync)]`；之后若 `capable && peerOnline` → 立即 negotiating gen+1 `[create-offer, start-timeout]`，否则 idle。
- `peer-gone` → idle，capable=false，peerOnline=false，attempt=0，`[destroy-peer, (connected 时 switch relay)]`。
- `peer-online(false)` 只更新字段（中继侧离线不拆直连）。
- stale gen 的 dc-open/dc-close/negotiate-timeout 一律忽略。

语义（host）：
- `offer(gen)`：`gen > state.gen` 才接受；若当前 phase≠idle 先 `[destroy-peer, (connected 时 switch relay, resync)]`，再 negotiating(gen) `[accept-offer, start-timeout]`。`gen <= state.gen` → 无动作。
- `ice(gen==)` 在 negotiating/connected → `[apply-ice]`。
- `dc-open(gen==)` 仅 negotiating → connected `[switch direct, resync]`。
- `dc-close(gen==)` / `negotiate-timeout(gen==)` / `remote-close(gen==)` → idle，`[destroy-peer, (connected 时 switch relay, resync)]`。host 不重试，由 guest 驱动。
- `network-change` / `peer-gone` → idle，`[destroy-peer, (connected 时 switch relay, resync)]`；peer-gone 额外 peerOnline=false。gen 保留（不归零，防旧 offer 重放）。
- peer-capable / answer / cooldown-elapsed / schedule 对 host 是 no-op。

`pickTransport`：`phase==='connected' && dcOpen` → 'direct'；否则 `wsOpen` → 'relay'；否则 null。

## 4. 数据面

- **载荷**：`sealFrame(contentKey, msg)` 的字节原样上 DataChannel；接收端进同一个 `handleFrame`。加解密、白名单、投影零改动。
- **分片**（`packages/pair/src/direct/chunk.ts`）：DataChannel `ordered: true` 可靠有序，但单消息跨浏览器安全上限约 64KB～256KB，而中继允许 1MB。发送端按 16KB 切片，1 字节头 `0x00=续 / 0x01=末`，接收端顺序拼接；有序可靠通道下不需要 msgId。上限沿用 1MB（`MAX_FRAME_BYTES`）。
- **心跳**：`DirectPeer` 暴露 WebSocket 风格外观（`send/readyState/addEventListener('message')`），直接复用 `attachHeartbeat`；对端收到文本 `"ping"` 回 `"pong"`（中继那侧是 DO 自动回，这里由 peer 自己回）。此外 `pc.connectionState ∈ {disconnected, failed, closed}` 立即触发 `pc-failed`，比心跳更快。
- **发送选择**（`pickTransport`）：`direct` 当且仅当 `connected && dc.readyState === 'open'`；否则 `relay`（沿用 `ws.readyState === 1` 判定）。两端各自独立选择，不需要协商「谁切了」——接收端两条通道都收。
- **在线态**：host 的 `phoneOnline` 既有逻辑「收到加密帧即在线」对直连收到的帧同样生效；中继不可达但直连活着时，直连心跳不计入在线判定（只看业务帧），避免与中继 `peer-left` 相互覆盖——接受此场景下在线标签可能短暂不准。

## 5. DirectPeer 接口（依赖注入，vitest 不碰真 WebRTC）

```ts
interface DirectPeer {
  createOffer(): Promise<string>;                 // guest；内部 createDataChannel('pair', {ordered:true})
  acceptOffer(sdp: string): Promise<string>;      // host；返回 answer sdp，ondatachannel 接收
  acceptAnswer(sdp: string): Promise<void>;
  addIceCandidate(c: { candidate: string; sdpMid: string | null }): Promise<void>;
  onIceCandidate(cb): void;                        // 只吐 typ host
  onOpen / onMessage(bytes) / onClose / onFailed
  send(bytes: Uint8Array): void;
  close(): void;
}
type DirectPeerFactory = () => DirectPeer;         // 注入到 pairHost/pairGuest/PairClient
```

ICE 配置：`iceServers` 由工厂参数传入（host 自用常量，guest 用 host-info 下发值），`iceTransportPolicy: 'all'`；候选过滤在 `onIceCandidate` 层做（`isAllowedCandidate`：host | srflx，拒 relay）。`DirectPeerFactory = (iceServers) => DirectPeer | null`。

STUN 列表（main 侧常量 `PAIR_STUN_SERVERS`）：`stun:stun.cloudflare.com:3478`、`stun:stun.miwifi.com:3478`、`stun:stun.chat.bilibili.com:3478`。三者并行查询，失效的只是不回应；trickle ICE 下不阻塞已到候选。

## 6. Electron main 侧 WebRTC 实现选型

结论见 `research/webrtc-electron-main.md`：**首选 `node-datachannel`（libdatachannel N-API 8 绑定），备选 `werift`（纯 TS），不采用隐藏 BrowserWindow。**

- `node-datachannel@0.33`：optional platform packages 提供 mac x64/arm64、win x64/arm64、linux glibc/musl 预编译；N-API 8 不绑 Electron ABI，通常无需 electron-rebuild；无 install 脚本，不必加 `onlyBuiltDependencies`。libdatachannel 明确支持 Chromium/Firefox/Safari 互通与 mDNS 候选。
- 打包要点：依赖保持 external（不让 electron-vite 内联平台 `require`）；显式验证 `.node` 进入 asarUnpack；**每个目标平台用安装后产物**做 loopback DataChannel smoke test，不只测 dev。
- adapter lazy import；加载失败只记一次日志并返回 `null` → host 不声明 `direct-v1`，main 启动不受影响。
- `werift` 采用条件：任一目标平台 `node-datachannel` 打包后不稳定；仅替换 adapter，不动状态机/协议。一期不同时打包两套。
- 未来若需隔离原生崩溃，可移入 `utilityProcess`（它没有 WebRTC Web API，只是 Node 子进程）。

### 落地门槛（进入步骤 5 接线之前）

先做独立 adapter spike：打包后的 Electron host ↔ Chrome/Android、Safari/iPhone、Electron guest，验证 offer/answer、trickle ICE、`.local` 候选、16KB 二进制、断网 close。任一不过 → 换 `werift` 重测。

## 7. 状态可观测（R8 / D6）

- `src/shared/types/pair.ts PairStatusDevice` 与 `src/shared/types/nodes.ts RemoteNodeStatus` 新增 `transport?: 'relay' | 'direct'`（可选字段，旧 renderer 不受影响）。
- `getPairStatus()` / guest 对应函数从直连状态机读出；状态机每次 `switch:*` 动作调 `notifyStatus()`。
- renderer：`DevicesSettings.tsx` 设备行「在线」旁与节点行各加一个小标签；phone：`ClientEvents` 新增可选 `onTransport?(t)`，`App.tsx` 状态条附带一词。`ConnState` 枚举不改。

## 8. 安全

- SDP（含 DTLS 指纹）经 E2E 中继信道交换，指纹真实性由 contentKey 保证 → DataChannel 不可被 LAN 内第三方中间人。
- DataChannel 上仍是 sealFrame 密文：即便 DTLS 被绕过也无明文。
- STUN 服务商仅见公网 IP:port，不见内容、不见对端身份；不用 TURN 所以没有任何第三方能观察到业务流量（D5）。
- mDNS 候选：浏览器出于隐私把 host 候选 IP 替换为 `.local` 名；**候选过滤不得丢弃 `.local` 或非 IPv4 字面量的 host 候选**。libdatachannel 自带 mDNS 解析；即便解析失败，浏览器向 Electron 真实 LAN IP 发起的连通性检查也能形成 **peer-reflexive** 候选完成配对。
- 同 SSID 不等于可直连：访客 Wi‑Fi / AP client isolation / VLAN / VPN / 系统防火墙、以及 iOS「本地网络」权限被拒，都会让 LAN ICE 失败——这些都是正常回退，不提示错误、按退避重试。
- iOS 后台/锁屏不保证 timer 与连接存活：回前台走既有 `nudge('visibility')` → 直连以 pc 状态 + 心跳判死，死则 `switch:relay` 再重协商。
- 发送需看 `bufferedAmount`，`send()` 返回 false 时该帧改走中继，不无界排队。

## 9. 兼容与回滚

- 旧桌面 × 新手机：host-info 无 caps → guest 永远 idle。旧 PWA × 新桌面：忽略 caps 字段，永不发 offer → host 永远 idle。
- 中继 0 diff。功能整体可通过不下发 `capabilities` 一键关闭（保留一个 main 侧常量作为紧急开关，不做用户设置）。
- 若 main 侧 WebRTC 库在某平台加载失败：`DirectPeerFactory` 返回 null → host 不声明 caps，退化为现状。

## 10. 权衡记录

- 为什么不让 host 发 offer：手机浏览器是 https PWA，只有它能稳定拿到 Chromium/WebKit 的 RTCPeerConnection；且「host 声明、guest 发起」让旧桌面零噪音。
- 为什么不在直连成功后断开中继：中继承载在线态与解绑语义，断开需在直连上重造这些；hibernation 下常连几乎免费。
- 为什么用分片而不是「大帧走中继」：跨通道会打乱 agent-event 顺序。
- 为什么不配 TURN：中继 WS 已经是带 E2E 的中转路径，再加 TURN 是重复建设。
- 为什么 STUN 列表由 host 下发：PWA 经 SW 缓存更新慢，配置收敛到桌面端一处；日后做用户可配置也不动 PWA。
