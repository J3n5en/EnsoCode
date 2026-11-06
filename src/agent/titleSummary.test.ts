import type { ProjectedMessage, SpawnModelConfig } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  buildInitialTitleUserText,
  buildRollingTitleUserText,
  buildTitleUserText,
  buildTurnDigest,
  describeTitleModel,
  extractTitle,
  ROLLING_TITLE_SYSTEM_PROMPT,
  TITLE_SUMMARY_TIMEOUTS_MS,
  TURN_DIGEST_ASSISTANT_MAX,
  TURN_DIGEST_FIRST_USER_MAX,
  TURN_DIGEST_USER_MAX,
  titleRejectReason,
  titleSummaryTimeoutMs,
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

  it('剥掉模型控制 token（<|eos|> 之类）', () => {
    expect(extractTitle(assistant('修复登录页 bug<|eos|>'))).toBe('修复登录页 bug');
    expect(extractTitle(assistant('<|im_start|>修复登录页 bug<|im_end|>'))).toBe('修复登录页 bug');
    expect(extractTitle(assistant('<|eos|>'))).toBe('');
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

describe('buildTitleUserText：送给模型的用户消息（清洗后的用户原文）', () => {
  it('原样保留短消息', () => {
    expect(buildTitleUserText('帮我修 bug')).toBe('帮我修 bug');
  });

  it('超长消息截断到 2000 字符，避免为一个标题烧长上下文', () => {
    expect(buildTitleUserText('x'.repeat(5000))).toHaveLength(2000);
  });

  it('已展开的 skill 正文不进入标题输入，只留用户自己的话', () => {
    const raw = [
      '<skill name="poteto-mode" location="/skills/poteto-mode/SKILL.md">',
      '# playbook',
      'x'.repeat(3000),
      '</skill>',
      '',
      '感觉标题生成有点缺陷',
    ].join('\n');
    expect(buildTitleUserText(raw)).toBe('感觉标题生成有点缺陷');
    expect(buildTitleUserText(raw.replace('\n\n感觉标题生成有点缺陷', ''))).toBe('poteto-mode');
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

describe('buildInitialTitleUserText：initial 模式送给模型的 user text', () => {
  it('把用户原文包进带标签的框，模型才不会把「先别动手，只说方案」当成对自己的指令去回答', () => {
    const text = buildInitialTitleUserText(
      '帮我把侧栏拖拽改成 dnd-kit。先别动手, 只说一下你打算怎么做, 三句话以内。'
    );
    expect(text).toContain('Opening request');
    expect(text).toContain(
      '帮我把侧栏拖拽改成 dnd-kit。先别动手, 只说一下你打算怎么做, 三句话以内。'
    );
    // 框的标签在原文之前，原文不再是消息的第一行
    expect(text.indexOf('Opening request')).toBeLessThan(text.indexOf('帮我把侧栏拖拽'));
  });

  it('输入先过 buildTitleUserText 清洗：引用块与跳转前缀被剥掉', () => {
    const raw =
      '[Referenced past chat "旧会话" — transcript file: /tmp/s.jsonl (pi session jsonl; read it if relevant)] 从这里继续，修一下这个新bug';
    const text = buildInitialTitleUserText(raw);
    expect(text).toContain('从这里继续，修一下这个新bug');
    expect(text).not.toContain('Referenced past chat');
  });

  it('清洗后为空 → 空串（调用方据此跳过）', () => {
    expect(buildInitialTitleUserText('   ')).toBe('');
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

  it('单 user + assistant：直接取两段文本，首条即本轮 user', () => {
    const messages: ProjectedMessage[] = [user('帮我修 bug'), assistant('已修复')];
    expect(buildTurnDigest(messages, 0)).toEqual({
      firstUserText: '帮我修 bug',
      userText: '帮我修 bug',
      assistantText: '已修复',
    });
  });

  it('firstUserText 取全量第一条 user，与 fromIndex 切片无关', () => {
    const messages: ProjectedMessage[] = [
      user('帮我把侧栏拖拽改成 dnd-kit'),
      assistant('好，先看现状'),
      user('开始实施'),
      assistant('已读 PRD 并定位相关代码'),
    ];
    const digest = buildTurnDigest(messages, 2);
    expect(digest?.firstUserText).toBe('帮我把侧栏拖拽改成 dnd-kit');
    expect(digest?.userText).toBe('开始实施');
  });

  it('firstUserText 经 buildTitleUserText 清洗并截头到 TURN_DIGEST_FIRST_USER_MAX=600', () => {
    expect(TURN_DIGEST_FIRST_USER_MAX).toBe(600);
    const raw = [
      '[Referenced past chat "旧会话" — transcript file: /tmp/s.jsonl (pi session jsonl; read it if relevant)]',
      'z'.repeat(2000),
    ].join('\n');
    const messages: ProjectedMessage[] = [user(raw), assistant('答')];
    expect(buildTurnDigest(messages, 0)?.firstUserText).toBe('z'.repeat(600));
  });

  it('全量无 user 时 firstUserText 为空串（assistant 有文本仍返回 digest）', () => {
    const messages: ProjectedMessage[] = [assistant('只有 assistant')];
    expect(buildTurnDigest(messages, 0)).toEqual({
      firstUserText: '',
      userText: '',
      assistantText: '只有 assistant',
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
  it('四段齐全时输出 Opening request / Current title / Latest user request / Latest assistant conclusion，且 Opening request 在最前', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: '修复登录 bug',
      firstUserText: '帮我把登录页的 bug 修一下',
      userText: '这个修复有通用性吗',
      assistantText: '只影响登录路径',
    });
    expect(text).toContain('Opening request');
    expect(text).toContain('帮我把登录页的 bug 修一下');
    expect(text.indexOf('Opening request')).toBeLessThan(text.indexOf('Current title'));
    expect(text).toContain('Current title: 修复登录 bug');
    expect(text).toContain('Latest user request');
    expect(text).toContain('这个修复有通用性吗');
    expect(text).toContain('Latest assistant conclusion');
    expect(text).toContain('只影响登录路径');
  });

  it('firstUserText 为空时 Opening request 段用 (none) 占位', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: 't',
      firstUserText: '',
      userText: 'u',
      assistantText: 'a',
    });
    expect(text).toMatch(/Opening request[^\n]*\n\(none\)/);
  });

  it('userText 为空时该段用 (none) 占位', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: 't',
      firstUserText: 'f',
      userText: '',
      assistantText: 'a',
    });
    expect(text).toContain('Latest user request');
    expect(text).toContain('(none)');
    expect(text).toContain('a');
  });

  it('assistantText 为空时该段用 (none) 占位', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: 't',
      firstUserText: 'f',
      userText: 'u',
      assistantText: '',
    });
    expect(text).toContain('Latest assistant conclusion');
    expect(text).toContain('(none)');
    expect(text).toContain('u');
  });

  it('currentTitle 为空时该段也用 (none) 占位', () => {
    const text = buildRollingTitleUserText({
      kind: 'rolling',
      currentTitle: '',
      firstUserText: 'f',
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

  it('锰定开场请求，且明确推进类回合原样返回、不满单步动作当标题', () => {
    const lower = ROLLING_TITLE_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain('opening request');
    expect(lower).toMatch(/continue|proceed|go ahead/);
    expect(lower).toMatch(/single step|single action|one step/);
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

  it('句中出现 CJK 句终标点（不在末尾）→ 叙述而非标题；半角 . 不算（v2.5 / dnd-kit.js）', () => {
    // 真机 gpt-5.4-mini 滚动总结产出：首句是对用户的回答，后面接方案叙述
    expect(
      titleRejectReason('主侧栏。我会把会话列表和 CoworkerTabs 的标签都切到同一套 dnd-kit')
    ).toBe('model did not return a title');
    expect(titleRejectReason('修好了！接下来看登录页')).toBe('model did not return a title');
    expect(titleRejectReason('升级 dnd-kit.js 到 v6.1')).toBeNull();
  });

  it('远超 prompt 要求的长度 → did not return a title（CJK > 40 字 / 其它 > 12 词）', () => {
    // 真机 gpt-5.4-mini initial 产出：60 字的方案复述，只含一个句中逗号、无句终标点
    expect(
      titleRejectReason(
        '用 dnd-kit 替换侧栏会话列表的 HTML5 拖拽，保留现有排序和交互语义，只改拖拽层实现，避免影响会话数据结构和列表渲染'
      )
    ).toBe('model did not return a title');
    expect(
      titleRejectReason(
        'Replace the sidebar HTML5 drag and drop with dnd-kit while keeping ordering semantics intact and untouched'
      )
    ).toBe('model did not return a title');
    // 边界：40 字 CJK / 12 词英文放过（prompt 要求 20 字 / 6 词，留两倍余量）
    expect(titleRejectReason('字'.repeat(40))).toBeNull();
    expect(titleRejectReason('字'.repeat(41))).toBe('model did not return a title');
    expect(titleRejectReason(Array(12).fill('word').join(' '))).toBeNull();
    expect(titleRejectReason(Array(13).fill('word').join(' '))).toBe(
      'model did not return a title'
    );
    // 中英混排按 CJK 占比判：以中文为主的标题夹英文术语按字数算
    expect(titleRejectReason('侧栏拖拽用 dnd-kit 改造')).toBeNull();
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
