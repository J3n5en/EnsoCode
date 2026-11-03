// 主界面渲染模块：工具结果卡片 + ```enso.example.wordstats:bars 代码块

const box = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 10px',
  margin: '4px 0',
  fontSize: 12,
};

/** "label: 数值" 每行一条 */
function parsePairs(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(.+?)\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (match) rows.push({ label: match[1], value: Number(match[2]) });
  }
  return rows;
}

/** @param {import('../../../types/enso-plugin').EnsoUi} enso */
export function onLoad(enso) {
  const h = enso.React.createElement;

  function Bars({ rows }) {
    const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
    return h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr max-content',
          gap: '4px 8px',
          alignItems: 'center',
        },
      },
      ...rows.flatMap((row) => [
        h(
          'span',
          { key: `${row.label}-l`, style: { color: 'var(--muted-foreground)' } },
          row.label
        ),
        h(
          'div',
          {
            key: `${row.label}-b`,
            style: { height: 8, borderRadius: 4, background: 'var(--muted)' },
          },
          h('div', {
            style: {
              width: `${(Math.abs(row.value) / max) * 100}%`,
              height: '100%',
              borderRadius: 4,
              background: 'var(--brand, var(--primary))',
            },
          })
        ),
        h(
          'span',
          { key: `${row.label}-v`, style: { fontVariantNumeric: 'tabular-nums' } },
          String(row.value)
        ),
      ])
    );
  }

  enso.slots.register({
    slot: 'tool.card',
    toolName: 'count_words',
    component: ({ output, state }) => {
      if (state !== 'ok' || !output) return null;
      const [summary, ...rest] = String(output).split('\n');
      const rows = parsePairs(rest.join('\n'));
      return h(
        'div',
        { style: box },
        h('div', { style: { fontWeight: 600, marginBottom: rows.length ? 6 : 0 } }, summary),
        rows.length ? h(Bars, { rows }) : null
      );
    },
  });

  enso.slots.register({
    slot: 'block',
    language: 'bars',
    component: ({ source }) => {
      const rows = parsePairs(source);
      if (rows.length === 0) return h('pre', { style: box }, source);
      return h('div', { style: box }, h(Bars, { rows }));
    },
  });
}
