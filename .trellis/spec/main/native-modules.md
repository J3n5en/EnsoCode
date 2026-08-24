# 原生模块规范

本项目有两个原生模块，**都只用于只读地扫描其它应用的配置**：

| 模块 | 用途 | 位置 |
|------|------|------|
| `better-sqlite3` | 读 CC Switch / Alma / Cursor 的 sqlite | `services/providerScan/readers.ts`、`services/assetScan/ccSwitch.ts` |
| `level` | 读 Cherry Studio 的 leveldb | `services/providerScan/readers.ts` |

不要用它们做本项目自身的持久化 —— 设置存 JSON，见 [settings-persistence.md](settings-persistence.md)。

## 只读打开

```ts
new Database(file, { readonly: true, fileMustExist: true });
```

目标应用可能正在运行并持有锁。leveldb 更严格，读之前要把目录**快照复制**一份
（排除 `LOCK` 文件）再打开，见 `readers.ts` 的 `readCherryStudio`。

打开失败一律返回空数组，不要抛 —— 用户没装那个应用是常态，不是错误。
表结构也不能假定存在，先查再读：

```ts
function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return Boolean(row);
}
```

用完 `finally { db.close() }`。

## pnpm 构建脚本

pnpm 10 默认**禁止**依赖执行安装脚本，原生模块会因此拿不到二进制文件。
`package.json` 里必须显式放行：

```json
"pnpm": {
  "onlyBuiltDependencies": [
    "better-sqlite3", "classic-level", "electron", "electron-winstaller", "esbuild"
  ]
}
```

漏项的表现各异且不直观：`electron` 漏了是找不到 Electron 可执行文件，
`better-sqlite3` 漏了是运行时报找不到 `.node`。新增原生依赖后**先加进这个数组再装**。

`postinstall` 里的 `electron-builder install-app-deps` 负责把原生模块重编译到
Electron 的 ABI，不要删。

## 版本对齐

原生模块的预编译产物与 Node/Electron ABI 绑定。升级 Electron 后如果启动报
`NODE_MODULE_VERSION` 不匹配，重跑：

```bash
pnpm rebuild && npx electron-builder install-app-deps
```
