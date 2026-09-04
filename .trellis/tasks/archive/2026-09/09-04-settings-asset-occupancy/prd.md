# Settings 显示 Skill / MCP / 内置工具 / Instructions 的上下文占用

## Goal

设置窗口里，Skill、MCP、内置工具、Instructions 每一行都能看到该项大约会占多少上下文 token。数字与对话占用拆账同一套估算，方便开关前知道代价。

## Requirements

- Skills / MCP / Built-in tools / Instruction Files 四类列表：每行显示估算 token；表头显示**已启用**合计。
- Skills：已登记项都估算（关掉也能看到打开后的代价）。内容读该 skill 目录下的 `SKILL.md`。
- MCP：打开 MCP 分类时探测**已启用** server（connect → `listTools` → 估算 → **立刻断开**）。未启用显示 `—`；刚打开的开关立刻探测该项。
- Built-in tools：对应设置页现有 6 个开关（subagent / coworker / todo / ask_user / browser / background_tasks）。每行是该开关会注入的**全部** tool schema 合计（例如 browser = 所有 `browser_*`）。不新增 read/grep/bash/edit/write 行（那些不能关、也不在此页）。
- Instructions：每行按文件正文估算；与会话 `instructions` 桶一致。已有的字节展示可保留。
- 文件缺失、MCP 超时/失败：该行失败可见，其它行不受影响。
- 公式与会话占用一致：`ceil(chars / 4)`；skill = `name + description + content`；tool = `name + description + JSON.stringify(parameters)`；instruction = 文件正文。
- 占用数字不写入 `settings.json`。
- 文案走 `t()`；数字用现有 `formatTokens`。

## Out of scope

- 对话 Context Inspector 再拆到每个 skill / MCP / 单工具。
- MCP 行内展开每个 tool。
- 探测未启用的 MCP。
- 设置里为始终开启的 read/grep/find/ls/bash/edit/write 加新行。
- goal 工具（设置页没有对应开关）。

## Acceptance Criteria

- [ ] Skills：每行 token 或 `—`；已启用合计 = 已启用各行之和。
- [ ] MCP：进入分类后已启用项探测并显示 token；未启用为 `—`；探测后断开连接。
- [ ] Built-in tools：6 个开关各有 token；关掉的仍显示数字（不探测外部进程）；已启用合计随开关变。
- [ ] Instructions：每行 token 或 `—`；已启用合计正确。
- [ ] 单 MCP 失败不影响其它行。
- [ ] IPC 只传 id，不传文件系统路径，不把 tool schema / 文件正文回给渲染层。
- [ ] 估算纯函数单测覆盖 skill / tool / instruction 文本；脏输入不崩。
- [ ] 不改 `settings.json` schema。

## Notes

- 用户选择：MCP 打开设置时探测已启用 server。
- 用户追加：内置工具和 Instructions 也要显示。
