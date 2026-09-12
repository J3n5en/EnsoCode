# 原生模块规范

本项目的原生模块：

| 模块 | 用途 | 位置 |
|------|------|------|
| `better-sqlite3` | 读 CC Switch / Alma / Cursor 的 sqlite（只读扫描） | `services/providerScan/readers.ts`、`services/assetScan/ccSwitch.ts` |
| `level` | 读 Cherry Studio 的 leveldb（只读扫描） | `services/providerScan/readers.ts` |
| `node-datachannel` | 配对直连（WebRTC DataChannel），main 进程内跑，不开隐藏窗口 | `services/pairDirectPeer.ts` |

不要用它们做本项目自身的持久化 —— 设置存 JSON，见 [settings-persistence.md](settings-persistence.md)。

## 可选能力型原生模块：动态 import + 静默降级

`node-datachannel` 这类「没有也能跑」的模块不要顶层 `import`：用 `await import()` 包在 try 里预加载（`preloadDirectPeer()`），
失败只 `console.warn` 一次并让工厂返回 `null`，上层自动退回无该能力的路径（直连 → 中继）。
它的二进制在嵌套 optional 依赖 `@node-datachannel/<platform>` 里，无 install 脚本，不进 `onlyBuiltDependencies`；
electron-builder 会自动把 `.node` 放到 `app.asar.unpacked`，各 OS 的 CI 各自安装自己平台的二进制（与 `@mariozechner/clipboard` 同模式）。
验证打包产物时用 `ELECTRON_RUN_AS_NODE=1 <App>/Contents/MacOS/<App> script.cjs` 从 `app.asar` require，而不是系统 node（ABI 不同）。

`node-llama-cpp` 的 CUDA / Vulkan 预编译（含 cuda-ext）不要打进安装包：Linux 上合计约 600MB，Mac 只有 Metal 十来 MB。CPU（以及 Mac Metal）随包提供；有 GPU 时 `ensureGpuBackend` 从 npm 拉对应平台包到 `userData/llama-gpu-backends`。排除 glob 以 `electron-builder.yml` 与 `ELECTRON_BUILDER_GPU_EXCLUDES` 为准。

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
