import { describe, expect, it, vi } from 'vitest';

vi.mock('./secretaries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./secretaries')>()),
  secretaryContext: (id: string) =>
    id === 'known' ? { id: 'known', dir: '/nonexistent/secretary', projectId: 'p-sec' } : null,
}));

const { invokeSecretaryOp } = await import('./tools');

describe('invokeSecretaryOp', () => {
  it('秘书不存在或没带秘书 id 时拒绝：op 只在某个秘书的上下文里执行', async () => {
    expect(
      await invokeSecretaryOp('project_list', {}, { secretaryConversationId: 'sec-1' })
    ).toEqual({ ok: false, error: 'secretary not found' });
    expect(
      await invokeSecretaryOp(
        'project_list',
        {},
        { secretaryConversationId: 'sec-1', secretaryId: 'gone' }
      )
    ).toEqual({ ok: false, error: 'secretary not found' });
  });

  it('参数不是对象时拒绝', async () => {
    expect(
      await invokeSecretaryOp('project_list', [], {
        secretaryConversationId: 'sec-1',
        secretaryId: 'known',
      })
    ).toEqual({ ok: false, error: 'invalid arguments: arguments must be a JSON object' });
  });
});
