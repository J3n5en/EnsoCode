# Computer Use 后台操作设计

2026-10-30。分析 ChatGPT 桌面端 Computer Use 的机制，对照 EnsoCode 现有
`computer` 工具，给出把「后台操作指定 app」从「只有点击」补到「点击/键盘/滚动均可后台、
多 app 并行」的设计。2026-10-31 已按本文实现，落地决定与偏差见文末「实现记录」。

## 目标

**行为差距（现状 → 目标）**

- 现状：macOS 上只有 `click` 能后台投递；`move`/`drag`/`scroll`/`typeText`/`keyChord`
  在 `delivery: 'background'` 下一律抛 `BackgroundUnavailableError`。像素输入与键盘输入
  基本等于前台接管，由 `ComputerOccupancy` 亮横幅、挂 Esc、检测物理 HID 并在用户动手时中止。
- 目标：指定某个 app，在用户继续用电脑的前提下完成点击、输入、滚动、拖拽；
  多个 run 可以在**不同 app** 上并行；用户一动键鼠仍然全线让路。

**成功判据**（照 Sky 那套反编译文档的验收口径，见文末「验证」）

1. 目标 app 在后台完成动作；
2. 全程 EnsoCode 仍是系统真前台；
3. 用户正在用的输入框全程不失焦；
4. 右键菜单出现在目标行上、且内容是目标 app 的。

## 关键事实（对实物核对）

本机 ChatGPT.app `26.1027.30824`，内置 `@oai/sky` `0.7.13`，原生服务
`~/.codex/computer-use/Codex Computer Use.app`（`com.openai.sky.CUAService`
`26.1022.1001641`，arm64，sha256 `e798d6a2…723dea`）。从导出符号与随包文档确认：

| 事实 | 证据 |
| --- | --- |
| API 以 app 为第一参数，不是以屏幕为坐标系 | 随包 `docs/sky-window-api.md` |
| `click` 优先 `element_index`（树内身份），坐标是退路 | 同上；`docs/skills/oai_sky_lib/macos/SKILL.md` |
| AX 树是主感知通道，截图兜底；明令禁用 `osascript`/JXA | macOS `SKILL.md` |
| `SyntheticAppFocusEnforcer` 维护三态：believed-active / believed-focus / really-active | 导出符号 + `State` 三个 getter |
| 激活包：`NSAppKitDefined`(13) subtype 1、flags `0xC0000`、带 window id；随后 `key-focus-returned`(21) subtype `0x8000`，顺序固定 | `notifyAppActivated` / `notifyWindowKeyFocusReturned` |
| `SystemFocusStealPreventer` 装进程通知 tap，并在「以为 active 但不是真前台」时加装私有 event type 32 tap（`1<<32`） | 导出符号 + `DisallowedThiefProcess` |
| 菜单开启期间单独抑制 dismiss 事件（跨进程菜单必需） | `startSuppressingMenuDismissalEvents(menuPID:)` |
| AXPress 与合成点击在**同一入口**内选择，`alwaysSimulateClick` 是开关 | `UIElementProtocol.click(…alwaysSimulateClick:focusEnforcer:virtualCursor:)` |
| 控制器按 **pid** 持有，每个控制器一个虚拟指针 → 多 app 并行 | `ComputerUseAppController.createVirtualCursorIfNeeded` |
| Electron/Chromium 需要打开 AX（`AXManualAccessibility` / `AXEnhancedUserInterface`），且是**有生命周期的 assertion** | `AXEnablementAssertion` 有 `disable()` 与 deinit |

## 行为差距与所属层

