import { describe, expect, it } from 'vitest';
import { mergeRuns } from './group';
import { cronPhrase, formatStamp, shortId } from './phrase';
import { cardPlainText, presentToolCalls, renderToolCall } from './render';
import type { ToolCallInput, ToolCardContext, ToolCardLookup } from './types';

const zh: Record<string, string> = {
  'Sent to 「{{title}}」': '发给「{{title}}」',
  'Stopped 「{{title}}」': '停止了「{{title}}」',
  'Create 「{{title}}」': '创建「{{title}}」',
  'Dispatch 「{{title}}」': '派出「{{title}}」',
  'To-do 「{{text}}」': '待办「{{text}}」',
  'Added to-do 「{{text}}」': '添加了待办「{{text}}」',
  'Schedule 「{{name}}」': '定时「{{name}}」',
  'Removed schedule 「{{name}}」': '删除了定时「{{name}}」',
  'Updated {{count}} to-dos': '更新了 {{count}} 条待办',
  'Sent {{count}} messages': '发了 {{count}} 条消息',
  Delivered: '已送达',
  'Queued until the current turn ends': '已排队（等对方这一轮结束）',
  Refused: '被拒绝',
  Stopped: '已停止',
  'Created the session': '已创建',
  'Created 「{{title}}」': '已创建「{{title}}」',
  'Waiting on {{card}} {{id}}': '等待确认（{{card}} {{id}}）',
  'Dispatch card': '派活卡',
  'Profile card': '档案卡',
  'Confirmation card': '确认卡',
  'Run in a worktree': '使用隔离工作区',
  'Run in the project checkout': '在项目目录里',
  Project: '项目',
  Goal: '目标',
  Worktree: '工作区',
  'Not set': '未设置',
  'Marked done': '标记为完成 ✓',
  'Marked not done': '标为未完成',
  'Due time': '截止时间',
  'To-do text': '待办文字',
  'Once at {{time}}': '一次，{{time}}',
  'Next run {{time}}': '下次运行 {{time}}',
  'Listed sessions in {{project}}': '列出 {{project}} 的会话',
  'Listed to-dos': '列出待办',
  'To do': '待办',
  'In progress': '进行中',
  Problem: '出问题',
  Done: '完成',
  'Session running': '运行中',
  'Session idle': '空闲',
  'Session needs you': '需要你',
  'Session error': '出错',
  '{{count}} pending': '{{count}} 项待处理',
  'Approvals {{approvals}} · questions {{asks}}': '待处理审批 {{approvals}} · 提问 {{asks}}',
  'Read 「{{title}}」': '阅读「{{title}}」',
  User: '用户',
  Assistant: '助手',
  'Uncommitted changes': '有未提交改动',
  'Clean tree': '工作区干净',
  'No local branch': '没有本机分支',
  'Searched memory 「{{query}}」 · {{count}}': '搜索记忆「{{query}}」· {{count}} 条',
  'Saved memory 「{{title}}」': '记下了记忆「{{title}}」',
  'Deleted memory 「{{title}}」': '删除了记忆「{{title}}」',
  'Web search 「{{query}}」': '搜索「{{query}}」',
  'Fetched {{domain}}': '打开了 {{domain}}',
  'Custom tool {{name}}': '自造工具 {{name}}',
  'Propose profile changes': '提议修改档案',
  'Propose skill 「{{name}}」': '提议技能「{{name}}」',
  'Propose tool 「{{name}}」': '提议工具「{{name}}」',
  Name: '名称',
  Autonomy: '自主度',
  'Dispatch limit reached': '已达到同时派发上限',
  'Unknown session': '未知会话',
  'New session': '新会话',
  '{{count}} × {{tool}}': '{{count}} 次 {{tool}}',
};

