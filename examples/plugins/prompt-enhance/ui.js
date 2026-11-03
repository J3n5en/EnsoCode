const MESSAGES = {
  empty_prompt: '先在输入框里写点内容',
  no_workspace: '当前会话没有本机项目，无法索引',
  mcp_missing: '没找到提供 enhance_prompt 的 MCP，先在设置里添加 bce-tool',
  not_git: '不是 Git 仓库：给 bce-tool 加 --allow-non-git',
  too_large: '项目太大，用 .gitignore / .bceignore 缩小范围',
  index_failed: '索引失败',
  index_timeout: '索引超时：调高 bce-tool 的调用超时',
  timeout: '增强超时：确认 bce-tool 带了 --no-webbrowser-enhance-prompt',
  upstream: '增强失败',
  NO_SESSION: '当前没有会话',
  NO_COMPOSER: '输入框不在前台',
  DRAFT_CHANGED: '增强期间草稿被改过，没有替换',
  DRAFT_HAS_REFERENCES: '草稿里有文件或会话引用，不能整体替换',
  DRAFT_BUSY: '输入框正在输入，稍后再试',
};

const messageOf = (code, fallback) => MESSAGES[code] ?? fallback ?? MESSAGES.upstream;

/** 读草稿 → 后端增强 → 按读取时的版本替换；草稿期间被改过就放弃，不覆盖用户的输入 */
export async function enhanceDraft(enso, sessionId) {
  let snap;
  try {
    snap = await enso.composer.readDraft();
  } catch (error) {
    return { ok: false, message: messageOf(error.code, error.message) };
  }
  const prompt = snap.text.trim();
  if (!prompt) return { ok: false, message: MESSAGES.empty_prompt };
  let result;
  try {
    result = await enso.dispatch('plugin.call', { method: 'enhance', args: { prompt } });
  } catch (error) {
    return { ok: false, message: error.message || MESSAGES.upstream };
  }
  if (!result?.ok) return { ok: false, message: messageOf(result?.code, result?.message) };
  try {
    await enso.composer.replaceDraft({
      text: result.text,
      expect: { generation: snap.generation, rev: snap.rev },
    });
  } catch (error) {
    return { ok: false, message: messageOf(error.code, error.message) };
  }
  return {
    ok: true,
    sessionId,
    original: snap.text,
    enhanced: result.text,
    warning: result.warning,
  };
}

const STYLE = `
.enso-bce { display: inline-flex; align-items: center; gap: 6px; }
.enso-bce-btn { position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 6px; background: transparent;
  color: var(--muted-foreground); cursor: pointer; }
.enso-bce-btn:hover:not(:disabled) { background: var(--accent); color: var(--foreground); }
.enso-bce-btn:disabled { opacity: .4; cursor: default; }
.enso-bce-btn[data-busy="true"] { opacity: 1; color: var(--primary); }
.enso-bce-btn[data-busy="true"]::after { content: ''; position: absolute; inset: 0; border-radius: 6px;
  border: 1.5px solid transparent; border-top-color: var(--primary); animation: enso-bce-spin .9s linear infinite; }
@keyframes enso-bce-spin { to { transform: rotate(360deg); } }
.enso-bce-status { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
.enso-bce-status[data-level="error"] { color: var(--destructive); }
.enso-bce-restore { border: none; background: transparent; padding: 0; font-size: 12px;
  color: var(--muted-foreground); text-decoration: underline; cursor: pointer; }
`;

/** @param {import('../../../types/enso-plugin').EnsoUi} enso */
export function onLoad(enso) {
  const { React } = enso;
  const h = React.createElement;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  let restore = null;
  const listeners = new Set();
  const setRestore = (next) => {
    restore = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const wand = h(
    'svg',
    {
      width: 15,
      height: 15,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('path', {
      d: 'm21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72',
    }),
    h('path', { d: 'm14 7 3 3' }),
    h('path', { d: 'M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9' })
  );

  function EnhanceButton({ sessionId, draft, busy }) {
    const [running, setRunning] = React.useState(false);
    const [status, setStatus] = React.useState({ level: 'idle', text: '' });
    const snap = React.useSyncExternalStore(subscribe, () => restore);

    React.useEffect(() => {
      if (status.level !== 'ok') return;
      const timer = setTimeout(() => setStatus({ level: 'idle', text: '' }), 3500);
      return () => clearTimeout(timer);
    }, [status.level]);

    const empty = draft.trim().length === 0;
    const disabled = running || empty || busy || !sessionId;
    const title = empty ? MESSAGES.empty_prompt : status.text || '增强提示词';

    const onClick = async () => {
      if (disabled) return;
      setRunning(true);
      setStatus({ level: 'busy', text: '正在增强提示词…' });
      const result = await enhanceDraft(enso, sessionId);
      setRunning(false);
      if (!result.ok) {
        setStatus({ level: 'error', text: result.message });
        return;
      }
      // 连续增强时保留最初的原文
      const original =
        restore && restore.sessionId === sessionId && restore.enhanced === result.original
          ? restore.original
          : result.original;
      setRestore({ sessionId, original, enhanced: result.enhanced });
      setStatus({
        level: 'ok',
        text: result.warning === 'no_index' ? '已增强（没有索引工具）' : '已增强',
      });
    };

    const onRestore = async () => {
      if (!snap) return;
      try {
        await enso.composer.replaceDraft({ text: snap.original });
        setRestore(null);
        setStatus({ level: 'idle', text: '' });
      } catch (error) {
        setStatus({ level: 'error', text: messageOf(error.code, error.message) });
      }
    };

    const canRestore =
      !running && snap !== null && snap.sessionId === sessionId && draft !== snap.original;

    return h(
      'span',
      { className: 'enso-bce' },
      h(
        'button',
        {
          type: 'button',
          className: 'enso-bce-btn',
          'data-busy': running ? 'true' : 'false',
          'aria-busy': running,
          'aria-label': title,
          title,
          disabled,
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => void onClick(),
        },
        wand
      ),
      status.text
        ? h('span', { className: 'enso-bce-status', 'data-level': status.level }, status.text)
        : null,
      canRestore
        ? h(
            'button',
            {
              type: 'button',
              className: 'enso-bce-restore',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => void onRestore(),
            },
            '恢复原文'
          )
        : null
    );
  }

  enso.slots.register({ slot: 'composer.left', component: EnhanceButton });
  return () => style.remove();
}
