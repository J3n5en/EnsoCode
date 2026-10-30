# macOS 后台输入：修饰键卡住、Chromium 不收键、拖拽不起手

## 症状

- 后台 `press('cmd+a')` 之后紧跟的 `type('Hello')` 丢了开头的 `He`；更糟时 `H` 被当成 `cmd+H`，目标 app 直接隐藏。
- 同样直投进程（`SLEventPostToPid`）的按键，TextEdit 能收到，Electron / Chrome 完全没反应。
- 后台左键单击可用，同样字段的后台拖拽却只有 `mouseup`，元素不动。
- 实验中偶发：目标 app 收到合成点击后变成了系统真前台，用户的输入框失焦。
- TextEdit 开着两个文档时，后台 `type()` 指定 t2 窗口，字却打进了 t1。
- 后台点击按钮总是走合成点击，`via` 从不是 `axPress`。
- 开发版（未签名 Electron）里 SkyLight 激活报 `focus 1002`，或 `ax()` 报 tcc-denied。

## 根因

- 直投进程的事件不经过 HID 系统，修饰键不会被转换成 `kCGEventFlagsChanged`。
  把 Command 当 `keyDown/keyUp` 投递，AppKit 的修饰状态一直停在“按下”，后续字符都按快捷键处理。
- Chromium 只在窗口 key 且应用激活时把键盘事件交给页面；原生 AppKit 不检查这一点。
- 后台窗口第一次 `mouseDown` 只会让窗口接受 click-through，不会开始拖拽；左键点击的配方里本来就有
  `(-1,-1)` 的 primer 按下/抬起，拖拽缺了这一步。
- 合成激活（SkyLight 0x0d 记录）只改目标“自以为”的状态；个别 app 在这种状态下收到点击会自行申请激活，
  系统就真的把前台给了它。
- 0x0d 激活不改变 app 内的 key 窗口：AppKit 把键盘交给它原来的 key 窗口。
- `AXUIElementCopyElementAtPosition` 用系统级元素时按屏幕 z 序命中；后台目标通常被盖住，命中的是遮挡它的 app。
  Chromium 刚打开 AX 树后的第一次命中也只返回根 `AXScrollArea`。
- SkyLight 激活与事件直投都要求调用进程（按 TCC 归属）有辅助功能权限，没有时返回 1002。
  从终端 `pnpm dev` 起的开发版归属会随终端变化；用 `open -n -a .../Electron.app` 起时它自己是权限主体，
  但其 utility 子进程（AX worker）不继承授权，`ax()` 仍是 tcc-denied。正式签名的 EnsoCode 不受影响。
  另见过一次已授权的开发版整个实例持续 1002、重启即恢复，根因未定位。

## 修法

- 修饰键用 `CGEventSetType(kCGEventFlagsChanged)` 投递，按下时累加、抬起时递减标志位；释放后再等 20ms。
- 后台输入统一经过 `FocusSession`：首个动作前发一次合成激活，同一目标跨动作、跨 run 保持（菜单、下拉不会因失焦关闭），
  空闲 8s / 会话关闭 / 应用退出时反激活。
- 动作期间每 30ms 轮询真前台：目标被抢成真前台且用户没有物理输入时，立即把前台还给用户原来的 app；
  用户刚有物理输入则视为用户自己切过去，报 `user-active`，不抢回、不继续输入；超过 3 次报 `focus-steal`。
- 左键拖拽配方带 primer；非左键点击不带 primer（会多出一次左键）。
- 后台打字不切系统输入法，除非当前是输入法且用户 1s 内没有物理输入；切换只覆盖本次输入并立即恢复。
- 激活后补发 0x01/0x02 两条 key-window 记录（窗口号在 0x3c，0x3a=0x10，0x20–0x2f 为 0xff），只改 key 不提升层级。
- 点击判 AXPress 前先打开目标 AX 树，并用 `AXUIElementCreateApplication(pid)` 做 app 内命中；命中不到可按控件时合成点击。
- 激活被拒时报 `BackgroundUnavailable`（提示可能是辅助功能授权），不自动改走前台。

## 回归防线

- `focusSession.test.ts`：激活顺序、幂等、换窗口先反激活、窃取还回、用户主动切换报 `user-active`、窃取上限、空闲收尾。
- `skyClick.test.ts`：右键/中键无 primer、拖拽配方与路径插值。
- `macKey.test.ts`：修饰键键码到标志位。
- `skyClick.test.ts` 覆盖 key-window 记录字节布局。
- 真机（macOS 27.0.1）用 Electron 测试窗口验证：后台单击/右键菜单/菜单键盘选择/滚动/拖拽/`cmd+a` 后输入中英文混合文本均到达，
  全程 `GetFrontProcess` 仍是用户原来的前台 app。
- 隔离 userData + fake provider 的开发版里走完整工具链：首次授权弹窗（允许 / 始终允许 / 25s 未答）、后台点击与输入、
  TextEdit 双文档定向输入、设置页名单撤销均通过。

## 相关代码

- `src/main/services/computer/focusSession.ts`
- `src/main/services/computer/macosNative.ts`（`pidKeyChord`、`pidTypeText`、`skyPointer`、`skyScroll`）
- `src/main/services/computer/skyClick.ts`
- `src/main/services/computer/macos.ts`
