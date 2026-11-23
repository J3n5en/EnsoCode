/**
 * 拼装待办派发的首条消息：以秘书传入的 prompt 为准，不注入默认推送或合并约束。
 * 传入 prompt 且未包含待办原文时，在末尾以「待办原文（背景）」附带原文。
 */
export function todoDispatchPrompt(todoText: string, explicitPrompt?: string): string {
  const todo = todoText.trim();
  const prompt = explicitPrompt?.trim() ?? '';
  if (!prompt) return todo;
  if (!todo || prompt.includes(todo)) return prompt;
  return `${prompt}\n\n待办原文（背景）：\n${todo}`;
}
