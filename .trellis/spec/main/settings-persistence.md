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

## 不适合放这里的数据

- 窗口几何信息 → 独立状态文件，见 [windows.md](windows.md)
- 大段文本（指令文件内容）→ `userData/instructions/<id>.md`，
  settings 里只存元数据。理由：settings.json 每次设置变更都整体重写，
  塞进几十 KB 文本会让每次写入都变重。
