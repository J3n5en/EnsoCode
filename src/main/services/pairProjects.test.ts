import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pairProjectReply } from './pairProjects';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'enso-pair-projects-')));
  mkdirSync(path.join(root, 'alpha'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pairProjectReply', () => {
  it('列 host 目录并原样回显 requestId', async () => {
    const reply = await pairProjectReply({ type: 'host-dirs', requestId: 'r1', path: root }, {});
    expect(reply).toEqual({
      type: 'host-dirs-result',
      requestId: 'r1',
      path: root,
      parent: path.dirname(root),
      dirs: ['alpha'],
    });
  });

  it('create 先建子目录再进入它，非法名回错误', async () => {
    const created = await pairProjectReply(
      { type: 'host-dirs', requestId: 'r2', path: root, create: 'beta' },
      {}
    );
    expect(created).toMatchObject({ requestId: 'r2', path: path.join(root, 'beta'), dirs: [] });
    const bad = await pairProjectReply(
      { type: 'host-dirs', requestId: 'r3', path: root, create: '../x' },
      {}
    );
    expect(bad).toEqual({
      type: 'host-dirs-result',
      requestId: 'r3',
      error: 'Invalid folder name.',
    });
  });

  it('project-add 交给权威注册表，失败与无注册表都回错误', async () => {
    const createProject = vi.fn(() => ({
      accepted: true as const,
      value: { projectId: 'p1' },
    }));
    expect(
      await pairProjectReply(
        { type: 'project-add', requestId: 'r4', path: root },
        { createProject }
      )
    ).toEqual({ type: 'project-add-result', requestId: 'r4', projectId: 'p1' });
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ path: root }));

    const rejected = await pairProjectReply(
      { type: 'project-add', requestId: 'r5', path: root },
      { createProject: () => ({ accepted: false as const, error: 'nope' }) }
    );
    expect(rejected).toEqual({ type: 'project-add-result', requestId: 'r5', error: 'nope' });
    expect(
      await pairProjectReply({ type: 'project-add', requestId: 'r6', path: root }, {})
    ).toMatchObject({ requestId: 'r6', error: expect.any(String) });
  });
});
