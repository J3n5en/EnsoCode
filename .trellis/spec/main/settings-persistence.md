# 设置持久化规范

全部设置存在 `app.getPath('userData')/settings.json`，**没有数据库**。
实现在 `src/main/ipc/settings.ts`。

## 数据形状

顶层按 store 名分键，zustand persist 写入的结构是：

```json
{
  "enso-settings": {
    "state": { "theme": "...", "providers": [...], "skills": [...] },
    "version": 1
  }
}
```

主进程直接读这个文件做去重比对时，路径是
`settings['enso-settings'].state.<字段>`（见 `assetScan/index.ts` 的 `existingKeys()`）。
**改字段名要同步改那里** —— 那里用的是 `unknown` 断言，类型检查抓不到。

`version` 由 `src/renderer/stores/settings/migrate.ts` 的 `SETTINGS_VERSION` 决定。
**改数据形状时 +1 并在 `migrateSettings` 里加一段**，不要靠读侧兜底：
`migrate` 只在持久版本落后时跑一次且跑完会回写磁盘，旧字段就此消失；
放 `onRehydrateStorage` 会变成每次 rehydrate（含多窗口同步广播）都执行且永不回写。
已有的一段：v0 → v1 把 `ModelProvider.oauthProviderId` 改名为 `oauthAccountKey`
（订阅多账号方案，见 `src/shared/types/oauthProviders.ts`）。

## 写入策略

三层保护，改动时不要绕过：

1. **内存缓存** —— `cachedSettings` 是读取的唯一来源，避免频繁读盘。
2. **防抖 + 上限** —— 500ms 防抖，5s 强制落盘（`MAX_WAIT_MS`），
   避免连续拖动滑块时反复写文件，也避免一直被打断永远不落盘。
3. **原子写** —— 先写 `.tmp` 再 `renameSync`，避免崩溃留下半截文件。

退出前 `app.on('before-quit')` 调 `flushSettings()` 把未落盘的写掉。
新增会频繁触发写入的设置项时，确认它经过这条路径而不是自己写文件。

## 多窗口同步

写入时向**除发起窗口外**的所有窗口广播：

```ts
for (const win of BrowserWindow.getAllWindows()) {
  if (win.webContents !== event.sender && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED);
  }
}
```

渲染层收到后重新 rehydrate（见 `src/renderer/stores/settings/index.ts` 末尾）：

```ts
window.electronAPI.settings.onChanged(() => {
  void useSettingsStore.persist.rehydrate();
});
```

`onRehydrateStorage` 里会重新应用主题、字体、语言等副作用，所以两个窗口的外观能同步。
**新增带副作用的设置项时，副作用必须同时写进 `applySettings()`**，
否则只有改动的那个窗口生效，另一个窗口要重启才对。

### Don't：rehydrate 路径上无条件 setState

**现象**：打开设置窗后改任何一项设置，两个渲染进程 CPU 各自跑到 100%+，
界面卡死、设置改不动。单窗口不复现。

**成因**：persist 的每次 `setState` 都会落盘并广播 `SETTINGS_CHANGED`，而广播是
`exclude-sender` 的 —— 只要 rehydrate 后的回调无条件写一次 state，两个窗口就会
互相广播成死循环：

```
窗口A 写 → 落盘 → 广播(排除A) → 窗口B rehydrate → 无条件 setState
  → 落盘 → 广播(排除B) → 窗口A rehydrate → … ∞
```

实例：source-authority 投影回调每次都构造新数组 `setState({ projects })`，
内容完全相同但引用不同，zustand 判定为变更。

**规则**：`onRehydrateStorage` 及其触发的任何异步回调里，写 state 前必须先比对值：

```ts
// Wrong：内容相同也会触发落盘 + 广播
useSettingsStore.setState({ projects: next });

// Correct
if (sameProjectProjection(useSettingsStore.getState().projects, next)) return;
useSettingsStore.setState({ projects: next });
```

**回归测试断言点**：同一份投影重复到达时，`settings.writeKey` 不得被再次调用
（见 `src/renderer/stores/settings/projectProjection.test.ts`）。
只断言“值正确”是不够的 —— 死循环里值一直是对的。

### Don't：水合完成前把 initialState 整包写回

**现象**：打开独立设置窗后，主界面突然回到引导，模型 / 技能 / MCP 像被清空。
关引导只把 `onboarded` 标回 true，不会把已经盖掉的配置救回来。

**成因**：zustand persist 在异步 `getItem` 完成前就把 `setState` 接到 `setItem`。
设置窗是另一个渲染进程，store 先以空默认值起来；模块加载时的
`refreshProjectAuthorityProjection()` 等 `setState` 会把这份空状态经
`SETTINGS_WRITE_KEY` 整包写成 `enso-settings`。主进程按键合并，但值本身
已经是空 providers / skills / mcpServers。广播后主窗口 rehydrate 跟着被洗空。

