// 开发机的 shell 可能带着应用注入的目录缓存（agentHost 把它传给 worker），
// 单测读到真实 models.dev 数据就会随本机状态飘（例如 claude-sonnet-4 的窗口）。
// 统一清掉；需要目录数据的用例自己显式设置。
delete process.env.ENSO_MODELS_DEV_CACHE;
