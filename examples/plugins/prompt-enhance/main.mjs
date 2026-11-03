// 不保存 BCE 地址与 token：复用用户在 EnsoCode 里配好的 bce-tool MCP，凭据只在宿主。
const ENHANCE_TIMEOUT_MS = 90_000;
const INDEX_TIMEOUT = 'Indexing timed out. Raise the call timeout of the bce-tool MCP server.';
const ENHANCE_TIMEOUT = `Enhancement timed out (${ENHANCE_TIMEOUT_MS / 1000}s). Start bce-tool with --no-webbrowser-enhance-prompt if a review page is blocking.`;

/** 有 enhance_prompt 的服务里选一个：配置指定 > 名字含 bce > 第一个 */
export function pickServer(tools, preferred) {
  const servers = [
    ...new Set(tools.filter((t) => t.name === 'enhance_prompt').map((t) => t.server)),
  ];
  if (servers.length === 0) return null;
  const server =
    (preferred && servers.find((s) => s === preferred)) ||
    servers.find((s) => s.toLowerCase().includes('bce')) ||
    servers[0];
  return {
    server,
    hasSearch: tools.some((t) => t.server === server && t.name === 'search_context'),
  };
}

/** 只对失败结果分类：成功文本里也可能出现这些字样 */
function classify(text) {
  const lower = text.toLowerCase();
  if (lower.includes('not managed by git') || lower.includes('not a git repository'))
    return 'not_git';
  if (
    lower.includes('too large to index') ||
    (lower.includes('exceeds the') && lower.includes('mb'))
  )
    return 'too_large';
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('aborted'))
    return 'timeout';
  return null;
}

const fail = (code, message) => ({ ok: false, code, message });
const isTimeout = (error) =>
  error?.code === 'TIMEOUT' ||
  error?.code === 'ABORTED' ||
  /timed? ?out|abort/i.test(String(error?.message));

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function enhance(enso, args, ctx) {
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return fail('empty_prompt', 'prompt is empty');
  if (!ctx.projectRoot) return fail('no_workspace', 'this session has no local project');

  const { server: preferred } = await enso.config.get();
  const picked = pickServer(await enso.mcp.tools(), preferred?.trim());
  if (!picked) return fail('mcp_missing', 'no MCP server provides enhance_prompt');

  let warning;
  if (picked.hasSearch) {
    try {
      const searched = await enso.mcp.call(picked.server, 'search_context', {
        project_root_path: ctx.projectRoot,
        query: prompt,
      });
      if (searched.isError) {
        const code = classify(searched.content);
        if (code === 'timeout') return fail('index_timeout', INDEX_TIMEOUT);
        return fail(code ?? 'index_failed', searched.content || 'search_context failed');
      }
    } catch (error) {
      if (isTimeout(error)) return fail('index_timeout', INDEX_TIMEOUT);
      return fail('index_failed', error?.message ?? String(error));
    }
  } else {
    warning = 'no_index';
  }

  let enhanced;
  try {
    enhanced = await withTimeout(
      enso.mcp.call(picked.server, 'enhance_prompt', {
        project_root_path: ctx.projectRoot,
        prompt,
        conversation_history: '',
      }),
      ENHANCE_TIMEOUT_MS
    );
  } catch (error) {
    if (isTimeout(error)) return fail('timeout', ENHANCE_TIMEOUT);
    return fail('upstream', error?.message ?? String(error));
  }
  const text = enhanced.content.trim();
  if (enhanced.isError) {
    const code = classify(text);
    if (code === 'timeout') return fail('timeout', ENHANCE_TIMEOUT);
    return fail(code ?? 'upstream', text || 'enhance_prompt failed');
  }
  if (!text) return fail('upstream', 'enhance_prompt returned empty text');
  return warning ? { ok: true, text, warning } : { ok: true, text };
}

/** @param {import('../../../types/enso-plugin').EnsoMain} enso */
export function activate(enso) {
  enso.renderer.handle('enhance', (args, ctx) => enhance(enso, args, ctx));
}
