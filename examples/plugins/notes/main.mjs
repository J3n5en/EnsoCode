import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_NOTES = 200;
const MAX_TEXT = 8000;

/** @param {import('../../../types/enso-plugin').EnsoMain} enso */
export function activate(enso) {
  const file = join(enso.dataDir, 'notes.json');

  const load = async () => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const save = async (notes) => {
    await mkdir(enso.dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(notes, null, 2));
    await rename(tmp, file);
  };
  const text = (value) => String(value ?? '').slice(0, MAX_TEXT);

  enso.renderer.handle('list', load);

  enso.renderer.handle('add', async (args) => {
    const body = text(args?.text).trim();
    if (!body) return load();
    const notes = [{ id: randomUUID(), text: body, at: Date.now() }, ...(await load())].slice(
      0,
      MAX_NOTES
    );
    await save(notes);
    return notes;
  });

  enso.renderer.handle('remove', async (args) => {
    const notes = (await load()).filter((n) => n.id !== args?.id);
    await save(notes);
    return notes;
  });

  enso.renderer.handle('insert', async (args) => {
    const note = (await load()).find((n) => n.id === args?.id);
    if (note) await enso.composer.insertText({ text: note.text });
  });
}
