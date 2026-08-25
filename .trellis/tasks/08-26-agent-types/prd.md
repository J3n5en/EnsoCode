# PRD: 自定义 subagent 类型

## 需求(用户选定「完全自定义」+ 3+1 形态)

1. **类型定义**(设置页新增「子代理」板块,CRUD,存 settings):
   - `AgentTypeEntry { id, name(slug,工具参数用), description(模型选型依据), systemPrompt, providerId?/modelId?(缺省=跟随会话), tools: 'all' | 'readonly' }`
2. **工具参数**:`subagent(agent_type?, description, prompt)`;`agent_type` 缺省 = 跟随父会话(通用);工具 description **动态列出**已配置类型(`name — description (model)`),模型按任务性质自选。
3. **执行**:命中类型时子会话使用该类型的模型(可跨 provider,main 补 apiKey 经 spawn 下发)、systemPrompt(前置进 prompt,pi 无会话级 systemPrompt 选项)、工具集(readonly=仅 read+内置 grep/find/ls,无 bash/edit/write/MCP)。
4. **展示**:状态行/浮层显示类型名与实际模型。

## 验收

- 设置页建「scout(只读, 低价模型)」类型 → 会话里 agent 用 `agent_type:"scout"` 派发 → 子代理用指定模型跑、无写工具;未配置类型时工具仍可用(仅 general)。全绿+实测。
