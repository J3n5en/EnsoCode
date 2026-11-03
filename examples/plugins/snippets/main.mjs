import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULTS = [
  {
    id: 'review',
    label: 'review',
    text: '请审查上面的改动：找出正确性问题、边界情况和遗漏的测试，按严重程度排序。',
  },
  { id: 'explain', label: 'explain', text: '用三到五句话解释这段代码做了什么，以及为什么这样写。' },
  {
    id: 'tests',
    label: 'tests',
    text: '为这次改动补充单元测试，先写会失败的测试，再给出最小实现。',
  },
  {
    id: 'commit',
    label: 'commit',
    text: '根据当前改动写一条提交信息：一行摘要 + 简短正文，说明动机。',
  },
];

/** 用户可以编辑数据目录里的 snippets.json 增删片段 */
async function loadSnippets(dataDir) {
  const file = join(dataDir, 'snippets.json');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(parsed))
      return parsed.filter((s) => s && typeof s.id === 'string' && typeof s.text === 'string');
  } catch {
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
  }
  return DEFAULTS;
}

const pad = (n) => String(n).padStart(2, '0');

/** @param {import('../../../types/enso-plugin').EnsoMain} enso */
export function activate(enso) {
  enso.triggers.register('snippet', {
    async candidates(query) {
      const q = query.toLowerCase();
      const snippets = await loadSnippets(enso.dataDir);
      return snippets
        .filter((s) => (s.label ?? s.id).toLowerCase().includes(q))
        .map((s) => ({ id: s.id, label: s.label ?? s.id, detail: s.text }));
    },
    async pick(item) {
      const snippets = await loadSnippets(enso.dataDir);
      return { text: snippets.find((s) => s.id === item?.id)?.text ?? '' };
    },
  });

  enso.renderer.handle('insertTimestamp', async () => {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    await enso.composer.insertText({ text: `[${stamp}] ` });
  });

  /** 把一条回复以 Markdown 引用的形式接到草稿末尾；草稿里有文件引用时只追加，不整体替换 */
  enso.renderer.handle('quote', async (args) => {
    const quoted = String(args?.text ?? '')
      .trim()
      .split('\n')
      .slice(0, 40)
      .map((line) => `> ${line}`)
      .join('\n');
    if (!quoted) return;
    const draft = await enso.composer.readDraft();
    if (draft.hasReferences) {
      await enso.composer.insertText({ text: `\n${quoted}\n\n` });
      return;
    }
    const text = draft.text.trim() ? `${draft.text.trimEnd()}\n\n${quoted}\n\n` : `${quoted}\n\n`;
    await enso.composer.replaceDraft({
      text,
      expect: { generation: draft.generation, rev: draft.rev },
    });
  });
}
