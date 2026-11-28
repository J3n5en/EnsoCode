# 原生 QUIC / HTTP/3 传输层架构与分阶段实施计划

**日期**：2026-11-28  
**状态**：架构设计完成，待原生壳（Capacitor / 桌面端）落地时按阶段实施  
**前置基础**：PR #660（frame-v2 二进制加密帧、线协议瘦身、rpc-batch）与 Wave 3（中继密文热缓冲、1-RTT rpc-hello prefetch、乐观水合、双 WebRTC DataChannel）

---

## 1. 为什么在 PWA/WebSocket 之外还需要原生 QUIC

前三波优化已经把基于浏览器 WebSocket + WebRTC 的路径压榨到协议物理极限：
- 二进制加密帧 v2 + 智能压缩消除了 JSON/Base64 膨胀；
- `rpc-batch` + `rpc-hello.prefetch` 将冷启动往返压到 1-RTT；
- 中继密文热缓冲 + 乐观水合掩盖了绝大多数短切后台的等待；
- WebRTC `ctrl + bulk` 双 DataChannel 隔离了局域网/可打洞场景的队头阻塞。

但在 **iOS 蜂窝网络切换、跨运营商对称 NAT（WebRTC 不可达）与长时间后台切回** 三类真实高频场景下，TCP + TLS + WebSocket 仍有三项浏览器层无法消除的硬限制：

1. **连接迁移（Connection Migration）缺失**：Wi-Fi ↔ 5G 切换或 NAT 重映射导致四元组变化时，TCP 必须经历死链检测 → DNS/TCP/TLS/WS 4 次握手 → 房间重入；QUIC 基于 Connection ID，无需重连即可原地迁流。
2. **0-RTT 建连不可用**：iOS PWA 后台超过 15~30s 冻结后，TCP + TLS 1.3 + WS Upgrade 至少消耗 2~3 RTT；QUIC + TLS 1.3 Session Ticket 支持 0-RTT 直接在首包捎带 `pairId/token` 与首条密文控制帧（如 `rpc-hello` + `prefetch`）。
3. **TCP 层队头阻塞**：即使应用层把 `rpc-result` 与 `rpc-event` 拆开，同一条 WebSocket 下单个 TCP 丢包仍会卡住整条流；QUIC 原生多独立 Stream（ctrl stream / event stream / bulk stream / asset stream）在传输层彻底消除跨流队头阻塞。

> 注：Web 浏览器侧长期演进可选 **WebTransport（HTTP/3）**，但 iOS Safari/WKWebView 目前尚未稳定支持 WebTransport，因此面向 iOS 端最优解是结合 `docs/plans/phone-native-app-plan.md` 中的原生壳（Capacitor + 原生 Swift/Go/Rust 插件）引入原生 QUIC 通道，同时保留 WebSocket 作为全平台兜底。

---

## 2. 目标架构与分层设计

### 2.1 端到端加密不变量（绝不妥协）

- QUIC 仅替代 **传输与复用层**（取代 TLS+TCP+WebSocket 帧转发）；
- 所有业务载荷继续复用 `@enso/pair` 的 **E2E frame-v2 密文帧**（`contentKey` + AES-256-GCM + `FrameReplay` 防重放）；
- 中继节点（`packages/relay-go`）保持 **零明文可见性**：只看到配对鉴权元数据、Stream 类型（`ctrl` / `bulk`）与不透明密文字节块。

### 2.2 传输抽象接口（统一封装 WS / WebRTC / QUIC）

在 `packages/pair/src/transport.ts`（新增）统一抽象底层连接接口，让 `PairClient` 与 `pairHost` 不再直接耦合 `WebSocket` API：

