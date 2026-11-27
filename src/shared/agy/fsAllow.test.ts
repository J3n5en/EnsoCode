import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsReadAllowed } from './fsAllow';

describe('fsReadAllowed', () => {
  it('allows a file under the session cwd or an attachment root, and rejects the rest', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agy-fs-'));
    const cwd = path.join(root, 'work');
    const attachments = path.join(root, 'attachments');
    const outside = path.join(root, 'outside');
    mkdirSync(cwd);
    mkdirSync(attachments);
    mkdirSync(outside);
    const inside = path.join(cwd, 'a.ts');
    writeFileSync(inside, 'x');
    const linked = path.join(cwd, 'escape');
    symlinkSync(outside, linked);
    expect(fsReadAllowed(inside, [cwd, attachments])).toBe(true);
    expect(fsReadAllowed(path.join(attachments, 'shot.png'), [cwd, attachments])).toBe(true);
    expect(fsReadAllowed(path.join(outside, 'secret'), [cwd, attachments])).toBe(false);
    expect(fsReadAllowed(path.join(linked, 'secret'), [cwd, attachments])).toBe(false);
    expect(fsReadAllowed(path.join(cwd, '..', 'outside', 'secret'), [cwd, attachments])).toBe(
      false
    );
  });
});
