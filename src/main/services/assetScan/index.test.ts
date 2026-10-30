import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalAssetScanResult } from '@shared/types';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enso-agents-scan-')));
vi.stubEnv('HOME', home);
vi.stubEnv('USERPROFILE', home);

const { scanLocalAssets }: { scanLocalAssets: () => LocalAssetScanResult } = await import(
  './index'
);
vi.unstubAllEnvs();

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('scanLocalAssets · ~/.agents/skills', () => {
  it('扫描 ~/.agents/skills 并标来源 agents', () => {
    const skillDir = path.join(home, '.agents', 'skills', 'agents-home-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: agents-home-skill\ndescription: from agents home\n---\n\nbody\n'
    );

    const result = scanLocalAssets();
    const skill = result.candidates.find(
      (candidate) => candidate.kind === 'skill' && candidate.name === 'agents-home-skill'
    );
    expect(skill).toMatchObject({
      kind: 'skill',
      sourceId: 'agents',
      groupName: 'Agents (~/.agents)',
      name: 'agents-home-skill',
      description: 'from agents home',
      path: '~/.agents/skills/agents-home-skill',
    });
    expect(result.sources.find((source) => source.sourceId === 'agents')).toMatchObject({
      sourceName: 'Agents (~/.agents)',
      status: 'found',
      skillCount: 1,
      mcpCount: 0,
      instructionCount: 0,
    });
  });

  it('~/.agents/skills 不存在时不报错且该来源为空', () => {
    fs.rmSync(path.join(home, '.agents'), { recursive: true, force: true });
    const result = scanLocalAssets();
    expect(result.sources.find((source) => source.sourceId === 'agents')).toMatchObject({
      status: 'not-found',
      skillCount: 0,
      mcpCount: 0,
      instructionCount: 0,
    });
    expect(result.candidates.filter((candidate) => candidate.sourceId === 'agents')).toEqual([]);
  });
});
