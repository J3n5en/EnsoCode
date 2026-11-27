/**
 * 交给 agy 的 EnsoCode 自有系统提示词段。
 *
 * agy 有自己的系统提示词，pi 的整段系统提示词不发（开头角色段那类客户端身份句会被 Google 以 429 拒掉）。
 * 但 EnsoCode 经 pi 扩展追加的产品说明要让 agy 知道，只取这几段：
 * - `addendum`：appendSystemPrompt 汇总（workspace-policy、viz-guidance、subagent-contract、unattended、
 *   pi 的 APPEND_SYSTEM）；
 * - `preset_tail` / `preset_boost`：预设尾段（插件 systemPromptAppend 也合进 preset_tail）。
 * 其余 pi 段（preamble、tools、rules、docs、project_context、skills、cwd）和 Enso 的工具目录类段一律不取。
 */
const ADDENDUM = 'addendum';
const TAIL_SECTIONS = ['preset_tail', 'preset_boost'] as const;
/** agy 在 128 KiB 截断 prompt；这段放在 session 级 append 或首轮指令里，留足余量 */
export const AGY_SYSTEM_APPEND_MAX_BYTES = 16 * 1024;
const TRUNCATED = '[EnsoCode instructions truncated]';
/** 客户端身份句：不论出现在哪段，整行剥掉 */
const PI_IDENTITY = /running inside pi/i;

/** pi 按 `<name>\n…\n</name>` 渲染具名段，标签各占一行 */
function sectionBody(prompt: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\n)<${name}>\\n([\\s\\S]*?)\\n</${name}>(?=\\n|$)`);
  return pattern.exec(prompt)?.[1];
}

function withoutIdentity(text: string): string {
  return text
    .split('\n')
    .filter((line) => !PI_IDENTITY.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** 超出预算时按行截，末尾标明截断 */
function capped(text: string): string {
  if (bytes(text) <= AGY_SYSTEM_APPEND_MAX_BYTES) return text;
  const budget = AGY_SYSTEM_APPEND_MAX_BYTES - bytes(`\n${TRUNCATED}`);
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const cost = bytes(line) + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return kept.length > 0 ? `${kept.join('\n')}\n${TRUNCATED}` : TRUNCATED;
}

/** 从 pi 渲染出的当前系统提示词里取 EnsoCode 自有段；没有就返回空串 */
export function ensoSystemAppend(systemPrompt: string): string {
  const prompt = systemPrompt.replace(/\r\n/g, '\n');
  const parts: string[] = [];
  const addendum = withoutIdentity(sectionBody(prompt, ADDENDUM) ?? '');
  if (addendum) parts.push(addendum);
  for (const name of TAIL_SECTIONS) {
    const body = withoutIdentity(sectionBody(prompt, name) ?? '');
    if (body) parts.push(`<${name}>\n${body}\n</${name}>`);
  }
  return capped(parts.join('\n\n'));
}
