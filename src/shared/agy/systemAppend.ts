/**
 * 交给 agy 的 EnsoCode 自有系统提示词段。
 *
 * agy 有自己的系统提示词，pi 的整段系统提示词不发（开头角色段那类客户端身份句会被 Google 以 429 拒掉）。
 * 但 EnsoCode 经 pi 扩展追加的产品说明要让 agy 知道，只取这几段：
 * - `addendum`：appendSystemPrompt 汇总（workspace-policy、viz-guidance、subagent-contract、unattended、
 *   pi 的 APPEND_SYSTEM）；
 * - `preset_tail` / `preset_boost`：预设尾段（插件 systemPromptAppend 也合进 preset_tail）。
 * 其余 pi 段（preamble、tools、rules、docs、project_context、skills、cwd）和 Enso 的工具目录类段一律不取。
 *
 * 秘书 / Bot 的人设由 personaExtension 换进 pi 的开头角色段，那里不带标签，上面的取段认不出来；
 * 它由调用方从人设本身传进来，作为 `<role>` 段放在最前。
 */
const ADDENDUM = 'addendum';
const TAIL_SECTIONS = ['preset_tail', 'preset_boost'] as const;
/**
 * agy 在 128 KiB 截断 prompt；这段放在 session 级 append 或首轮指令里，留足余量。
 * 秘书规则约 27 KB，加上约 4 KB 的 addendum 要能整段放下，再给人设留些余地。
 */
export const AGY_SYSTEM_APPEND_MAX_BYTES = 40 * 1024;
/** role 以外的 Enso 段（addendum、预设尾段）最多这么多；没有 role 的会话就是原来的 16 KiB 上限 */
export const AGY_ENSO_SECTIONS_MAX_BYTES = 16 * 1024;
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

/** 超出预算时按行截，末尾标明截断。各段按优先级排好再传进来，截掉的总是排在后面的段 */
function capped(text: string, limit: number): string {
  if (bytes(text) <= limit) return text;
  const budget = limit - bytes(`\n${TRUNCATED}`);
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

/**
 * 从 pi 渲染出的当前系统提示词里取 EnsoCode 自有段；没有就返回空串。
 * role 是会话的人设（秘书规则等），优先级最高：整段保留，从不截断，其余段在剩下的预算里按顺序让位。
 */
export function ensoSystemAppend(systemPrompt: string, role = ''): string {
  const prompt = systemPrompt.replace(/\r\n/g, '\n');
  const parts: string[] = [];
  const addendum = withoutIdentity(sectionBody(prompt, ADDENDUM) ?? '');
  if (addendum) parts.push(addendum);
  for (const name of TAIL_SECTIONS) {
    const body = withoutIdentity(sectionBody(prompt, name) ?? '');
    if (body) parts.push(`<${name}>\n${body}\n</${name}>`);
  }
  const rest = parts.join('\n\n');
  const lead = withoutIdentity(role.replace(/\r\n/g, '\n'));
  if (!lead) return capped(rest, AGY_ENSO_SECTIONS_MAX_BYTES);
  const pinned = `<role>\n${lead}\n</role>`;
  if (!rest) return pinned;
  const room = Math.min(
    AGY_ENSO_SECTIONS_MAX_BYTES,
    AGY_SYSTEM_APPEND_MAX_BYTES - bytes(pinned) - 2
  );
  return `${pinned}\n\n${capped(rest, room)}`;
}
