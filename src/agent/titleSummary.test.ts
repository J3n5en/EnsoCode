import type { ProjectedMessage, SpawnModelConfig } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  buildRollingTitleUserText,
  buildTitleUserText,
  buildTurnDigest,
  describeTitleModel,
  extractTitle,
  ROLLING_TITLE_SYSTEM_PROMPT,
  TITLE_SUMMARY_TIMEOUTS_MS,
  titleRejectReason,
  titleSummaryTimeoutMs,
  TURN_DIGEST_ASSISTANT_MAX,
  TURN_DIGEST_USER_MAX,
} from './titleSummary';

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

describe('buildTurnDigest：本轮消息 → 压缩摘要', () => {
  const user = (text: string): ProjectedMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
  });
  const assistant = (text: string, stopReason = 'stop'): ProjectedMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
  });
  const assistantMixed = (
    parts: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; text: string }
      | { type: 'toolCall'; id: string; name: string }
    >,
    stopReason = 'stop'
  ): ProjectedMessage => ({
    role: 'assistant',
    content: parts as ProjectedMessage['content'],
    stopReason,
  });
  const toolResult = (id: string): ProjectedMessage => ({
    role: 'tool',
    content: [{ type: 'text', text: `result-${id}` }],
    toolCallId: id,
  });

  it('单 user + assistant：直接取两段文本', () => {
    const messages: ProjectedMessage[] = [user('帮我修 bug'), assistant('已修复')];
    expect(buildTurnDigest(messages, 0)).toEqual({
      userText: '帮我修 bug',
      assistantText: '已修复',
    });
  });

  it('steer 多条 user 文本以 \n 拼接', () => {
    const messages: ProjectedMessage[] = [
      user('第一问'),
      assistant('第一答'),
      user('中途 steer 追问'),
      assistant('第二答'),
    ];
    expect(buildTurnDigest(messages, 0)?.userText).toBe('第一问\n中途 steer 追问');
  });

  it('assistant 含 thinking / toolCall 片段时只取 text 片段', () => {
    const messages: ProjectedMessage[] = [
      user('问'),
      assistantMixed([
        { type: 'thinking', text: '内部思考应被忽略' },
        { type: 'toolCall', id: 'c1', name: 'read_file' },
        { type: 'text', text: '只保留这段正文' },
      ]),
    ];
    expect(buildTurnDigest(messages, 0)?.assistantText).toBe('只保留这段正文');
  });

  it('取最后一条含 text 的 assistant（末尾是 toolResult 时向前找）', () => {
    const messages: ProjectedMessage[] = [
      user('问'),
      assistant('第一答'),
      assistantMixed([{ type: 'toolCall', id: 'c1', name: 'run' }]),
      toolResult('c1'),
    ];
    expect(buildTurnDigest(messages, 0)?.assistantText).toBe('第一答');
  });

  it('末尾是无文本 assistant 时向前找最近一条含 text 的 assistant', () => {
    const messages: ProjectedMessage[] = [
      user('问'),
      assistant('有文本结论'),
      assistantMixed([{ type: 'toolCall', id: 'c1', name: 'run' }]),
    ];
    expect(buildTurnDigest(messages, 0)?.assistantText).toBe('有文本结论');
  });

  it('stopReason 为 error / aborted 的 assistant 跳过', () => {
    const messages: ProjectedMessage[] = [
      user('问'),
      assistant('错误轮结论', 'error'),
      assistant('中断轮结论', 'aborted'),
      assistant('正常结论'),
    ];
    expect(buildTurnDigest(messages, 0)?.assistantText).toBe('正常结论');
  });

  it('user 文本截头到 TURN_DIGEST_USER_MAX=2000', () => {
    expect(TURN_DIGEST_USER_MAX).toBe(2000);
    const long = 'x'.repeat(5000);
    const messages: ProjectedMessage[] = [user(long), assistant('答')];
    expect(buildTurnDigest(messages, 0)?.userText).toHaveLength(2000);
  });

  it('assistant 文本截尾到 TURN_DIGEST_ASSISTANT_MAX=1500', () => {
    expect(TURN_DIGEST_ASSISTANT_MAX).toBe(1500);
    const long = 'y'.repeat(5000);
    const messages: ProjectedMessage[] = [user('问'), assistant(long)];
    // 结论在末尾，截尾即保留最后 1500
    expect(buildTurnDigest(messages, 0)?.assistantText).toBe('y'.repeat(1500));
  });

  it('user 文本经 buildTitleUserText 清洗（含 chat 引用块被剥离）', () => {
    const raw = [
      '[Referenced past chat "旧会话" — transcript file: /tmp/s.jsonl (pi session jsonl; read it if relevant)]',
      '真正的本轮提问',
    ].join('\n');
    const messages: ProjectedMessage[] = [user(raw), assistant('答')];
    expect(buildTurnDigest(messages, 0)?.userText).toBe('真正的本轮提问');
  });

  it('两段皆空 → null', () => {
    const messages: ProjectedMessage[] = [
      user('   '),
      assistantMixed([{ type: 'toolCall', id: 'c1', name: 'run' }]),
      toolResult('c1'),
    ];
    expect(buildTurnDigest(messages, 0)).toBeNull();
  });

  it('fromIndex 大于 messages.length 时夹紧（不报错）', () => {
    const messages: ProjectedMessage[] = [user('问'), assistant('答')];
    // fromIndex 超出长度：切片为空，但应回退到最近一条 user
    const digest = buildTurnDigest(messages, 999);
    expect(digest).not.toBeNull();
    expect(digest?.userText).toBe('问');
  });

  it('切片内无 user 时回退到最近一条 user', () => {
    const messages: ProjectedMessage[] = [
      user('早先的提问'),
      assistant('早先的结论'),
      assistant('本轮只有 assistant'),
    ];
    // fromIndex=2 切片内无 user，回退到 index 0 的 user
    expect(buildTurnDigest(messages, 2)?.userText).toBe('早先的提问');
  });
});

