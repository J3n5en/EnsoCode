# main 层规范（Electron 主进程）

`src/main/` 拥有全部特权能力：文件系统、其它应用的配置读取、网络请求、窗口管理。
渲染层的任何能力都必须经由 IPC 通道显式开放。

## 结构

```
src/main/
  index.ts              应用生命周期、单实例锁
  ipc/                  通道处理器，按域分文件
    index.ts            registerIpcHandlers() 统一注册
    settings.ts         settings.json 读写（含缓存与防抖）
    window.ts           窗口控制
    providers.ts        模型服务扫描 / 拉取模型 / 连通性测试 / OAuth 订阅登录
    assets.ts           技能 / MCP / 指令文件扫描与内容读写
  services/             纯逻辑，不碰 ipcMain
    providerScan/       locations.ts + readers.ts + index.ts
    assetScan/          skills / mcp / instructions / ccSwitch + index.ts
    providerApi.ts      按协议分派的模型 API 调用
    oauthProviders.ts   pi 内置 provider 的 OAuth 登录/退出/账户信息（Main 侧独立 runtime，与 agent worker 共享 auth.json）
    instructionStore.ts 指令文件本地副本存储
  windows/
    createAppWindow.ts  通用无边框窗口工厂
    MainWindow.ts       主窗口
    SettingsWindow.ts   设置窗口单例
```

**分层原则**：`ipc/` 只做参数校验和转发，业务逻辑一律在 `services/`。
services 不 import `ipcMain`，这样才能被单独调用和推理。
反例参照：`src/main/ipc/providers.ts` 的 handler 只有类型守卫加一行调用。

## Pre-Development Checklist

- [ ] 新能力真的需要主进程吗？渲染层能做的不要下沉。
- [ ] 新通道是否已在 `IPC_CHANNELS` 定义、在 `ipc/<域>.ts` 注册、在 preload 暴露？
- [ ] handler 是否对每个入参做了 `typeof` 校验？渲染层传来的一切都是 `unknown`。
- [ ] 是否会把明文密钥 / env 值返回给渲染层？必须脱敏，见 [services.md](services.md)。
- [ ] 涉及写文件：路径是否可控？是否有路径穿越风险？见 [services.md](services.md) 的"写入校验"。
- [ ] 读取外部应用配置：文件不存在 / 格式损坏 / 权限不足是否都不会让扫描整体失败？
- [ ] 改了主进程代码，dev 下需要**重启**才生效（渲染层才有 HMR）。

## 详细规范

- [ipc.md](ipc.md) —— 通道三点式链路、参数校验、preload 出口
- [services.md](services.md) —— 扫描器结构、敏感数据边界、去重身份
- [windows.md](windows.md) —— 多窗口、无边框标题栏、macOS 红绿灯
- [settings-persistence.md](settings-persistence.md) —— settings.json 缓存、防抖、原子写、多窗口广播
- [native-modules.md](native-modules.md) —— better-sqlite3 / level 与 pnpm 构建脚本
