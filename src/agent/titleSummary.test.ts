import { describe, expect, it } from 'vitest';
import { buildTitleUserText, extractTitle } from './titleSummary';

const assistant = (text: string, stopReason = 'stop') => ({
  content: [{ type: 'text', text }],
  stopReason,
});

describe('extractTitle：模型回复 → 可用标题', () => {
  it('正常文本回复直接作为标题', () => {
    expect(extractTitle(assistant('修复登录页 bug'))).toBe('修复登录页 bug');
  });

  it('剥掉模型习惯性包裹的中英文引号与句号、冒号、问号', () => {
    expect(extractTitle(assistant('"修复登录页 bug"'))).toBe('修复登录页 bug');
    expect(extractTitle(assistant('「修复登录页 bug」'))).toBe('修复登录页 bug');
    expect(extractTitle(assistant('修复登录页 bug。'))).toBe('修复登录页 bug');
    expect(extractTitle(assistant('“修复登录页 bug”'))).toBe('修复登录页 bug');
    expect(extractTitle(assistant('从这里继续:'))).toBe('从这里继续');
    expect(extractTitle(assistant('工厂配置层通用性讨论：'))).toBe('工厂配置层通用性讨论');
    expect(extractTitle(assistant('这个接口怎么调用？'))).toBe('这个接口怎么调用');
  });

  it('多行回复只取首个非空行（模型可能附加解释）', () => {
    expect(extractTitle(assistant('\n修复登录页 bug\n\n这个标题概括了…'))).toBe('修复登录页 bug');
  });

  it('忽略 thinking 片段，只取 text 片段', () => {
    expect(
      extractTitle({
        content: [
          { type: 'thinking', thinking: '用户想要…' },
          { type: 'text', text: '透明背景图功能' },
        ],
        stopReason: 'stop',
      })
    ).toBe('透明背景图功能');
  });

  it('错误/中止的回复不产出标题', () => {
    expect(extractTitle(assistant('修复登录页 bug', 'error'))).toBe('');
    expect(extractTitle(assistant('修复登录页 bug', 'aborted'))).toBe('');
  });

  it('超长回复截到 80 字符（与 renameConversation 上限一致）', () => {
    expect(extractTitle(assistant('长'.repeat(200)))).toBe('长'.repeat(80));
  });

  // 脏输入：worker 事件链路上的对象形状不能让 worker 崩掉
  it('content 缺失/非数组/空文本时返回空串不崩', () => {
    expect(extractTitle({ stopReason: 'stop' })).toBe('');
    expect(extractTitle({ content: 'nope', stopReason: 'stop' })).toBe('');
    expect(extractTitle(assistant('   '))).toBe('');
    expect(extractTitle(assistant(''))).toBe('');
  });
});

describe('buildTitleUserText：送给模型的用户消息', () => {
  it('原样保留短消息', () => {
    expect(buildTitleUserText('帮我修 bug')).toBe('帮我修 bug');
  });

  it('超长消息截断到 2000 字符，避免为一个标题烧长上下文', () => {
    expect(buildTitleUserText('x'.repeat(5000))).toHaveLength(2000);
  });

  it('首尾空白剔除', () => {
    expect(buildTitleUserText('  帮我修 bug\n')).toBe('帮我修 bug');
  });

  it('剥离内部 chat 引用块与跳转前缀，提取用户真正的提问正文', () => {
    const raw = [
      '从这里继续:',
      '[Referenced past chat "@D:\\WORK\\project." — transcript file: C:\\Users\\user\\session.jsonl (pi session jsonl; read it if relevant)]',
      '',
      '但是你说的这个都是完全针对性的修改了吧，会有通用性影响吗？',
    ].join('\n');
    expect(buildTitleUserText(raw)).toBe(
      '但是你说的这个都是完全针对性的修改了吧，会有通用性影响吗？'
    );
  });

  it('内联在文本中的 chat 引用块折叠，保留用户正文', () => {
    const raw =
      '[Referenced past chat "修复登录bug" — transcript file: /tmp/s.jsonl (pi session jsonl; read it if relevant)] 从这里继续，修一下这个新bug';
    expect(buildTitleUserText(raw)).toBe('从这里继续，修一下这个新bug');
  });

  it('剥离 UI 元素引用块', () => {
    const raw =
      '[Selected UI element "button" — path: div > button; text: 提交] 这个按钮点击没反应';
    expect(buildTitleUserText(raw)).toBe('这个按钮点击没反应');
  });

  it('只有引用块且无额外正文时，退化提取引用的会话标题', () => {
    const raw =
      '[Referenced past chat "用户鉴权模块设计" — transcript file: C:\\Users\\user\\session.jsonl (pi session jsonl; read it if relevant)]';
    expect(buildTitleUserText(raw)).toBe('用户鉴权模块设计');
  });

  it('只有跳转词和引用块且无额外正文时，退化提取引用的会话标题', () => {
    const raw = [
      '从这里继续:',
      '[Referenced past chat "用户鉴权模块设计" — transcript file: C:\\Users\\user\\session.jsonl (pi session jsonl; read it if relevant)]',
    ].join('\n');
    expect(buildTitleUserText(raw)).toBe('用户鉴权模块设计');
  });
});