| # | 差距 | 现状代码 | 所属层 |
| --- | --- | --- | --- |
| 1 | 键盘/滚动/拖拽没有后台路径 | `macos.ts` 四个方法直接抛错 | Main / computer 后端 |
| 2 | 合成激活是**一次性租约**：激活 → 40ms → primer 点击 → 真实点击 → 100ms → 反激活 | `macosNative.ts` `skyClick` | Main / computer 原生桥 |
| 3 | 没有焦点窃取防护，也就没有「持续以为自己在前台」的能力 | 无对应物 | Main / computer 原生桥 |
| 4 | 宿主只有**一把全局租约**，所有 session、所有 app 串行 | `computerHost.acquire` | Main 宿主 |
| 5 | AX 优先不在 `click` 路径内：`win.click(x,y)` 直接进后端像素路径，`axClick` 是另一个独立方法，靠工具文档劝模型自律 | `guest.ts` dispatch + `macos.ts` `axClick` | shared 契约 + guest |
| 6 | 没有 per-app 授权：TCC 一授权就等于「整台机器的 AX 树 + 全屏截图」 | 只有 `capabilities` 与 `macPrivacySettings` | Main |
| 7 | AX 树每次全量快照，`ref` 按 target generation 失效，没有跨代稳定身份与 diff | `AxRegistry` / `axSnapshot` | shared / computer |
| 8 | `capabilities.backgroundInput` 在 macOS 上仅要求 native+AX 即报 `true`，实际只有 click 支持，**能力上报过度承诺** | `macos.ts` `capabilities()` | Main |
| 9 | `delivery` 契约不符：`resolveClickRoute` 在 pid+windowId 已知时一律返回 `skyClick`，即 `delivery:'foreground'` 被忽略；`axClick` 的兜底正是传 `'foreground'` | `clickRoute.ts` | shared 契约 |

第 8、9 条不是设计取舍，是实现与契约打架，属于顺手要修的既有缺陷。

## 方案总览

分六层，自下而上（第 6 层可后置；第 3 层「click 收敛」是第 2 层输入路径的一部分，
单独列出是因为它改的是 shared 契约）。**第 1 层是其余一切的前置条件**：
键盘事件只有在目标元素真拿到 key focus 时才会被处理，没有常驻的合成焦点，
就无法让 `typeText`/`keyChord` 进后台。

```
授权（per-app allowlist，Main 校验并冻结规范路径）
        │
宿主（per-app 租约：同 app 串行、跨 app 并行；occupancy 按 app 分片）
        │
输入路径（AX 动作优先 → 合成事件 → 失败报错；前台 HID 单独一条）
        │
合成焦点会话（FocusSession per pid：enablement assertion + 三态状态机 + 窃取防护）
        │
原生桥（SLEventPostToPid / CGEventPostToPid / window-local 坐标 / type 32 tap）
```

## 各层改动

### 层 1：合成焦点会话（核心）

新增 `FocusSession`，键为 `pid`，生命周期是**一次 run 或一组后台动作**，而不是单个动作：

- 建立时：持有 `AXEnablementAssertion`（Electron/Chromium 必需）、装 focus-steal preventer；
  当 `believed-active && !really-active` 时加装私有 type 32 tap；
- `enforce(window)`：状态机，`activation → key-focus-returned`，幂等，已 believe 就不重复发；
- 菜单打开期间：抑制 dismiss，菜单 pid 单独跟踪；
- 收尾：统一 teardown，不在每个动作前后开合。

必须替换掉的现状是第 2 条：现在 `skyClick` 在「点击之外」没有任何激活状态，
所以右键（`skyClickCanHonor` 只允许左键）走 `postToPid` 时没有激活包，
长按、拖拽、连续输入也都不在激活窗口期内。

### 层 2：输入路径补齐

把 `delivery` 从「click 专属」提升为所有指针/键盘动作的共同维度：

- 后台：AX 动作（press / setValue / select / scroll 参数化属性）优先 →
  pid + window-local 合成事件 → 都没有才报错，**并说明缺哪一条**；
- 前台：保留现有 HID 路径不变；
- 两类明确没有后台路径，写进错误信息而不是静默降级：需要真实 `NSTouch` 的手势
  （合成 scroll 触发不了浏览器双指返回，这是实测结论）、少数读物理键码的游戏。

### 层 3：`click` 收敛到单一入口

`win.click(x, y)` 内部改为：`elementAt(x, y)` → 若元素属于目标窗口且可 press → AXPress；
否则合成点击。理由与 Sky 的 `alwaysSimulateClick` 一致：同一个意图不该让模型在
`click` 和 `perform` 之间二选一。现有 `axClick` 的 press→前台兜底逻辑保留，作为内部实现。

### 层 4：宿主与租约

