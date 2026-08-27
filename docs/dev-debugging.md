# 开发调试：CDP 连接 renderer

给人看的入口。Agent 验证 UI / 往 composer 发消息 / 读对话状态时加载项目 skill：

`.agents/skills/enso-cdp/SKILL.md`

开发环境（`!app.isPackaged`）在 `src/main/index.ts` 开放端口 **9222**（打包后不开）。取 page 的 WebSocket、受控 textarea 发送、读 `innerText` 尾部、main/agent 不热更等步骤以该 skill 为准，不要在别处再抄一份。
