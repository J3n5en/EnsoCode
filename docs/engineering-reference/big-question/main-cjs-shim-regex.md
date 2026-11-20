# main 包出现 `require(` 后构建报 i18n 字符串未闭合

## 症状

`pnpm dev` / `electron-vite build` 在 main 段失败：

```
[vite:esbuild-transpile] Transform failed with 1 error:
index.js:28499:21: ERROR: Unterminated string literal
28499 |    "Confirm import": "
28500 |  // -- CommonJS Shims --
28501 |  import __cjs_mod__ from 'node:module';
```

报错位置在 `src/shared/i18n.ts` 的某条译文，但 i18n 源码完全正常，改动也不在那里。

## 根因

electron-vite 的 ESM 构建会检查产物里有没有 `__filename|__dirname|require(|require.resolve(`
（`CJSyntaxRe`），有就插入一段 CommonJS shim。插入点是用正则 `ESMStaticImportRe`
在**整段代码**里找“最后一个 import 语句”，字符串内容也会被扫到。
main 主 chunk 静态打进了整份 i18n 词典，其中含 “import … from …” 字样的英文句子，
shim 就被插进了字符串中间。

以前没出事，是因为用 `require(` 的模块（如 `llama/gpuBackendInstall.ts`）都被动态 import 到了单独 chunk；
一旦某个被 `main/index.ts` 静态引入的模块写了 `const require = createRequire(...)` 再 `require(x)`，就会触发。

## 修法

静态进 main 主 chunk 的模块不要出现字面量 `require(` / `require.resolve(` / `__dirname` / `__filename`：

```ts
const load = createRequire(import.meta.url);
const mod = load(dir);
```

路径用 `import.meta.dirname` 或 `fileURLToPath(new URL('.', import.meta.url))`。

## 回归防线

构建本身会失败，不会静默；看到 “Unterminated string literal” 且紧跟 `// -- CommonJS Shims --`
就先搜本次改动里新出现的 `require(`。

## 相关代码

- 曾由 `src/main/services/speech/service.ts` 的 `createSherpaRecognizer` 触发（该文件已随语音输入移除）
- `node_modules/electron-vite/dist/chunks/lib-*.js` 的 `CJSyntaxRe` / `ESMStaticImportRe`
