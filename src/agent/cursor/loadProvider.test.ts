import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCursorProvider, resetCursorProviderLoadForTests } from './loadProvider';

describe('loadCursorProvider', () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetCursorProviderLoadForTests();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('worker/OAuth 同一套 load：cursor 出现在 OAuth 列表且 getModel 可离线解析', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-cursor-'));
    dirs.push(tmp);
    process.env.PI_OFFLINE = '1';
    process.env.PI_CURSOR_SYSTEM_CREDENTIALS = '0';
    const runtime = await ModelRuntime.create({
      authPath: path.join(tmp, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await loadCursorProvider(runtime);
    const provider = runtime.getProvider('cursor');
    expect(provider).toBeTruthy();
    expect(provider?.id).toBe('cursor');
    expect(provider?.auth.oauth).toBeTruthy();
    const listed = provider?.getModels() ?? runtime.getModels('cursor');
    expect(listed.length).toBeGreaterThan(0);
    const modelId = listed[0]?.id;
    expect(modelId).toBeTruthy();
    const model = runtime.getModel('cursor', modelId as string);
    expect(model).toBeTruthy();
    expect(model?.provider).toBe('cursor');
  });
});