- 租约键从「全局」改为目标 app（pid 或 bundle id + 窗口）；同 app 串行、跨 app 并行；
- `occupancy` 从全局单例改为按 app 分片；真 HID 接管仍全局互斥（只有一个前台）；
- 用户 HID 让路语义要明确：是全线让路还是只让前台那个（见「待确认」）。

### 层 5：授权

新增 per-app allowlist：`settings.json` 只存元数据（bundle id、显示名、last used），
Main 在动作前校验并回传**冻结的规范 app 路径**，guest 侧只能用这个路径。
对齐 `AGENTS.md` 的「Renderer 只传标识符，路径由 Main 推导并校验」。
不做成「每次弹窗」，那会直接毁掉并行。

### 层 6：AX 树 diff（可后置）

`axSnapshot` 增加 revision 与 diff 输出，尽量让未变节点保持同一 `ref`。
收益是 token 与模型稳定性；风险见下。

## 明确不做

- **不做 Windows 后台**。我们的 UIA 桥是作业/超时模型，`Invoke` 只覆盖部分控件，
  无法给出与 macOS 同等的语义；继续前台接管，并在能力上报里如实写清楚。
- **不做虚拟显示 / VM 隔离**。ChatGPT 在 Mac 上也没有这么做，它操作的是真数据；
  隔离属于部署形态问题，不属于本工具。
- **不做真实 `NSTouch` 手势合成**（私有、跨版本极脆）。
- **不给模型开放的 native 调用入口**。仍然只经 guest → backend，不破坏现有沙箱。
- **不改 tool schema 形状**（仍是 `code` + `read_only` + `timeout`），只扩 guest 内 API。

## 风险

1. **私有实现随系统版本漂移**：type 32 tap、`SLEventPostToPid`、`CGEventSetWindowLocation`、
   window-local 坐标都不是公开契约。必须每次 macOS 升级回归；现有的
   `SKY_CLICK_UNAVAILABLE` 降级通道要继续保留。
2. **常驻焦点会话的失败模式比一次性更糟**：teardown 漏一次，目标 app 会长期「以为自己在前台」，
   用户键盘输入被打到错的地方。需要 session 级 `finally` + 进程退出兜底 + 超时自愈。
3. **多 app 并行会让「用户一动就让路」语义变复杂**：多片 occupancy 同时在线时，
   中止粒度、提示形态、Esc 归属都要重新定义。
4. **AX diff 与正确性冲突**：diff 视图容易让模型误判「这个控件不存在」，
   需要和 `AX_STALE_HANDLE` 的失效语义一起设计。
5. **per-app 授权的信任面**：授权「这个 app」等于授权读走它窗口里的**全部**文本
   （包括同窗口里别人的消息），比「占用鼠标」严重得多，文案与默认档要慎重。

## 验证

**单测**（遵循 AGENTS.md，先 RED）

- 状态机：`enforce` 幂等、顺序（activation 必须先于 key-focus-returned）、teardown 幂等；
- 点击路由决策：pid/window 已知、未知、右键、带修饰键、双击；
- 租约键：同 app 串行、跨 app 并行、关闭时释放；
- 授权：规范化路径、越权拒绝、脏输入。

**真机矩阵**（每格都要后台跑通才算过）

| app | 覆盖的点 |
| --- | --- |
| TextEdit | 原生 AppKit、可 AXPress、可 `setValue` |
| Chrome | Electron/webview：AX assertion、跨进程元素、无 press 的控件 |
| 系统设置 | 不可写 `AXValue`、只暴露 increment/decrement 的控件（见 `macos-ax-identity`） |
| 终端 | focus-follows-mouse 的反例 |
| Numbers | Sky 明确排除 app 专属前缀的那个 app |

**端到端**：至少两个厂商的模型真机各跑一次完整流程（AGENTS.md 要求）；
同时验证「用户在跑任务期间正常打字」不被打断、也不打断任务。

## 待确认

1. 并行粒度按 **app** 还是按 **window**？
2. 用户 HID 让路：全线中止，还是只中止前台那个 app 的 run？
3. per-app 授权默认档：首次询问 / 默认拒绝 / 预置白名单，三选一。
4. 是否要做虚拟指针（Sky 有 `VirtualCursor`）。它能明显降低「AI 在动我的电脑」的恐惧，
   但也会让用户以为真的有个指针在动。
