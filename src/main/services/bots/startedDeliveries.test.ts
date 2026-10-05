import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StartedDeliveryIndex } from './startedDeliveries';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'started-'));
  file = join(dir, 'session.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (text: string, role = 'user') =>
  `${JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } })}\n`;
const result = (id: string) =>
  line(`<delegation-result id="${id}" from="Bob">done</delegation-result>`);

describe('StartedDeliveryIndex', () => {
  it('finds persisted delegation results, including batches and notes prefix', () => {
    writeFileSync(
      file,
      line('hello') +
        result('d1') +
        line(
          '<delegation-results id="b1">\n<delegation-result id="x">ok</delegation-result>\n</delegation-results>'
        ) +
        line(
          '<notes-updated>\nn\n</notes-updated>\n\n<delegation-result id="d2">ok</delegation-result>'
        ) +
        line('<delegation-result id="assistant">x</delegation-result>', 'assistant') +
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: '<delegation-result id="s1">' },
        })
    );
    const index = new StartedDeliveryIndex();
    for (const id of ['d1', 'b1', 'd2', 's1']) expect(index.has(file, id)).toBe(true);
    for (const id of ['x', 'assistant', 'absent']) expect(index.has(file, id)).toBe(false);
  });

  it('picks up appended lines incrementally and tolerates a torn tail', () => {
    writeFileSync(file, line('hello'));
    const index = new StartedDeliveryIndex();
    expect(index.has(file, 'd1')).toBe(false);
    const full = result('d1');
    appendFileSync(file, full.slice(0, 30));
    expect(index.has(file, 'd1')).toBe(false);
    appendFileSync(file, full.slice(30));
    expect(index.has(file, 'd1')).toBe(true);
    appendFileSync(file, result('d2'));
    expect(index.has(file, 'd2')).toBe(true);
  });

  it('rescans when the file is replaced', () => {
    writeFileSync(file, result('old'));
    const index = new StartedDeliveryIndex();
    expect(index.has(file, 'old')).toBe(true);
    const next = join(dir, 'next.jsonl');
    writeFileSync(next, result('new'));
    renameSync(next, file);
    expect(index.has(file, 'new')).toBe(true);
    expect(index.has(file, 'old')).toBe(false);
    expect(index.has(join(dir, 'missing.jsonl'), 'new')).toBe(false);
  });

  it('a fresh index after restart sees everything persisted before the crash', () => {
    writeFileSync(file, line('a').repeat(10) + result('before-crash'));
    expect(new StartedDeliveryIndex().has(file, 'before-crash')).toBe(true);
  });

  it('only reads appended bytes after the first scan', () => {
    const filler = line('x'.repeat(400));
    writeFileSync(file, filler.repeat(20_000));
    const index = new StartedDeliveryIndex();
    expect(index.has(file, 'none')).toBe(false);
    // 原地改写已扫描过的区域（inode、大小不变）：只读追加部分的实现不会再看到它
    let early = '';
    for (let pad = 0; Buffer.byteLength(early) !== Buffer.byteLength(filler); pad++)
      early = line(`<delegation-result id="early">${'y'.repeat(pad)}`);
    const fd = openSync(file, 'r+');
    writeSync(fd, early, 0);
    closeSync(fd);
    expect(index.has(file, 'early')).toBe(false);
    expect(new StartedDeliveryIndex().has(file, 'early')).toBe(true);
    const started = performance.now();
    for (let i = 0; i < 200; i++) {
      appendFileSync(file, line(`turn ${i}`));
      expect(index.has(file, `none-${i}`)).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
