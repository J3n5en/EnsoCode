# 执行计划

小步提交；每步 `pnpm typecheck`。

## 1. 依赖 + 加载验证（先验证可行性）
- [x] `pnpm add @rahularya01/pi-cursor @bufbuild/protobuf`
- [x] 临时 node 脚本：import 扩展 default + shim registerProvider，确认 `cursor` provider 注册成功、getModels 有 fallback。跑通再继续；跑不通则止步回报。

## 2. loader
- [x] 新建 `src/agent/cursorExtension.ts`：`loadCursorProvider(runtime)`（shim、幂等、try/catch 静默）

## 3. 环境对齐 + runtime 加载
- [x] `agentHost.startAgentWorker`：fork env 增 `PI_CODING_AGENT_DIR`
- [x] `oauthProviders.getRuntime`：设 `PI_CODING_AGENT_DIR` 默认；create 后调 loader
- [x] `supervisor.getRuntime`：create 后调 loader

## 4. spawn 适配
- [x] 验证 `getModel('cursor', id)` 可用；必要时 oauth 分支加 refresh/getAvailable 兜底

## 5. 验证
- [x] `pnpm typecheck` + `pnpm build`
- [ ] 端到端（登录+对话）留用户实测（需真实 Cursor 账号）

## 回滚点
每步独立 commit；失败可卸依赖 + revert。
