export interface SubagentNotice {
  header: string;
  report: string;
  usage: { tokens: number; toolUses: number; durationMs: number } | null;
}

/** 与 Main completionText 的格式对应 */
const HEADER = /^Subagent ".*" \(agentId [^,\s]+, runId [^)\s]+\) \S+ after .+\.$/gm;
const PREAMBLE = /^The following is the subagent's report: .*$\n?/m;
const USAGE = /<usage>([\s\S]*?)<\/usage>/;

const usageField = (raw: string, key: string): number | null => {
  const m = new RegExp(`^${key}: (\\d+)$`, 'm').exec(raw);
  return m ? Number(m[1]) : null;
};

function parseNotice(chunk: string): SubagentNotice {
  const nl = chunk.indexOf('\n');
  const header = nl < 0 ? chunk : chunk.slice(0, nl);
  let rest = nl < 0 ? '' : chunk.slice(nl + 1);
  let usage: SubagentNotice['usage'] = null;
  const u = USAGE.exec(rest);
  if (u) {
    // usage 之后只剩写给模型的 report / send 提示
    rest = rest.slice(0, u.index);
    const tokens = usageField(u[1], 'subagent_tokens');
    const toolUses = usageField(u[1], 'tool_uses');
    const durationMs = usageField(u[1], 'duration_ms');
    if (tokens !== null && toolUses !== null && durationMs !== null)
      usage = { tokens, toolUses, durationMs };
  }
  return { header, report: rest.replace(PREAMBLE, '').trim(), usage };
}

/** 子代理完成通知（可能多条合批）→ 结构化视图；对不上格式返回 null */
export function parseAgentNotification(body: string): SubagentNotice[] | null {
  const text = body.trim();
  const starts = [...text.matchAll(HEADER)].map((m) => m.index);
  if (starts[0] !== 0) return null;
  return starts.map((start, i) =>
    parseNotice(
      text
        .slice(start, starts[i + 1])
        .replace(/\n+---\s*$/, '')
        .trim()
    )
  );
}
