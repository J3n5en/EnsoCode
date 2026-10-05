import { describe, expect, it } from 'vitest';
import { parseBotInjectedMessage } from './injectedMessage';

describe('parseBotInjectedMessage', () => {
  it('跳过开头的笔记更新块再识别注入消息', () => {
    expect(
      parseBotInjectedMessage(
        '<notes-updated>\n- a\n</notes-updated>\n\n<delegation-result from="Bob" status="done">ok</delegation-result>'
      )
    ).toEqual({ kind: 'delegation-result', from: 'Bob', status: 'done', text: 'ok' });
  });
  it('群上下文有截断提示时仍识别消息', () => {
    expect(
      parseBotInjectedMessage(
        '<group-info>成员</group-info>\n（省略了 10 条更早的消息）\n<group-message from="林" seq="11">继续</group-message>'
      )
    ).toEqual({
      kind: 'group',
      messages: [{ from: '林', text: '继续' }],
      instruction: '（省略了 10 条更早的消息）',
    });
  });
  it('解析例行任务及实体，保留 prompt 内普通标签', () => {
    expect(
      parseBotInjectedMessage(
        '<routine title="晨报 &amp; &quot;计划&quot;">读 &lt;report&gt; &amp; <code>x</code></routine>'
      )
    ).toEqual({
      kind: 'routine',
      title: '晨报 & "计划"',
      prompt: '读 <report> & <code>x</code>',
    });
  });

  it('试运行的例行任务带标记，并去掉给成员看的试运行说明', () => {
    expect(
      parseBotInjectedMessage(
        '<routine title="日报" dry-run="true">[Dry run] The user triggered this routine manually as a trial run.\n\n写日报</routine>'
      )
    ).toEqual({ kind: 'routine', title: '日报', prompt: '写日报', dryRun: true });
  });

  it('群消息逐条解码，隐藏 group-info，保留尾部指令', () => {
    expect(
      parseBotInjectedMessage(
        '<group-info>群成员</group-info>\n<group-message from="林&amp;经理" role="经理" seq="1">早上好</group-message>\n<group-message from="侯" role="开发" seq="2">&lt;done&gt;</group-message>\n请回复'
      )
    ).toEqual({
      kind: 'group',
      messages: [
        { from: '林&经理', text: '早上好' },
        { from: '侯', text: '<done>' },
      ],
      instruction: '请回复',
    });
  });

  it('委派任务分离 context，仅解码一层实体', () => {
    expect(
      parseBotInjectedMessage(
        '<delegation-task id="d" from="林">\n检查 &amp;lt;tag&amp;gt;\n<context>背景 &lt;a&gt; &quot;b&quot;</context>\n</delegation-task>'
      )
    ).toEqual({
      kind: 'delegation-task',
      from: '林',
      task: '检查 &lt;tag&gt;',
      context: '背景 <a> "b"',
    });
    expect(
      parseBotInjectedMessage('<delegation-task id="d" from="林">检查</delegation-task>')
    ).toEqual({ kind: 'delegation-task', from: '林', task: '检查', context: '' });
  });

  it('委派结果包含来源、状态和正文，兼容无状态历史', () => {
    expect(
      parseBotInjectedMessage(
        '<delegation-result id="d" from="侯" status="completed">完成 &amp; 通过</delegation-result>'
      )
    ).toEqual({ kind: 'delegation-result', from: '侯', status: 'completed', text: '完成 & 通过' });
    expect(
      parseBotInjectedMessage('<delegation-result id="d" from="侯">完成</delegation-result>')
    ).toEqual({ kind: 'delegation-result', from: '侯', status: '', text: '完成' });
  });

  it('解析同轮多个委派合并的批次结果', () => {
    expect(
      parseBotInjectedMessage(
        [
          '<delegation-results id="k">',
          '<delegation-result id="a" from="小设" status="completed">设计 &amp; 稿</delegation-result>',
          '<delegation-result id="b" from="阿全" status="failed">timeout</delegation-result>',
          '</delegation-results>',
        ].join('\n')
      )
    ).toEqual({
      kind: 'delegation-results',
      results: [
        { from: '小设', status: 'completed', text: '设计 & 稿' },
        { from: '阿全', status: 'failed', text: 'timeout' },
      ],
    });
    expect(
      parseBotInjectedMessage('<delegation-results id="k">\n</delegation-results>')
    ).toBeNull();
    expect(
      parseBotInjectedMessage(
        '<delegation-results id="k">\n<delegation-result id="a" from="小设">x</delegation-result>\n尾巴\n</delegation-results>'
      )
    ).toBeNull();
  });

  it.each([
    '普通用户消息',
    '解释 <routine title="x">p</routine>',
    '<routine title="x">未闭合',
    '<routine>缺少标题</routine>',
    '<group-info>信息</group-info>',
    '<group-message role="x">缺少来源</group-message>',
    '<delegation-task from="x">任务<context>缺少闭合</delegation-task>',
    '<routine title="x">p</routine>尾巴',
  ])('非协议或损坏文本原样回退：%s', (text) => {
    expect(parseBotInjectedMessage(text)).toBeNull();
  });
});

