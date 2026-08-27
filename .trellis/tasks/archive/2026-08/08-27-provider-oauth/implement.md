# 执行计划

按序实施，每步完成后 `pnpm typecheck`，可独立描述的改动即 commit（小步提交）。

## 1. shared 类型层
- [x] `src/shared/types/llm.ts`：`ModelProvider.oauthProviderId?`
- [x] `src/shared/types/agent.ts`：`SpawnModelConfig.oauthProviderId?`
- [x] 新建 `src/shared/types/oauthProviders.ts`（OauthProviderInfo / OauthLoginPrompt / OauthLoginEvent），在 types 入口导出
- [x] `IPC_CHANNELS` 新增 5 个通道 + 1 个事件通道

## 2. main 服务与 IPC
- [x] 新建 `src/main/services/oauthProviders.ts`（runtime 懒建、list/login/logout、prompt 挂起表、Abort 取消）
- [x] `src/main/ipc/providers.ts` 注册 handlers；login 事件经 webContents 推送
- [x] `src/preload/index.ts` 暴露 oauth 方法与 `onOauthLoginEvent` 订阅

## 3. spawn 链路
- [x] `src/main/services/agentHost.ts`：oauth provider 组装 SpawnModelConfig
- [x] `src/agent/supervisor.ts`：spawn / subagent 模型解析的 oauth 分支（getModel 直取，不注册、不注入 UA）

## 4. renderer
- [x] settings store：addProviders 指纹兼容 oauth 条目
- [x] 新建 `OauthProvidersDialog`（列表、登录进度、prompt 交互、入库/刷新 models、退出）
- [x] `ProvidersSettings` 增加入口按钮；OAuth 条目徽标展示
- [x] `ProviderEditDialog` 对 oauth 条目隐藏无关字段
- [x] i18n 中文文案

## 5. 验证
- [x] `pnpm typecheck`
- [ ] `pnpm dev` 手动冒烟：xai 登录全流程 → 建会话对话 → 退出登录（留待用户实测，OAuth 需真实账号交互）
- [x] 回归：API key provider 添加/编辑/spawn 不受影响

## 回滚点
每步独立 commit；出问题 revert 最近 commit 即可。
