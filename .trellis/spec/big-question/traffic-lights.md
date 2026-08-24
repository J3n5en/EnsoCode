# macOS 红绿灯的两个坑

## 坑一：标题不垂直居中 / 红绿灯遮住标题

### 症状

`trafficLightPosition: { x: 16, y: 16 }` 是按 44px 高的标题栏算的居中值，
但界面上红绿灯和标题始终对不齐，标题偏上。加大左内边距只能躲开重叠，
垂直方向依然不对。

### 根因

本项目 `:root` 的 `--font-size-base` 是 **14px**，不是浏览器默认的 16px。
Tailwind 的尺寸类基于 rem：

- `h-11` = 2.75rem = **38.5px**（不是 44px）
- `pl-20` = 5rem = **70px**（不是 80px）

标题栏实际只有 38.5px 高，而主进程按 44px 定位红绿灯，自然对不上。

### 修法

与主进程写死像素值对齐的地方，渲染层也用固定像素：

```tsx
// src/renderer/components/app/TitleBar.tsx
<div className="h-[44px] pl-[84px]">
```

**通用规则**：跨进程约定的几何数值，两边都用绝对像素，不要一边 rem 一边 px。

---

## 坑二：弹窗开关一次后红绿灯位置就偏了

### 症状

启动时红绿灯位置正常。打开任意弹窗再关闭，红绿灯就跑到系统默认位置去了，
之后一直不对，直到重启窗口。

### 根因

隐藏/显示红绿灯用的是 `setWindowButtonVisibility()`。
**`setWindowButtonVisibility(true)` 会把按钮位置重置为系统默认**，
它不保留之前 `trafficLightPosition` 的自定义值。

弹窗打开时守卫会隐藏红绿灯，关闭时恢复显示 —— 恢复的那一下位置就被重置了。

### 修法

恢复显示后重新设置位置（`src/main/ipc/window.ts`）：

```ts
// setWindowButtonVisibility 会把按钮位置重置为系统默认，恢复显示时需要重新设置
win.setWindowButtonVisibility(visible);
if (visible) {
  win.setWindowButtonPosition(TRAFFIC_LIGHT_POSITION);
}
```

`TRAFFIC_LIGHT_POSITION` 从 `src/main/windows/createAppWindow.ts` 导出，
创建窗口和恢复显示共用同一个常量，避免两处漂移。

## 相关

隐藏/显示的调用方是 `src/renderer/hooks/useTrafficLightsGuard.ts`，
它用引用计数支持多个并发弹窗、全屏时不隐藏、HMR 时复位计数。
新的弹窗组件走 `Dialog` / `AlertDialog` 封装即可自动接入，不要自己调 IPC。