```ts
export type TransportLane = 'ctrl' | 'bulk';

export interface RelayControlMessage {
  type: 'host-online' | 'host-offline' | 'peer-joined' | 'peer-left' | 'revoked';
  relayEpoch?: string;
  relaySeq?: number;
  replayedFrom?: number;
}

export interface RelayTransport {
  readonly kind: 'ws' | 'quic';
  connect(params: {
    url: string;
    pairId: string;
    role: 'host' | 'guest';
    token: string;
    relayEpoch?: string;
    sinceRelaySeq?: number;
  }): Promise<void>;
  /** 按优先级车道发送密文帧：ctrl 走独立高优流，bulk 走可背压大流 */
  send(frame: Uint8Array, lane: TransportLane): boolean;
  onControl(cb: (msg: RelayControlMessage) => void): () => void;
  onFrame(cb: (frame: Uint8Array, lane: TransportLane) => void): () => void;
  onClose(cb: (code: number | null, reason: string) => void): () => void;
  probe(timeoutMs: number): Promise<number | null>;
  close(): void;
}
```

### 2.3 中继服务端（`packages/relay-go`）QUIC 接入设计

`packages/relay-go` 已是 Go 编写，接入 `github.com/quic-go/quic-go` 成本极低且可与现有 HTTP/WS 同进程共享 `hub` 与 `store`：

| 组件 | 设计要点 |
| --- | --- |
| 监听端口 | 默认复用 `UDP :443`（与现有 TCP `:443` TLS 证书完全共用，支持 ALPN `enso-pair/1` + 可选 `h3` WebTransport）；环境变量 `RELAY_QUIC_ADDR` 控制开关与地址 |
| 认证与 0-RTT 边界 | 首条控制流（Stream 0）携带 JSON 握手帧 `{ pairId, role, token, relayEpoch, sinceRelaySeq }`；**0-RTT Early Data 仅允许幂等只读续传/鉴权**，防重放仍由端到端 `FrameReplay` 保证 |
| 多流映射 | 每个连接维护 3 类长流：<br>• Stream 0（双向）：明文控制信令（`host-online` / `peer-joined` / `revoked` / `ping/pong`）<br>• Stream 1（双向，`ctrl`）：小控制帧与 RPC（`rpc-hello` / `rpc-result` / `rpc-event` / `rpc-prefetch` / `rpc-batch`）<br>• Stream 2（双向，`bulk`）：大包分片（`part` / `bpart` / `gzip` / `asset`），独立流控与背压 |
| `hub.go` 复用 | 将 `peer` 的发送抽象成 `sendControl(json)` 与 `sendFrame(lane, bytes)`；WS peer 将两条 lane 合并写进单连接，QUIC peer 写进各自 Stream；现有 `hotBuf`（密文热缓冲）按 `relaySeq` 统一工作，QUIC/WS 混合对端（如桌面走 QUIC、浏览器走 WS）完全互通 |
| 帧封装 | Stream 1/2 上使用 4 字节大端长度前缀（`uint32`）+ E2E 密文帧，最大帧上限维持 `1 MiB` |

### 2.4 客户端与桌面端接入设计

1. **Electron 桌面端（`src/main/services/pairHost.ts`）**：
   - 方案 A（推荐）：随桌面打包轻量 Go/Rust sidecar 或 N-API 原生库（复用 `quic-go` / `quinn`），暴露本机 IPC/N-API 给 `pairHost.ts` 实现 `QuicRelayTransport`；
   - 方案 B（过渡）：Node.js 原生 `node:quic` 稳定后直接切换，接口层 `RelayTransport` 零改动；
   - 启动时与现有 WS 并行探测（Happy Eyeballs 策略：优先尝试 UDP QUIC，250ms 未建连自动回落 WSS，运营商封锁 UDP 时无感降级）。
2. **iOS / Android 原生壳（Capacitor 插件）**：
   - iOS 使用 Apple 原生 **Network.framework（`NWProtocolQUIC` / `NWConnectionGroup`）**，零第三方 C/Rust 体积膨胀，天然支持 iOS 路径迁移（Wi-Fi ↔ 蜂窝）与低功耗后台恢复；
   - Android 使用 **Cronet / OkHttp-QUIC** 或 Rust `quinn` JNI 插件；
   - Capacitor 插件通过原生二进制桥把 `RelayTransport` 注入 WebView（`window.__ensoNativeTransport`），`packages/phone` 内 `PairClient` 无感知切换。
