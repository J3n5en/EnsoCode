# PWA 完整模式重启后回到旧会话

## 症状

手机完整模式里切换了会话，关掉 PWA 再打开，仍停在切换前的那条。
当次不用重启是对的，所以容易去查启动快照或 Service Worker 缓存。

## 根因

完整模式跑的是桌面 renderer，当前会话写在共享的 `enso-conversations.activeId` 里。
桌面窗口和手机同时在线时，这份状态按字段补丁合并，补丁不含 `activeId`
（避免一边切换把另一边正在看的会话抢走）。手机的选择因此到不了磁盘，重启读回的仍是旧值。

## 修法

远程界面按配对设备把当前会话记在本机 `localStorage`。水合时若该会话还在，就盖过磁盘上的 `activeId`。
水合那一次写入不算用户的选择，避免还没切换就把桌面的当前会话钉死在手机上。
不要把 `activeId` 加进共享补丁。

## 回归防线

`src/renderer/stores/sessions/remoteActive.test.ts`

## 相关代码

`src/renderer/stores/sessions/remoteActive.ts`、`src/shared/conversationsPatch.ts`、`src/main/services/remoteRenderer/conversationSync.ts`
