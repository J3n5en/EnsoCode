# xAI 专用补空泄漏到 Kimi：历史无空文本，请求却返回 400

## 症状

Kimi `openai-responses` reviewer 能完成首轮推理和工具调用，却在工具结果后的续轮返回：

```text
Invalid request: text content is empty
```

会话 JSONL 中的前一条 assistant 只有带签名的 thinking 和 toolCall，没有空文本；
toolResult 也有非空文本。直接把 JSONL 送入 Pi serializer 离线重放，看不到空字段。
降低 thinking、换 reviewer 身份、清理工具结果大小都没有解释该差异。

## 根因

`imageContext.ts` 的通用 context hook 曾无条件执行 `ensureTextBeforeToolCalls`：
当 assistant 有字符串形式的 thinkingSignature、有 toolCall、没有 text 时，
在第一个 toolCall 前插入 `{ type: 'text', text: '' }`。
这原是 xAI Responses 的兼容处理，却没有限定目标 API 或模型。

Pi 的 context hook 操作历史的克隆，因此该空文本不写回 JSONL；
随后 Responses serializer 将它编码成 assistant `output_text.text === ''`。
只重放持久化消息、绕过应用 context hook，会漏掉真正产生问题的变换。

使用安装应用自带的 Electron 和 Pi 1.4.0，加载项目真实清洗模块，
对同一份合成的 signed-thinking / toolCall / 非空 toolResult 历史进行单变量对照：

| 路径 | 最终请求结构 | 结果 |
| --- | --- | --- |
| 现有通用清洗含厂商补空 | `$.input[2].content[0].text === ''` | HTTP 400，同历史错误 |
| 相同历史，不执行厂商补空 | 无空字符串字段；工具调用及结果仍配对 | HTTP 200，正常结束 |

这证明错误来自应用的出站 context 变换，不是 SDK 凭空生成内容或由 JSONL 缺失工具文本造成。
对照只发送合成内容，不发送用户历史、真实思考或签名原文。

另经隔离 Electron 的真实 Main / preload / worker 链验证：安装包 Kimi reviewer
自主读文件后的续轮返回 400，请求出现空 assistant output_text；只切换候选 worker 后，
同类 read 续轮没有该项且返回 200。父模型自主 subagent spawn / report、子 reviewer
读文件及父模型继续执行的一批 7 次请求也均为 200。
该验证覆盖真实 Main / preload / worker 工具链，不以 SDK 直调代替完整应用验收。

候选 Electron 的 Grok `grok-4.7` reviewer 自主 read / 工具结果续轮亦为两次 200；
实发 `reasoning.effort` 与子会话档位均为 `xhigh`，工具配对正常并以 `stop` 结束。
该轮已有非空 assistant text；触发补空的 Grok 正例另由真实 serializer 测试和
安装 SDK 的在线合成回归覆盖，不把不同验证层混为一谈。

## 修法

- 通用 `sanitizeContextMessages` 只处理孤儿工具结果、历史图片占位和残缺工具文本；
  不再给 assistant 注入厂商专用文本。
- `modelContextCompat.ts` 在共享 runtime 的 `stream` / `streamSimple` 出口，
  仅对目标 API 为 `openai-responses` 的 Grok 对话模型保留原补空兼容。
- 按本次请求实际解析出的物理模型判断，不按历史消息的来源模型、provider 指纹或
  context hook 的虚拟模型名判断；虚拟路由先透传，递归到物理模型后才处理。
- 只复制确实变化的容器，不修改原签名、工具配对、已有文本或权威历史；
  缺失或非数组的旧 assistant content 原样交给下游，保留 SDK 的容错行为。
- 不清理原本存在的空文本、不 trim 空白、不删 reasoning、不迁移 JSONL，
  不修改用户模型配置，也不为此冻结或替换上游 SDK 依赖。

实例出口包装沿用隐私脱敏模块的模式。Pi 1.4 的 `complete(Simple)` 动态调用
`this.stream(Simple)`，虚拟模型的 `streamSimple` 也递归调用物理出口；
升级 Pi 后须重新核对这一派发契约及包装顺序。

## 回归防线

- 通用清洗保留无文本的 signed-thinking / toolCall 历史，不影响其它清洗职责。
- 真实 ModelRuntime、真实 Responses serializer 和 fake transport 检查最终请求，
  覆盖 Kimi、Grok、raw/simple/complete/completeSimple 以及虚拟模型的物理路由，
  验证工具配对和签名保持。
- installer 单测覆盖模型 ID / API 正反例、切模型、已有文本、缺失 content、
  必要层复制、不可变输入、this / options / stream 透传及重复安装。
- SDK / API 对照不等同完整应用验收；另需在独立 userData、独立 CDP 端口中验证
  Electron reviewer 多轮工具链，并验证另一厂商不退化。
- 打包版忽略 `ENSO_USER_DATA_DIR`；不能直接启动安装二进制并假设已经隔离。
  验证 host 必须先证明 userData、监听 PID 和实际 worker 路径独立于用户实例。

## 相关代码

- `src/agent/imageContext.ts`
- `src/agent/modelContextCompat.ts`
- `src/agent/supervisor.ts`：`initializeWorkerRuntime`
- `src/agent/imageContext.test.ts`
- `src/agent/modelContextCompat.test.ts`
- `src/agent/supervisor.modelContextCompat.test.ts`
- `src/agent/privacyMask/runtime.ts`：既有 runtime 出口包装模式
