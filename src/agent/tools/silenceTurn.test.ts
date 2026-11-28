import { describe, expect, it } from 'vitest';
import { createSilenceTurnTool } from './silenceTurn';

describe('createSilenceTurnTool', () => {
  it('执行后返回 terminate: true，避免模型再续写 Silenced 正文', async () => {
    const tool = createSilenceTurnTool();
    const result = await tool.execute(
      'call-1',
      {},
      undefined as unknown as AbortSignal,
      undefined as unknown as Parameters<typeof tool.execute>[3],
      undefined as unknown as Parameters<typeof tool.execute>[4]
    );
    expect((result as { terminate?: boolean }).terminate).toBe(true);
    expect((result.details as { silenced?: boolean }).silenced).toBe(true);
  });
});