describe('lead injection followed by group catch-up', () => {
  it('hides the post-compaction group-state block and lifts the routing note out of the instruction', () => {
    expect(
      parseBotInjectedMessage(
        [
          '<group-state>\n成员：A &amp; B\n</group-state>',
          '<group-message from="用户" role="人类" seq="59">两个都要</group-message>',
          '<routing-note>这是执行类请求：先动手完成，再简要汇报。</routing-note>',
        ].join('\n')
      )
    ).toEqual({
      kind: 'group',
      messages: [{ from: '用户', text: '两个都要' }],
      instruction: '',
      note: '这是执行类请求：先动手完成，再简要汇报。',
    });
  });
  it('turns appended chat references into titles instead of raw blocks', () => {
    expect(
      parseBotInjectedMessage(
        '<group-message from="用户" seq="3">看下 @x</group-message>\n<chat-reference id="c9" title="旧群" kind="group">\nintro\nA: hi\n</chat-reference>'
      )
    ).toEqual({
      kind: 'group',
      messages: [{ from: '用户', text: '看下 @x' }],
      instruction: '',
      refs: [{ id: 'c9', title: '旧群' }],
    });
  });
  it('attaches group messages after a lead even when preceded by group-state', () => {
    expect(
      parseBotInjectedMessage(
        '<delegation-result id="d" from="J" status="completed">ok</delegation-result>\n<group-state>\ns\n</group-state>\n<group-message from="A" seq="1">hi</group-message>\n<routing-note>n</routing-note>'
      )
    ).toEqual({
      kind: 'delegation-result',
      from: 'J',
      status: 'completed',
      text: 'ok',
      group: [{ from: 'A', text: 'hi' }],
    });
  });
  it('keeps the delegation result card and attaches the unseen group messages', () => {
    expect(
      parseBotInjectedMessage(
        [
          '<delegation-result id="d" from="Jason" status="completed">v2 done</delegation-result>',
          '<group-message from="用户" role="人类" seq="44">先做 5 吧</group-message>',
          '<group-message from="Jason" seq="50">#5 &amp; done</group-message>',
        ].join('\n')
      )
    ).toEqual({
      kind: 'delegation-result',
      from: 'Jason',
      status: 'completed',
      text: 'v2 done',
      group: [
        { from: '用户', text: '先做 5 吧' },
        { from: 'Jason', text: '#5 & done' },
      ],
    });
  });
  it('routine with a group intro on a fresh session', () => {
    expect(
      parseBotInjectedMessage(
        '<routine title="daily">check</routine>\n<group-info>\nintro\n</group-info>\n<group-message from="A" seq="1">hi</group-message>'
      )
    ).toEqual({
      kind: 'routine',
      title: 'daily',
      prompt: 'check',
      group: [{ from: 'A', text: 'hi' }],
    });
  });
});
