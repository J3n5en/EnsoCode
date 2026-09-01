export interface EditBlock {
  oldText: string;
  newText: string;
}

export interface SessionChangeTool {
  path: string;
  edits: EditBlock[] | null;
  writeContent: string | null;
}

export interface SessionChangeFile {
  path: string;
  oldText: string;
  newText: string;
}

export function reconstructOld(current: string, blocks: EditBlock[]): string | null {
  let text = current;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { oldText, newText } = blocks[i];
    const idx = text.indexOf(newText);
    if (idx === -1) return null;
    text = text.slice(0, idx) + oldText + text.slice(idx + newText.length);
  }
  return text;
}

export function aggregateSessionChanges(input: {
  tools: SessionChangeTool[];
  snapshots: Record<string, string>;
  currentByPath: Record<string, string | null>;
}): { files: SessionChangeFile[]; snapshots: Record<string, string> } {
  const byPath = new Map<string, SessionChangeTool[]>();
  for (const tool of input.tools) {
    if (!tool.path) continue;
    const list = byPath.get(tool.path) ?? [];
    list.push(tool);
    byPath.set(tool.path, list);
  }

  const files: SessionChangeFile[] = [];
  const snapshots = { ...input.snapshots };

  for (const [path, tools] of byPath) {
    const current = input.currentByPath[path];
    const edits = tools.flatMap((tool) => tool.edits ?? []);
    const lastWrite = [...tools].reverse().find((tool) => tool.writeContent != null)?.writeContent;
    const snapshot = snapshots[path];

    let oldText: string | null = snapshot ?? null;
    const newText: string | null = typeof current === 'string' ? current : (lastWrite ?? null);

    if (oldText == null) {
      if (edits.length > 0 && typeof current === 'string') {
        oldText = reconstructOld(current, edits);
      } else if (lastWrite != null && edits.length === 0) {
        oldText = '';
      }
    }

    if (oldText == null || newText == null) continue;
    if (oldText === newText) continue;

    snapshots[path] = oldText;
    files.push({ path, oldText, newText });
  }

  return { files, snapshots };
}
