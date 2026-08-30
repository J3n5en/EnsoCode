# CDP 鼠标按键事件被静默丢弃:窗口 hidden

## 症状

用 CDP `Input.dispatchMouseEvent` 做真机验证时,拖拽/点击**时好时坏**:

- 同一段脚本、同样的坐标,刚才还能拖动重排,过一会儿就完全无反应;
- `Runtime.evaluate`、截图、`Input.insertText`、键盘事件全部正常;
- CDP 对 `mousePressed` 返回成功(空对象无 error),但页面的
  `pointerdown`/`mousedown` 监听器**收不到任何事件**——`mouseMoved` 却照常送达。

极易误判为产品代码 bug(本仓库首次踩到时,dnd-kit 拖拽功能已真机验证通过,
之后"突然失效",按产品 bug 方向排查了多轮:怀疑 HMR 状态、bridge 注册、
碰撞检测……全是无用功)。

## 根因

**Electron 窗口不可见时(被其它窗口遮挡/最小化/在另一个 Space),
Chromium 会丢弃 CDP 注入的鼠标按键事件,move 事件不受影响。**

判别一条命令:

```bash
node .agents/skills/enso-cdp/scripts/cdp.mjs eval '(()=>document.visibilityState)()'
# "hidden" → 按键事件必丢
```

诱因通常是验证间隙切窗口干别的(比如切回编辑器改代码),Electron 被压到后面。
`location.reload()` 本身不破坏输入——是 reload 前后窗口恰好被遮挡造成了
"reload 之后就坏了"的假象。

## 修法

OS 级激活窗口(`Page.bringToFront` **无效**,它只切 tab 不解决 OS 遮挡):

```bash
osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "Electron") to true'
```

`cdp.mjs drag` 已内置可见性检查 + 自动激活;手写鼠标序列前先查 `visibilityState`。

## 判别方法(下次遇到"输入类验证时好时坏")

1. 先查 `document.visibilityState`,hidden 就激活窗口重试——**不要先怀疑产品代码**;
2. 用捕获阶段监听器探针区分"事件没到达"与"到达但没生效":
   `window.addEventListener('pointerdown', e => probe.push(e.type), true)`;
3. 事件没到达 → 环境问题;到达但没生效 → 才轮到产品代码。

## 关联教训(同一次排查)

- 断言别用 class 子串:`focus-within:border-ring` 让 `className.includes('border-ring')`
  永真,制造了"落点高亮已触发"的假证据,干扰根因定位。
- 多段 `edit` 是原子的:任何一段锚点不匹配则**全部回滚**,不会部分生效。
  分多处渲染点的 UI 改动,改完要逐点(grep 计数或真机)确认都落上了。

详细操作见 [enso-cdp skill](../../../.agents/skills/enso-cdp/SKILL.md) 的「鼠标拖拽 / 点击」章节。
