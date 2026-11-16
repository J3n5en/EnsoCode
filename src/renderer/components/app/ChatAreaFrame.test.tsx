import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatAreaFrame } from './ChatAreaFrame';

const emptyChat = <p data-enso="empty-chat">Create or select a project</p>;
const html = (hidden: boolean) =>
  renderToStaticMarkup(<ChatAreaFrame hidden={hidden}>{emptyChat}</ChatAreaFrame>);

describe('ChatAreaFrame', () => {
  it('秘书引导打开时整块停止绘制，空会话节点仍在（不卸载，关掉后状态原样恢复）', () => {
    const markup = html(true);
    expect(markup).toContain('invisible');
    expect(markup).toContain('data-enso="empty-chat"');
  });

  it('引导关闭后聊天区恢复绘制', () => {
    const markup = html(false);
    expect(markup).not.toContain('invisible');
    expect(markup).toContain('data-enso="empty-chat"');
  });
});
