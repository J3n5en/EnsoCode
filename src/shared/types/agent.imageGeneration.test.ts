import { describe, expect, it } from 'vitest';
import { parseAgentCommand, parseAgentWorkerEvent } from './agent';

const config = {
  providerId: 'images',
  modelId: 'gpt-image',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
};

describe('生图配置下发协议', () => {
  it('接受合法配置以及显式清空，不把密钥扩展到 worker 事件', () => {
    const command = { type: 'set-image-generation-config', config };
    expect(parseAgentCommand(command)).toEqual(command);
    const clear = { type: 'set-image-generation-config', config: null, error: '请选择生图模型' };
    expect(parseAgentCommand(clear)).toEqual(clear);
    expect(parseAgentWorkerEvent(command)).toBeNull();
  });

  it.each([
    { type: 'set-image-generation-config' },
    { type: 'set-image-generation-config', config: false },
    { type: 'set-image-generation-config', config: { ...config, protocol: 'anthropic' } },
    { type: 'set-image-generation-config', config: { ...config, apiKey: '' } },
    { type: 'set-image-generation-config', config: { ...config, outputPath: '/tmp' } },
    { type: 'set-image-generation-config', config: { ...config, baseUrl: 'file:///tmp' } },
    { type: 'set-image-generation-config', config, error: 1 },
    { type: 'set-image-generation-config', config, path: '/tmp' },
  ])('拒绝不完整或越界配置 %#', (command) => {
    expect(parseAgentCommand(command)).toBeNull();
  });
});