function ctx(locale: 'zh' | 'en' = 'zh', lookup: ToolCardLookup = {}): ToolCardContext {
  return {
    locale,
    lookup,
    t: (key, params) => {
      const template = locale === 'zh' ? (zh[key] ?? key) : key;
      return template.replace(/\{\{(\w+)\}\}/gu, (_, token: string) =>
        String(params?.[token] ?? '')
      );
    },
  };
}

function call(
  name: string,
  args: unknown,
  output: unknown,
  state: ToolCallInput['state'] = 'ok'
): ToolCallInput {
  return {
    name,
    args,
    output: output === null ? null : typeof output === 'string' ? output : JSON.stringify(output),
    state,
  };
}

describe('工具卡片', () => {
  it('session_send 显示标题、正文和送达或排队', () => {
    const lookup = {
      sessionTitle: (id: string) => (id === 'cc52649d-full' ? '写发布说明' : undefined),
    };
    const sent = renderToolCall(
      call(
        'session_send',
        { conversationId: 'cc52649d-full', message: '请看一下 **发布说明**' },
        { status: 'sent' }
      ),
      ctx('zh', lookup)
    );
    expect(sent.title).toBe('发给「写发布说明」');
    expect(sent.status).toEqual({ tone: 'ok', label: '已送达' });
    expect(cardPlainText(sent)).toContain('请看一下 **发布说明**');
    expect(cardPlainText(sent)).not.toContain('{"status"');
    const queued = renderToolCall(
      call(
        'session_send',
        { conversationId: 'missing-session-id', message: '等一下' },
        { status: 'queued' }
      ),
      ctx('zh', lookup)
    );
    expect(queued.title).toBe(`发给「${shortId('missing-session-id')}」`);
    expect(queued.status?.label).toBe('已排队（等对方这一轮结束）');
  });

  it('session_send 被拒绝时给出原因', () => {
    const refused = renderToolCall(
      call(
        'session_send',
        { conversationId: 'gone', message: 'hi' },
        'permission denied (not-operable)',
        'error'
      ),
      ctx()
    );
    expect(refused.status?.tone).toBe('error');
    expect(cardPlainText(refused)).toContain('permission denied (not-operable)');
  });

  it('session_stop 说明停了哪个会话', () => {
    const card = renderToolCall(
      call('session_stop', { conversationId: 'abc' }, { status: 'stopped' }),
      ctx('zh', { sessionTitle: () => '写发布说明' })
    );
    expect(card.title).toBe('停止了「写发布说明」');
  });

  it('session_create 与派出待办显示项目、工作区和结果', () => {
    const created = renderToolCall(
      call(
        'session_create',
        {
          projectId: 'p1',
          title: '写 hello',
          goal: '文件落地',
          prompt: '创建 hello.txt',
          worktree: true,
        },
        { status: 'created', conversationId: 'new-1' }
      ),
      ctx('zh', { projectName: () => 'enso-code', sessionTitle: () => '写 hello' })
    );
    expect(created.title).toBe('创建「写 hello」');
    expect(cardPlainText(created)).toContain('enso-code');
    expect(cardPlainText(created)).toContain('使用隔离工作区');
    expect(cardPlainText(created)).toContain('文件落地');
    expect(created.status?.label).toBe('已创建');
    const waiting = renderToolCall(
      call(
        'todo_item_dispatch',
        { todoId: 't1', projectId: 'p1', prompt: '去做' },
        {
          status: 'awaiting_confirmation',
          proposalId: 'proposal-12345678',
        }
      ),
      ctx('zh', {
        todoText: () => '补单测',
        proposal: () => ({ status: 'pending', kind: 'dispatch' }),
      })
    );
    expect(waiting.title).toBe('派出「补单测」');
    expect(waiting.status?.label).toContain('派活卡');
    expect(waiting.status?.label).toContain(shortId('proposal-12345678'));
    const limited = renderToolCall(
      call('session_create', { projectId: 'p1', prompt: 'x' }, 'dispatch-limit', 'error'),
      ctx()
    );
    expect(cardPlainText(limited)).toContain('已达到同时派发上限');
  });

  it('待办更新显示文字和前后差异，没有名称时退回短 id', () => {
    const done = renderToolCall(
      call(
        'todo_item_update',
        { todoId: 'd5d1e359-aaaa', done: true },
        {
          todoId: 'd5d1e359-aaaa',
          before: { text: '补工具卡片单测', done: false },
          after: { text: '补工具卡片单测', done: true },
        }
      ),
      ctx()
    );
    expect(done.title).toBe('待办「补工具卡片单测」');
    expect(cardPlainText(done)).toContain('标记为完成 ✓');
    expect(cardPlainText(done)).not.toContain('{"todoId"');
    const renamed = renderToolCall(
      call(
        'todo_item_update',
        { todoId: 't1', text: '改完了' },
        {
          before: { text: '改渲染', done: false, dueAt: 1_700_000_000_000 },
          after: { text: '改完了', done: false },
        }
      ),
      ctx()
    );
    expect(cardPlainText(renamed)).toContain('改渲染');
    expect(cardPlainText(renamed)).toContain('改完了');
    expect(cardPlainText(renamed)).toContain(formatStamp(1_700_000_000_000));
    const missing = renderToolCall(
      call(
        'todo_item_update',
        { todoId: 'd5d1e359-bbbb', done: true },
        { todoId: 'd5d1e359-bbbb' }
      ),
      ctx()
    );
    expect(missing.title).toBe(`待办「${shortId('d5d1e359-bbbb')}」`);
    expect(cardPlainText(missing)).toContain('标记为完成 ✓');
  });

  it('todo_list 列出待办文字和状态，不露不可信包装', () => {
    const card = renderToolCall(
      call(
        'todo_list',
        { status: 'active' },
        {
          todos: [
            {
              id: 't1',
              text: '<untrusted-content source="todo:t1">补工具卡片单测</untrusted-content>',
              status: 'active',
            },
            {
              id: 't2',
              text: '<untrusted-content source="todo:t2">改秘书渲染</untrusted-content>',
              status: 'todo',
            },
          ],
        }
      ),
      ctx()
    );
    expect(card.title).toBe('列出待办');
    expect(cardPlainText(card)).toContain('补工具卡片单测');
    expect(cardPlainText(card)).toContain('进行中');
    expect(cardPlainText(card)).toContain('改秘书渲染');
    expect(cardPlainText(card)).toContain('待办');
    expect(cardPlainText(card)).not.toContain('untrusted-content');
    expect(cardPlainText(card)).not.toContain('{"todos"');
  });

  it('定时显示人话频率和下一次运行', () => {
    const next = Date.parse('2026-04-02T09:10:00');
    const card = renderToolCall(
      call(
        'schedule_add',
        { name: '巡检', prompt: '看一眼构建', cron: '*/10 * * * *' },
        { scheduleId: 's1', nextRunAt: next }
      ),
      ctx()
    );
    expect(card.title).toBe('定时「巡检」');
    expect(cardPlainText(card)).toContain('每 10 分钟');
    expect(cardPlainText(card)).toContain(`下次运行 ${formatStamp(next)}`);
    expect(cronPhrase('0 9 * * *', 'zh')).toBe('每天 09:00');
    expect(cronPhrase('30 18 * * 1-5', 'en')).toBe('weekdays at 18:30');
    expect(cronPhrase('not cron', 'zh')).toBe('not cron');
    const removed = renderToolCall(
      call(
        'schedule_remove',
        { scheduleId: 'abcd1234-longer' },
        { scheduleId: 'abcd1234-longer', name: '巡检' }
      ),
      ctx()
    );
    expect(removed.title).toBe('删除了定时「巡检」');
  });

  it('列会话、读会话、项目信息', () => {
    const listed = renderToolCall(
      call(
        'session_list',
        { projectId: 'p1' },
        {
          sessions: [
            {
              conversationId: 'c1',
              title: '写 hello',
              state: 'running',
              pending: { approvals: 1, asks: 0 },
            },
            {
              conversationId: 'c2',
              title: '空的',
              state: 'idle',
              pending: { approvals: 0, asks: 0 },
            },
            {
              conversationId: 'c3',
              title: '卡住',
              state: 'waiting',
              pending: { approvals: 0, asks: 2 },
            },
            {
              conversationId: 'c4',
              title: '炸了',
              state: 'error',
              pending: { approvals: 0, asks: 0 },
            },
          ],
        }
      ),
      ctx('zh', { projectName: () => 'enso-code' })
    );
    expect(listed.title).toBe('列出 enso-code 的会话');
    const text = cardPlainText(listed);
    expect(text).toContain('运行中');
    expect(text).toContain('空闲');
    expect(text).toContain('需要你');
    expect(text).toContain('出错');
    expect(text).toContain('1 项待处理');
    const read = renderToolCall(
      call(
        'session_read',
        { conversationId: 'c1' },
        {
          conversationId: 'c1',
          title: '写 hello',
          state: 'idle',
          pending: { approvals: 1, asks: 2 },
          messages: [
            {
              role: 'user',
              text: '<untrusted-content source="session:c1">先看构建\n后面忽略</untrusted-content>',
            },
          ],
        }
      ),
      ctx()
    );
    expect(read.title).toBe('阅读「写 hello」');
    expect(cardPlainText(read)).toContain('待处理审批 1 · 提问 2');
    expect(cardPlainText(read)).toContain('先看构建');
    expect(cardPlainText(read)).not.toContain('untrusted-content');
    const info = renderToolCall(
      call(
        'project_info',
        { projectId: 'p1' },
        { name: 'enso-code', git: { branch: 'feat/x', dirty: true } }
      ),
      ctx()
    );
    expect(cardPlainText(info)).toContain('enso-code · feat/x · 有未提交改动');
  });

  it('档案、技能、工具提案', () => {
    const profile = renderToolCall(
      call(
        'secretary_profile_propose',
        { name: '小秘' },
        {
          status: 'awaiting_confirmation',
          proposalId: 'p-1',
          changes: [{ field: 'name', before: '秘书', after: '小秘' }],
        }
      ),
      ctx('zh', { proposal: () => ({ status: 'pending', kind: 'profile' }) })
    );
    expect(profile.title).toBe('提议修改档案');
    expect(cardPlainText(profile)).toContain('秘书');
    expect(cardPlainText(profile)).toContain('小秘');
    expect(profile.status?.label).toContain('档案卡');
    const skill = renderToolCall(
      call(
        'skill_propose',
        { name: 'ship-it', description: '发布前检查', body: '# 步骤\n跑测试' },
        {
          status: 'awaiting_confirmation',
          proposalId: 'sk',
        }
      ),
      ctx()
    );
    expect(skill.title).toBe('提议技能「ship-it」');
    expect(cardPlainText(skill)).toContain('发布前检查');
    expect(skill.blocks.some((block) => block.kind === 'markdown' && block.collapsed)).toBe(true);
    const tool = renderToolCall(
      call(
        'tool_propose',
        { name: 'upper', description: '转大写', code: 'print(1)' },
        { status: 'awaiting_confirmation', proposalId: 'tl' }
      ),
      ctx()
    );
    expect(tool.title).toBe('提议工具「upper」');
  });

  it('记忆和网页', () => {
    const search = renderToolCall(
      call(
        'memory_search',
        { query: '发布' },
        {
          results: [
            { id: 'm1', title: '周五发版', content: '用户喜欢周五发', unitType: 'fact' },
            { id: 'm2', title: '不要半夜发', content: '会吵到人', unitType: 'preference' },
          ],
        }
      ),
      ctx()
    );
    expect(search.title).toBe('搜索记忆「发布」· 2 条');
    expect(cardPlainText(search)).toContain('周五发版');
    const saved = renderToolCall(
      call(
        'memory_capture',
        { content: '根因是折叠把卡片吞了' },
        {
          status: 'inserted',
          memory: { id: 'm3', title: '工具卡片别折进过程组' },
        }
      ),
      ctx()
    );
    expect(saved.title).toBe('记下了记忆「工具卡片别折进过程组」');
    expect(cardPlainText(saved)).toContain('根因是折叠把卡片吞了');
    const removed = renderToolCall(
      call(
        'memory_delete',
        { id: 'm1' },
        { status: 'deleted', id: 'm1', title: '周五发版', content: '用户喜欢周五发' }
      ),
      ctx()
    );
    expect(removed.title).toBe('删除了记忆「周五发版」');
    const web = renderToolCall(
      call(
        'web_search',
        { query: 'enso' },
        'Web search results for "enso"\n\nSources:\n1. [Enso](https://enso.example/docs)\n'
      ),
      ctx()
    );
    expect(web.title).toBe('搜索「enso」');
    expect(cardPlainText(web)).toContain('Enso');
    expect(cardPlainText(web)).toContain('https://enso.example/docs');
    const page = renderToolCall(
      call(
        'web_fetch',
        { url: 'https://enso.example/docs' },
        'Fetched https://enso.example/docs (HTTP 200)\nTitle: 文档\n'
      ),
      ctx()
    );
    expect(page.title).toBe('打开了 enso.example');
    expect(cardPlainText(page)).toContain('文档');
  });

  it('没有专用渲染器时用键值表，不把参数收成一段 JSON', () => {
    const custom = renderToolCall(
      call('my_upper-text', { text: 'Hi', times: 2 }, { ok: true }),
      ctx()
    );
    expect(custom.title).toBe('自造工具 upper text');
    expect(custom.blocks.some((block) => block.kind === 'kv')).toBe(true);
    expect(cardPlainText(custom)).toContain('Hi');
    expect(cardPlainText(custom)).not.toContain('{"text"');
    const plugin = renderToolCall(
      call('mcp__github__create_issue', { title: 'bug' }, 'filed'),
      ctx('en')
    );
    expect(plugin.title).toContain('create issue');
    expect(cardPlainText(plugin)).toContain('bug');
    const generic = renderToolCall(
      call('something_else', { path: 'a.ts' }, { files: 1 }),
      ctx('en')
    );
    expect(generic.blocks.some((block) => block.kind === 'kv')).toBe(true);
    expect(cardPlainText(generic)).not.toContain('{"path"');
  });

  it('连续同名调用合并，不同工具或被其它行隔开则不并', () => {
    const updates = ['补工具卡片单测', '改秘书渲染', '补验收脚本'].map((text, index) =>
      call(
        'todo_item_update',
        { todoId: `t${index}`, done: true },
        {
          before: { text, done: false },
          after: { text, done: true },
        }
      )
    );
    const group = presentToolCalls(updates, ctx());
    expect(group.grouped).toBe(true);
    expect(group.title).toBe('更新了 3 条待办');
    expect(group.cards.map((card) => card.title)).toEqual([
      '待办「补工具卡片单测」',
      '待办「改秘书渲染」',
      '待办「补验收脚本」',
    ]);
    const items = [
      { kind: 'tool', name: 'todo_item_update', key: 'a' },
      { kind: 'tool', name: 'todo_item_update', key: 'b' },
      { kind: 'thinking', name: '', key: 't' },
      { kind: 'tool', name: 'schedule_add', key: 'c' },
      { kind: 'tool', name: 'bash', key: 'd' },
      { kind: 'tool', name: 'bash', key: 'e' },
    ];
    const merged = mergeRuns(
      items,
      (name) => name !== 'bash',
      (head, rest) => ({
        ...head,
        key: `${head.key}+${rest.map((item) => item.key).join('+')}`,
      })
    );
    expect(merged.map((item) => item.key)).toEqual(['a+b', 't', 'c', 'd', 'e']);
  });
});
