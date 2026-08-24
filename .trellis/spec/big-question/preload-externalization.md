# preload 打包把 electron 当成了 npm 包

## 症状

`pnpm dev` 后应用起不来，控制台报：

```
Unable to find Electron app at /path/out/preload/install.js
Cannot find module ...
Electron failed to install correctly, please delete node_modules/electron and try installing again
```

紧接着渲染层报 `Cannot read properties of undefined (reading 'settings')` ——
因为 preload 根本没执行成功，`window.electronAPI` 不存在。

误导性在于报错文本指向 `node_modules/electron` 安装损坏，
但重装依赖没有任何用。

## 根因

`electron.vite.config.ts` 的 preload 段里自定义了输出格式：

```ts
preload: {
  build: {
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: '[name].cjs' },  // 这里
    },
  },
},
```

electron-vite 默认给 preload 配了 `external: ['electron', ...]`。
自定义 `rollupOptions.output` 在配置合并时把这份默认 external 覆盖掉了，
于是打包器把 `electron` 当成普通 npm 包解析并打进产物 ——
它解析到的是 electron 包的**安装脚本**，所以产物入口变成了 `install.js`。

## 修法

不要在 preload 段自定义 `rollupOptions.output`。用 electron-vite 的默认行为：

```ts
preload: {
  build: {
    externalizeDeps: true,
  },
  resolve: { alias: { '@shared': path.resolve(__dirname, 'src/shared') } },
},
```

默认产物是 ESM 的 `out/preload/index.mjs`，窗口配置里的路径要与之一致：

```ts
preload: join(__dirname, '../preload/index.mjs'),
```

## 判别方法

preload 相关的报错先看产物：

```bash
ls out/preload/
```

正常只有 `index.mjs`（加 source map）。出现 `install.js`、`cli.js` 之类
明显来自某个 npm 包内部的文件名，就是 external 失效了。
