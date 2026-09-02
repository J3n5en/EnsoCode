# 分析 Cursor 与 Codex 浏览器调用实现

## 背景

Enso Code 已有通用 MCP 接入。本任务只做本机已装产品的架构调研，不改代码。

## 目标

搞清 Cursor 3.18.9 与 ChatGPT/Codex App（26.818.61809）如何把「浏览网页」交给 agent：宿主、协议、工具面、安全边界。

## 非目标

- 不实现 Enso 浏览器
- 不提取密钥、不写攻击/绕过
- 不复述整份专有源码

## 验收

- `research/browser-architecture.md` 覆盖：宿主进程、调用链、工具面、和 Enso 现有 MCP 的差异