describe('buildRollingTitleUserText：滚动模式送给模型的 user text', () => {
  it('三段齐全时输出 Current title / Latest user request / Latest assistant conclusion', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: '修复登录 bug',
      userText: '这个修复有通用性吗',
      assistantText: '只影响登录路径',
    });
    expect(text).toContain('Current title: 修复登录 bug');
    expect(text).toContain('Latest user request:');
    expect(text).toContain('这个修复有通用性吗');
    expect(text).toContain('Latest assistant conclusion:');
    expect(text).toContain('只影响登录路径');
  });

  it('userText 为空时该段用 (none) 占位', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: 't',
      userText: '',
      assistantText: 'a',
    });
    expect(text).toContain('Latest user request:');
    expect(text).toContain('(none)');
    expect(text).toContain('a');
  });

  it('assistantText 为空时该段用 (none) 占位', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: 't',
      userText: 'u',
      assistantText: '',
    });
    expect(text).toContain('Latest assistant conclusion:');
    expect(text).toContain('(none)');
    expect(text).toContain('u');
  });

  it('currentTitle 为空时该段也用 (none) 占位', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: '',
      userText: 'u',
      assistantText: 'a',
    });
    expect(text).toContain('Current title: (none)');
  });
});

describe('ROLLING_TITLE_SYSTEM_PROMPT', () => {
  it('是非空字符串', () => {
    expect(typeof ROLLING_TITLE_SYSTEM_PROMPT).toBe('string');
    expect(ROLLING_TITLE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('包含保持当前标题的指令', () => {
    expect(ROLLING_TITLE_SYSTEM_PROMPT.toLowerCase()).toContain('current title');
  });
});

describe('titleSummaryTimeoutMs：候选下标 → 递增超时', () => {
  it('三档为 60s / 120s / 180s', () => {
    expect(TITLE_SUMMARY_TIMEOUTS_MS).toEqual([60_000, 120_000, 180_000]);
    expect(titleSummaryTimeoutMs(0)).toBe(60_000);
    expect(titleSummaryTimeoutMs(1)).toBe(120_000);
    expect(titleSummaryTimeoutMs(2)).toBe(180_000);
  });

  it('越界取最后一档；负数取第一档', () => {
    expect(titleSummaryTimeoutMs(5)).toBe(180_000);
    expect(titleSummaryTimeoutMs(-1)).toBe(60_000);
  });
});

describe('titleRejectReason：结果像不像标题', () => {
  it('合法短标题 → null', () => {
    expect(titleRejectReason('修复节点状态转圈')).toBeNull();
    expect(titleRejectReason('Fix node status spinner')).toBeNull();
    // 尾部句号已由 extractTitle 剥掉；中间带一个句号的也放过
    expect(titleRejectReason('v2.5 发布准备')).toBeNull();
  });

  it('空串 → empty', () => {
    expect(titleRejectReason('')).toBe('model returned empty title');
    expect(titleRejectReason('   ')).toBe('model returned empty title');
  });

  it('多句叙述（composer 把出标题当任务干） → did not return a title', () => {
    expect(
      titleRejectReason('继续排查节点一直转圈的问题。我先查看当前代码。然后确认修复是否生效')
    ).toBe('model did not return a title');
    expect(
      titleRejectReason('I will look at the code first. Then I will check the fix. Finally verify')
    ).toBe('model did not return a title');
  });
});

describe('describeTitleModel：人可读模型标识', () => {
  const base: SpawnModelConfig = {
    api: 'openai-completions',
    baseUrl: '',
    apiKey: '',
    modelId: 'composer-2.5-fast',
    settingsProviderId: '8a0c2756-cca4-41ad-9393-fc187d475cf4',
  };

  it('oauth 配置 → accountKey/modelId', () => {
    expect(describeTitleModel({ ...base, oauthAccountKey: 'cursor' })).toBe(
      'cursor/composer-2.5-fast'
    );
  });

  it('apiKey 配置 → settingsProviderId/modelId', () => {
    expect(describeTitleModel({ ...base, modelId: 'grok-4.6' })).toBe(
      '8a0c2756-cca4-41ad-9393-fc187d475cf4/grok-4.6'
    );
  });
});
