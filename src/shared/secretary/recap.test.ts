import { describe, expect, it } from 'vitest';
import {
  buildRecapTurns,
  formatRecapMessage,
  parseRecapRounds,
  RECAP_MAX_ROUNDS,
  recapUsageText,
} from './recap';
import { markdownToTelegramChunks } from './telegramHtml';

describe('/last 的参数', () => {
  it('不带参数是 1 轮', () => {
    expect(parseRecapRounds('')).toBe(1);
    expect(parseRecapRounds('   ')).toBe(1);
  });

  it('带参数就按参数来', () => {
    expect(parseRecapRounds('3')).toBe(3);
    expect(parseRecapRounds(' 10 ')).toBe(10);
  });

  it('上限十轮，超了、零、负数与非数字都算写错', () => {
    expect(parseRecapRounds(String(RECAP_MAX_ROUNDS + 1))).toBeNull();
    expect(parseRecapRounds('0')).toBeNull();
    expect(parseRecapRounds('-1')).toBeNull();
    expect(parseRecapRounds('三')).toBeNull();
    expect(parseRecapRounds('2 轮')).toBeNull();
    expect(recapUsageText('zh')).toContain('/last 3');
  });
});

describe('/last 按轮切分', () => {
  it('默认只取最近一轮，用户消息与回复成对', () => {
    const turns = buildRecapTurns(
      [
        { role: 'user', text: '早' },
        { role: 'assistant', text: '早，今天有三件事' },
        { role: 'user', text: '登录修好了吗' },
        { role: 'assistant', text: '修好了' },
      ],
      1
    );
    expect(turns).toEqual([{ user: '登录修好了吗', assistant: '修好了' }]);
  });

  it('多轮按从旧到新排列，最多取到上限', () => {
    const messages = Array.from({ length: 12 }, (_v, index) => [
      { role: 'user' as const, text: `问 ${index}` },
      { role: 'assistant' as const, text: `答 ${index}` },
    ]).flat();
    const turns = buildRecapTurns(messages, 3);
    expect(turns.map((turn) => turn.user)).toEqual(['问 9', '问 10', '问 11']);
  });

  it('系统回传与还没回复的最后一轮都不算对话', () => {
    const turns = buildRecapTurns(
      [
        { role: 'user', text: '在吗' },
        { role: 'assistant', text: '在' },
        {
          role: 'user',
          text: '<session-updates>\n- [goal-complete session:c1] 完成\n</session-updates>',
        },
        { role: 'assistant', text: '记下了' },
        { role: 'user', text: '还在跑吗' },
      ],
      5
    );
    expect(turns).toEqual([{ user: '在吗', assistant: '在' }]);
  });

  it('手机发来的话剥掉包裹头，只留用户打的字', () => {
    const turns = buildRecapTurns(
      [
        {
          role: 'user',
          text: '[来自 Telegram @j3n5en · 14:32]\n<untrusted-content source="telegram:@j3n5en">把登录修一下</untrusted-content>',
        },
        { role: 'assistant', text: '这就去' },
      ],
      1
    );
    expect(turns[0]?.user).toBe('把登录修一下');
  });
});

describe('/last 的格式', () => {
  const turns = [
    { user: '登录修好了吗', assistant: '修好了，分支 `fix/login`' },
    { user: '那发版呢', assistant: '等 CI' },
  ];

  it('用户用「你：」开头，秘书用昵称开头', () => {
    const text = formatRecapMessage('zh', { turns, name: '爱酱' });
    expect(text).toContain('你：登录修好了吗\n爱酱：修好了');
    expect(text).toContain('你：那发版呢\n爱酱：等 CI');
  });

  it('昵称缺省时用「秘书」', () => {
    expect(formatRecapMessage('zh', { turns: [turns[0]!], name: '  ' })).toContain('秘书：');
  });

  it('走现有出站路径：超长按行分条，代码块整块搬', () => {
    const code = [
      '```',
      ...Array.from({ length: 200 }, (_v, i) => `line ${i} ${'x'.repeat(40)}`),
      '```',
    ];
    const text = formatRecapMessage('zh', {
      turns: [{ user: '看日志', assistant: code.join('\n') }],
      name: '爱酱',
    });
    const chunks = markdownToTelegramChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.html.length <= 3900)).toBe(true);
    // 代码块被拆成多个 <pre>，但没有一条从中间切断标签
    for (const chunk of chunks) {
      expect(chunk.html.split('<pre>').length).toBe(chunk.html.split('</pre>').length);
    }
    expect(chunks.map((chunk) => chunk.plain).join('\n')).toContain('line 199');
  });
});
