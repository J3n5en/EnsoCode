import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

// 默认禁止任何隐式快照写入：vitest 的默认 updateSnapshot 是 "new"，本地并发跑
// 同一测试（多个 vitest 实例或并行任务）时，第二轮的重复结果会以 "… 2" 的 key
// 静默写进快照文件，跟着功能提交混进仓库——#535 的 obsolete snapshot 就是这么来的。
// 显式更新快照用 `pnpm vitest run -u <文件>`（CLI 优先级高于此环境变量），
// CI 上 vitest 本来就按 none 处理，不受这里影响。
process.env.UPDATE_SNAPSHOT ??= 'none';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'src/shared'),
      '@': path.resolve(root, 'src/renderer'),
      '@enso/pair': path.resolve(root, 'packages/pair/src/index.ts'),
      '@platform': path.resolve(root, 'test/stubs/platform.ts'),
      // 主进程模块顶层会 import electron，node 环境下用桩替换
      electron: path.resolve(root, 'test/stubs/electron.ts'),
      '@electron-toolkit/utils': path.resolve(root, 'test/stubs/electron-toolkit-utils.ts'),
      // vitest 对 TSX 始终用 development 变换，元素创建走 react 开发版 jsxDEV：
      // 每个元素捕获组件栈帧并做属性校验，是渲染密集型快照测试的第一大开销
      // （CPU profile 里 react-jsx-dev-runtime + react-dom DEV 校验合计过半）。
      // 测试只观察渲染行为，不靠 DEV 警告；按生产语义实现 jsxDEV，行为不变。
      'react/jsx-dev-runtime': path.resolve(root, 'test/stubs/react-jsx-dev-runtime.ts'),
    },
  },
  test: {
    // 主进程逻辑跑在 node 环境；渲染层若日后加测试再按目录覆盖
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'packages/**/*.test.ts'],
  },
});
