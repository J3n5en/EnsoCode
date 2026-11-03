const WORD = /[\p{L}\p{N}_'-]+/gu;

export function analyze(text, top = 5) {
  const words = text.match(WORD) ?? [];
  const counts = new Map();
  for (const word of words) {
    const key = word.toLowerCase();
    if (key.length < 2) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const frequent = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([word, count]) => ({ word, count }));
  return {
    words: words.length,
    lines: text === '' ? 0 : text.split(/\r?\n/).length,
    chars: [...text].length,
    frequent,
  };
}

/** @param {import('../../../types/enso-plugin').EnsoMain} enso */
export function activate(enso) {
  enso.tools.register('count_words', async (args) => {
    const path = String(args.path ?? '');
    const top = Math.min(20, Math.max(1, Number(args.top) || 5));
    const stats = analyze(await enso.fs.readText(path), top);
    const lines = [
      `${path}: ${stats.words} words, ${stats.lines} lines, ${stats.chars} characters`,
      ...stats.frequent.map(({ word, count }) => `${word}: ${count}`),
    ];
    return { content: lines.join('\n'), details: { path, ...stats } };
  });
}