**规则**：`electronStorage.setItem` / `removeItem` 必须等**同一个 store 名**的闸门打开后再写。
闸门不能在 `getItem` 返回时开 —— 从 read 回包到 persist merge 之间还有几个 microtask，
内存仍是 initialState。正确的开闸点是该 store `onRehydrateStorage` 回调的首行
（`openPersistWriteGate(name)`，`error` 有值时不开）：那是 merge 之后、回调自身补写之前。
开闸前的写入直接丢弃，不要排队 —— 队列里是空默认值，读回真实配置后再 flush 一样会覆盖。
闸门按 store 名独立，`enso-conversations` 不得被 `enso-settings` 的水合拖住。
代价：紧随 `migrate` 的那次 persist 回写发生在开闸前会被丢弃，migrate 必须幂等。

**回归测试**：`storage.test.ts`（闸门本身）+ `hydrationGuard.test.ts`（真实 store 端到端）。
必须断言水合完成前 `writeKey` 一次都没有、且任何一次落盘都不带空默认值，
而不是断言“最后磁盘里值看起来对”。持久化 fixture 的 `version` 要等于 `SETTINGS_VERSION`，
否则测到的是 migrate 回写而不是闸门。

### 护栏：破坏性写入前快照

渲染层交上来的 `enso-settings` 是整包，主进程无法分辨「用户真的清空了 providers」和「某个新写路径
又把 initialState 写回来了」。所以 `scheduleWrite` 不拒绝，但会在一次写入把
`providers / skills / mcpServers / instructions` 从非空写成空时，先 flush 再把当前磁盘文件复制为
`settings.backup-<ISO 时间>.json`（只留最近 5 份），并 `console.warn`。
排查「配置突然丢了」先看 userData 目录里有没有这些快照；新增受保护字段改 `PROTECTED_FIELDS`。
测试：`src/main/ipc/settingsBackup.test.ts`。

### 跨窗口同步的 lost-update

`settings.onChanged → persist.rehydrate()` 是 `set(snapshot, true)` 整体替换。若本窗口在重读在途时
也写了一笔，主进程按 IPC 顺序先答复读（旧快照）、后处理写，回包会把这一笔从内存盖掉，下次落盘再把旧值
写回。`syncSettingsFromMain` 用 `storage.ts` 的 `writeGeneration` 判断重读期间是否有本地写，有则再读一次
（上限 3 轮）。测试：`hydrationGuard.test.ts` 的 sync 用例。

## 不适合放这里的数据

- 窗口几何信息 → 独立状态文件，见 [windows.md](windows.md)
- 大段文本（指令文件内容）→ `userData/instructions/<id>.md`，
  settings 里只存元数据。理由：settings.json 每次设置变更都整体重写，
  塞进几十 KB 文本会让每次写入都变重。

## 会话流式持久化的内存上限

### 适用范围

会话 store 每条流式事件都可能触发持久化。主进程的磁盘防抖发生在 IPC 收包之后，
不能限制 renderer 的 JSON 编解码、contextBridge 复制及在途请求。大量重复 commands
会放大每笔元数据，突发写入可造成 V8 OOM。设置 store 保留原来的字符串适配器。

### 接口

`stores/settings/storage.ts` 导出 `createElectronPersistStorage<State>(): PersistStorage<State>`，
供会话 store 直接传入 `persist.storage`，不包 `createJSONStorage`。
复用既有 `settings.writeKey(name, { state, version })`；删除传 `undefined`，不增加 IPC。

### 契约

- 每个适配器、每个键最多一个在途 IPC 和一个最新待写对象；第一笔立即发送，后续覆盖待写值。
- 同一批次共享完成 Promise，不逐事件保存 payload 或 resolver 列表。
- 删除与更新共同排序；最后操作决定最终值。不同键独立推进。
- 水合前丢弃写入；接受后的每次更新均增加 `writeGeneration`，即使之后被合并。
- `getItem` 等待同键在途批次完成后读取，防止主动 rehydrate 回退到旧值。
- commands 不进入会话 partialize；旧数据可读，后续正常写入剥离，worker 继续恢复内存。

### 错误与验证

| 条件 | 行为 |
| --- | --- |
| 闸门关闭 | 直接丢弃，不排队、不增加写入代数 |
| IPC 返回 false / 拒绝 / 同步抛错 | 批次 Promise 拒绝并报告错误，继续处理最新待写值，不锁死后续批次 |
| 同键批次写入成功 | 完成 Promise 在最后值写完后解决 |

### 场景

正常：单次元数据更新立即发送；突发：首值在途时数百次更新合并为最新值；
错误：把数百个完整会话副本各自发送，再指望主进程的磁盘 debounce 解决内存峰值。

### 回归测试

`settings/coalescedStorage.test.ts` 覆盖在途上限、最后值、共享 Promise、不同键隔离、
更新/删除顺序、失败恢复、读写顺序和水合闸门；`sessions/index.test.ts` 覆盖冷事件
不触发持久化、commands 恢复及投影。断言写入次数和最后值，不能只断言 UI state 正确。

### 错误与正确接法

```ts
// 错误：每次 state 更新已经 stringify，排队时还会保留多份巨型字符串。
storage: createJSONStorage(() => electronStorage)

// 正确：会话在对象级合并，发送时才发生跨进程复制。
storage: createElectronPersistStorage()
```