3. **浏览器 PWA（Safari / Chrome）**：
   - 保持 WSS + WebRTC 双 DataChannel；
   - Chrome/Edge/Desktop 浏览器后续可按能力探测启用 **WebTransport（HTTP/3）**，直连 `relay-go` 同一 UDP `:443` 的 `webtransport-go` 入口，与原生 QUIC 共用 `hub` 与热缓冲。

---

## 3. 分阶段实施路线图

| 阶段 | 目标 | 必改模块 | 验收指标 |
| --- | --- | --- | --- |
| **Phase 0（前置解耦，1~2 天）** | 抽出 `RelayTransport` 接口，把 `PairClient` 与 `pairHost` 的 WS 收发收口到 `WsRelayTransport` | `packages/pair/src/transport.ts`、`packages/phone/src/client.ts`、`src/main/services/pairHost.ts` | 现有 100% 单测与真机行为零回归 |
| **Phase 1（中继 QUIC 服务端，3~4 天）** | `packages/relay-go` 接入 `quic-go`，支持 `enso-pair/1` ALPN、`ctrl/bulk` 双流与既有 `hotBuf` 互通 | `packages/relay-go/quic.go`、`hub.go`、`main.go`、`Dockerfile` | `go test -race ./...` 全绿；QUIC host ↔ WS guest 与 QUIC ↔ QUIC 互通通过 |
| **Phase 2（桌面端 QUIC + Happy Eyeballs，4~5 天）** | 桌面端接入 QUIC transport，实现 250ms Happy Eyeballs 回落 WSS，验证弱网/丢包下 `ctrl` 不被 `bulk` 阻塞 | `src/main/services/pairHost.ts`、原生 QUIC 桥接包 | 5% 随机丢包环境下，并发 500KB 快照期间小 RPC P95 延迟 < 120ms |
| **Phase 3（iOS 原生壳 `NWProtocolQUIC`，5~7 天）** | 在 Capacitor iOS 壳落地 `NWProtocolQUIC` 插件，打通 0-RTT 与 Wi-Fi/5G 连接迁移 | `packages/phone` Capacitor 插件、`docs/plans/phone-native-app-plan.md` Phase 1/2 | iOS 切 Wi-Fi↔5G 零断连、30s 后台切回首帧交互 < 300ms |
| **Phase 4（WebTransport 浏览器增强，可选，2~3 天）** | `relay-go` 挂载 `webtransport-go`，Chrome/Edge 桌面浏览器无插件直享 HTTP/3 多流 | `packages/relay-go/webtransport.go`、`packages/phone/src/wtTransport.ts` | Chrome 浏览器自动协商 WebTransport，Safari 自动降级 WSS |

---

## 4. 风险与明确不做

### 风险与缓解
- **企业网 / 部分移动网关封锁 UDP 443**：必须保留 Happy Eyeballs（250ms 自动回落 WSS）与手动「仅使用 WebSocket」诊断开关。
- **0-RTT 重放风险**：中继层禁止在 0-RTT 数据里执行任何状态变更操作（如 `revoke`）；端到端防重放继续以 `FrameReplay`（8 字节前缀 + 4 字节计数窗口）为准。
- **证书管理**：`relay-go` 启用 QUIC 需要有效 TLS 证书（不可经普通 L7 HTTP 反代卸载 QUIC，需 UDP 443 直达或支持 HTTP/3 透传的边缘网关）。

### 明确不做
- 不改变 E2E 密钥体系与中继零明文原则；
- 不放弃纯浏览器 PWA 对 WSS 的完整兼容；
- 不在中继侧引入状态持久化数据库（热缓冲继续纯内存、有界上限）。
