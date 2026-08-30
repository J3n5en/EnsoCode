# Phone PWA → 原生 App 计划（Capacitor）

**日期**：2026-02-27
**状态**：计划阶段，未落地
**范围**：`packages/phone`（配对手机端 PWA）打包为 iOS / Android 原生 app 并上架

---

## 0. 背景与决策

### 现状

- `packages/phone` 是 Vite + React 19 + Tailwind 4 的 PWA，通过 `@enso/pair` 的 E2E 加密帧走 relay WebSocket 与桌面端配对（`client.ts` 的 `PairClient`，游标增量续传）
- 配对扫码：`getUserMedia` + jsqr（`qr.ts`）
- 推送：Web Push + VAPID + `sw.js`，由桌面端 `src/main/services/pushNotifier.ts` 直发
- 复用桌面 renderer 组件，宿主依赖用 `src/stubs/` 替换（vite alias，桌面源码零改动）

### 技术选型结论

**Capacitor**，不用 RN / Flutter。理由：

1. 性能无压力、设计不变 → 原生渲染的收益感知不到，重写 UI 是纯沉没成本
2. Capacitor 复用 100% 现有 web 代码，后续 web 更新即 app 更新
3. RN 只在「移动端 UI 为原生重新设计」时才值得，当前不满足该前提

### iOS 审核策略结论

- Capacitor 本身不是拒审理由（4.2 拒的是「repackaged website」，靠原生质感细节 + 原生能力对冲）
- 本 app 是 companion（需配对桌面端才可用），审核核心风险是 **2.1 App Completeness**：审核员没有桌面端，走不通配对流程
- 对策：**内置 Demo 模式**（传输层 mock，固定脚本回放，UI 代码零改动）+ Review notes 说明架构 + 演示视频。Demo 界面带 "Demo" 标识，主动向审核员说明使用模拟数据，规避 2.3.1 误导条款

---

## 1. 关键前置决策：推送架构

iOS 的 Capacitor WKWebView **没有 Service Worker push**，现有 `push.ts` 整条链路在 app 内失效。必须先拍板：

| 选项 | 做法 | 代价 | 结论 |
|---|---|---|---|
| A. relay 代发 APNs/FCM | 手机端注册原生 token 上报 relay；桌面通知经 relay 转 APNs/FCM | relay 持有 APNs .p8 密钥，新增服务端推送网关，约 3~5 天 | ✅ 推荐 |
| B. 桌面直发 APNs | .p8 密钥打进桌面客户端 | 密钥泄露风险 | ❌ 不可取 |
| C. v1 不带推送 | app 前台靠 WebSocket 实时 | 0 天，但削弱 app 价值 | 备选降级 |

以下按选项 A 估算。E2E 约束：经 relay 的推送**只推「有新消息」信令，不推内容**，内容回 app 内解密拉取。

---

## 2. 分阶段计划

### Phase 1：Capacitor 壳跑通（2~3 天）

1. `packages/phone` 接入 `@capacitor/core` + iOS/Android 平台，`webDir` 指向 vite build 产物
2. 环境分叉收敛到一处 `isNativeApp()`（`Capacitor.isNativePlatform()`），与现有 `isStandalone()` 并列
3. WebView 差异处理：
   - QR 扫码：首日验证 jsqr + `getUserMedia` 在 iOS WKWebView 的可用性；不行换 `@capacitor-mlkit/barcode-scanning`（+0.5 天）
   - `sw.js` 注册在 native 环境跳过（`push.ts` 已有能力探测，加分支）
   - relay WebSocket 走 wss，ATS 无需特殊配置
4. 双平台真机跑通配对 + 会话收发

**产出**：真机上功能等同 PWA 的 app。

### Phase 2：原生质感（3~4 天，依赖 Phase 1）

过审刚需（4.2 对冲）+ 体验分水岭：