5. 第 8、9 条能力上报与 `delivery` 契约缺陷，是否先单独修一版再动大改。

## 相关代码

- `src/main/services/computerHost.ts`：全局租约、lazy occupancy、run 生命周期
- `src/main/services/computer/occupancy.ts`、`occupancyOverlay.ts`：前台占用与让路
- `src/main/services/computer/macos.ts`：`delivery` 分支、`BackgroundUnavailableError`
- `src/main/services/computer/macosNative.ts`：`skyClick`、`postToPidOnce`、私有 FFI
- `src/main/services/computer/skyClick.ts`：Sky 事件配方与激活记录
- `src/main/services/computer/clickRoute.ts`：点击路由
- `src/shared/computer/axRegistry.ts`：`ref` 身份与跨代失效
- `src/shared/computer/readOnly.ts`：只读白名单
- `docs/engineering-reference/big-question/macos-ax-identity.md`、`macos-window-focus.md`、
  `cdp-hidden-window-input.md`：已踩过的 AX 与焦点坑

## 实现记录（2026-10-31）

**待确认项的决定**

1. 并行粒度按 **app（pid）**：一个 app 只有一个 key window，同 app 两个窗口并行打字必然抢焦点。
2. 用户让路：前台接管仍是“用户一动就全线中止”；后台 run 不因用户使用其它 app 中止，
   只有用户正在用的就是目标 app（真前台 + 1s 内有物理输入）时，该动作报 `user-active`。
3. per-app 授权默认 **首次询问**：系统弹窗「允许 / 拒绝」+「始终允许」勾选；
   名单落在 `userData/computer/allowed-apps.json`（只存 bundle id、显示名、规范路径、时间），设置页可撤销。
   只门控输入与 AX 写操作；截图与 AX 读取不弹窗（读取已受 TCC 与只读审批约束）。
4. 做了虚拟指针：每个目标进程一个，带色与「AI · 应用名」标签，`setContentProtection` 排除在截图外。
5. 第 8、9 条随本次一起修：`backgroundInput` 只在 SkyLight 通道可用时为真；`delivery:'foreground'` 一律走 HID。

**与设计的偏差**

- 激活用 SkyLight 0x0d 记录（激活 / 反激活），随后补发 0x01/0x02 key-window 记录把目标窗口设为 key（不提升层级）。
  `key-focus-returned` 记录的字节布局未能在实物上确认，上述组合在 TextEdit（含同 app 多文档）与 Electron 上
  已能让键盘、菜单、拖拽全部到达，故未实现。
- 菜单 dismiss 抑制没有单独实现：焦点会话跨动作、跨 run 保持（空闲 8s 才反激活），菜单不会因 run 边界失焦关闭；
  已验证 Electron 右键菜单可用后台方向键 + 回车选中。
- 焦点窃取防护用动作期间 30ms 轮询真前台 + `SetFrontProcessWithOptions` 还回，而不是私有 type 32 event tap。
- 缺省投递方式改为按能力：macOS 支持后台时缺省后台，Windows 仍缺省前台。
- AX 树 diff：worker 按 `CFHash`/`CFEqual` 复用同一元素的句柄，Main 侧同一句柄复用同一 ref，
  diff 视图里未变行的 ref 继续有效；diff 仍需显式 `{ diff: true }`。

**验证**

- 单测：焦点会话、事件配方、租约、授权、AX 打开声明、ref 稳定、宿主并行/串行/授权、guest 投递与预算。
- 原生层真机：Electron 测试窗口与 TextEdit 上后台点击/右键菜单/滚动/拖拽/组合键/中英文输入，用户前台不变。
- 应用内（隔离 userData + fake provider 驱动 computer 工具）：授权弹窗三种结果、后台点击与输入、TextEdit 定向输入、
  设置页撤销、虚拟指针窗口出现。
- 未做：两个厂商真实模型的自主调用验证（隔离环境只有 fake provider）；开发版 AX worker 拿不到 TCC 授权，
  AXPress 收敛在应用内未能走通，仅在原生层验证了 app 内命中能拿到 `AXButton`/`AXPress`。

踩坑记录见 `docs/engineering-reference/big-question/macos-background-input.md`。