- 安全区 `env(safe-area-inset-*)`：ChatScreen 底部输入区、SessionDrawer 重点检查
- `@capacitor/keyboard`：输入框顶起行为（聊天 app 头号破绽）
- `@capacitor/status-bar`：跟随 `theme.ts` 的 host theme 同步联动
- `@capacitor/haptics`：approval 确认、发送、配对成功等关键节点
- 禁 web 味：长按系统菜单、双击缩放、overscroll 橡皮筋、文字误选中
- Splash → 首屏无白闪（背景色对齐主题）
- 转场微调：PairScreen→ChatScreen、Sheet 弹出对齐 iOS 惯例

### Phase 3：原生推送（3~5 天，依赖 Phase 1，可与 Phase 2 并行）

1. relay 新增推送网关：接受 native token 注册，持有 APNs .p8 / FCM 密钥
2. 桌面 `pushNotifier.ts` 抽 sender 接口：Web Push 端点保留（PWA 用户不受影响），native token 走 relay 转发
3. 手机端 `@capacitor/push-notifications`：注册 + 通知点击路由（替代 `sw.js` 的 notificationclick）
4. 保持 E2E 语义：只推信令不推内容

### Phase 4：Demo 模式（2~3 天，依赖 Phase 1）

1. `PairClient` 的 `ClientEvents` 已是清晰事件接口 → 抽 `Transport` 接口，实现 `MockTransport`，UI 层零改动
2. 脚本化数据：假 catalog + 2~3 个会话，回放 `ProjectedMessage` 序列，**流式逐字吐**（对齐真实 AI 回复节奏），状态机走 connecting→online，回复加 500ms~2s 随机延迟
3. 覆盖路径：配对成功 → 会话列表 → 聊天收发 → approval 弹卡确认（向审核员展示 app 独有交互）
4. PairScreen 加 "Try Demo" 入口 + 界面角落 "Demo" 标识
5. 副产品：mock 层即离线 UI 开发环境（不开桌面端可开发手机端），亦可作新用户 onboarding 试用

### Phase 5：上架（3~5 天，含等待，依赖 2+3+4）

- 证书、bundle id、图标/截图素材
- 权限文案：`NSCameraUsageDescription`（"用于扫描配对二维码"），权限申请放在用户点「扫码配对」之后；推送权限在用户主动开启后再弹
- Review notes：companion 架构说明 + demo 入口用法 + 完整配对流程演示视频链接
- 合规自查：4.8（如有第三方登录须加 Sign in with Apple）、5.1.1（账号删除，如有账号体系）、3.1.1（如卖数字内容须 IAP，当前不涉及）
- Android 侧 Play Console 同步提交（审核压力小）
- 预期一次 4.2/2.1 被拒往返：用 Resolution Center 补视频/说明，二审通过是常态

---

## 3. 工作量汇总

| Phase | 工作量 | 依赖 |
|---|---|---|
| 1 壳跑通 | 2~3d | — |
| 2 质感 | 3~4d | 1 |
| 3 推送 | 3~5d | 1（可与 2 并行） |
| 4 Demo | 2~3d | 1 |
| 5 上架 | 3~5d | 2+3+4 |

**串行约 2.5~3 周；两人并行约 2 周。**

## 4. 风险清单

1. **iOS 无 SW push**（最大隐藏工作量）→ Phase 3 的 relay 推送网关，唯一新增服务端组件
2. jsqr 在 WKWebView 的相机流兼容性 → Phase 1 首日验证，原生扫码插件兜底
3. 审核 2.1（companion 无法演示）/ 4.2（套壳观感）→ Demo 模式 + Review notes + 质感清单对冲
4. E2E 加密语义在推送链路的保持 → 设计上只推信令不推内容

## 5. 明确不做（v1 范围外）

- RN / Flutter 重写
- 移动端独立设计稿（现有设计已定）
- Live update（OTA 热更）——上架跑通后再评估
- iPad / 平板适配
