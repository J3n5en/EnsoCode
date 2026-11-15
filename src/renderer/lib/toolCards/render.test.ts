import { describe, expect, it } from 'vitest';
import { mergeRuns } from './group';
import { cronPhrase, formatStamp, shortId } from './phrase';
import { cardPlainText, presentToolCalls, renderToolCall, usesToolCard } from './render';
import type { ToolCallInput, ToolCardContext, ToolCardLookup } from './types';

const zh: Record<string, string> = {
  'Send message {{title}}': '发送消息 {{title}}',
  'Stop session {{title}}': '停止会话 {{title}}',
  'Create session {{title}}': '创建会话 {{title}}',
  'Dispatch session {{title}}': '派出会话 {{title}}',
  'Update to-do {{text}}': '更新待办 {{text}}',
  'Add to-do {{text}}': '添加待办 {{text}}',
  'Add schedule {{name}}': '添加定时 {{name}}',
  'Remove schedule {{name}}': '删除定时 {{name}}',
  'Updated {{count}} to-dos': '更新了 {{count}} 条待办',
  'Sent {{count}} messages': '发了 {{count}} 条消息',
  Delivered: '已送达',
  'Queued until the current turn ends': '已排队（等对方这一轮结束）',
  'Steered into the current turn': '已插话（不等这一轮结束）',
  'Delivered as a new turn (the session was idle)': '已作为新一轮发出（会话空闲）',
  Refused: '被拒绝',
  Stopped: '已停止',
  'Created the session': '已创建',
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
  'List sessions in {{project}}': '列出 {{project}} 的会话',
  'List sessions': '列出会话',
  'List to-dos': '列出待办',
  'Project {{name}}': '项目 {{name}}',
  'To do': '待办',
  'In progress': '进行中',
  Problem: '出问题',
  Done: '完成',
  'Session running': '运行中',
  'Session idle': '空闲',
  'Session needs you': '需要你',
  'Session error': '出错',
  '{{count}} pending': '{{count}} 项待处理',
  'Pending approvals': '待处理审批',
  'Pending questions': '待处理提问',
  'Read session {{title}}': '读取会话 {{title}}',
  User: '用户',
  Assistant: '助手',
  'Uncommitted changes': '有未提交改动',
  'Look at {{name}}': '查看 {{name}}',
  Dimensions: '尺寸',
  'File size': '文件大小',
  'Cleanup candidates · {{count}}': '可清理项 · {{count}}',
  'Clean up {{count}} items': '清理 {{count}} 项',
  'merged into {{refs}}': '已合入 {{refs}}',
  'Not merged yet': '还没合入',
  'Cleanup card': '清理卡片',
  'Clean tree': '工作区干净',
  'No local branch': '没有本机分支',
  'Search memory {{query}} · {{count}}': '搜索记忆 {{query}} · {{count}} 条',
  'Save memory {{title}}': '记住 {{title}}',
  'Delete memory {{title}}': '删除记忆 {{title}}',
  'Web search {{query}}': '搜索 {{query}}',
  'Fetch {{domain}}': '打开 {{domain}}',
  'Custom tool {{name}}': '自造工具 {{name}}',
  'Propose profile changes': '提议修改档案',
  'Propose skill {{name}}': '提议技能 {{name}}',
  'Propose tool {{name}}': '提议工具 {{name}}',
  Name: '名称',
  Autonomy: '自主度',
  'Dispatch limit reached': '已达到同时派发上限',
  'Unknown session': '未知会话',
  'New session': '新会话',
  'Read message {{index}} in {{title}}': '读取 {{title}} 的第 {{index}} 条消息',
  'More text from character {{next}}': '还有正文，从第 {{next}} 字继续',
  'Truncated messages {{indexes}}: read them by index':
    '被截断的消息 {{indexes}}，可用 index 读全文',
  Read: '已读取',
  'Repository status {{project}}': '仓库状态 {{project}}',
  Branch: '分支',
  HEAD: 'HEAD',
  'Working tree': '工作区',
  '{{count}} changed files': '{{count}} 个文件有改动',
  'Against {{ref}}': '对比 {{ref}}',
  '{{ahead}} ahead, {{behind}} behind': '领先 {{ahead}}，落后 {{behind}}',
  'Contains {{sha}}': '是否包含 {{sha}}',
  Yes: '是',
  No: '否',
  Rebase: '变基',
  'Background tasks in {{title}}': '{{title}} 的后台任务',
  '{{count}} running': '{{count}} 个在跑',
  '{{count}} tasks': '{{count}} 个任务',
  '{{count}} calls': '{{count}} 次调用',
  '{{count}} failed': '{{count}} 次失败',
  'Recent tool calls in {{title}}': '{{title}} 最近的工具调用',
  Exited: '已退出',
  Killed: '已终止',
  Succeeded: '成功',
  Failed: '失败',
  Running: '运行中',
  'ran {{duration}}': '已跑 {{duration}}',
  'exit {{code}}': '退出码 {{code}}',
  'Process gone': '进程已不在',
  'Past its deadline': '已过看门狗截止',
  'Unknown task': '未知任务',
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
    expect(sent.title).toBe('发送消息 写发布说明');
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
    expect(queued.title).toBe(`发送消息 ${shortId('missing-session-id')}`);
    expect(queued.status?.label).toBe('已排队（等对方这一轮结束）');
    const steered = renderToolCall(
      call(
        'session_send',
        { conversationId: 'cc52649d-full', message: '先修这个', mode: 'steer' },
        { status: 'steered' }
      ),
      ctx('zh', lookup)
    );
    expect(steered.status).toEqual({ tone: 'ok', label: '已插话（不等这一轮结束）' });
    const idle = renderToolCall(
      call(
        'session_send',
        { conversationId: 'cc52649d-full', message: '换个方向', mode: 'steer' },
        { status: 'sent' }
      ),
      ctx('zh', lookup)
    );
    expect(idle.status?.label).toBe('已作为新一轮发出（会话空闲）');
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
    expect(card.title).toBe('停止会话 写发布说明');
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
    expect(created.title).toBe('创建会话 写 hello');
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
    expect(waiting.title).toBe('派出会话 补单测');
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
    expect(done.title).toBe('更新待办 补工具卡片单测');
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
    expect(missing.title).toBe(`更新待办 ${shortId('d5d1e359-bbbb')}`);
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
    expect(card.title).toBe('添加定时 巡检');
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
    expect(removed.title).toBe('删除定时 巡检');
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
    expect(read.title).toBe('读取会话 写 hello');
    // 会话状态只在徽标里说一次，详情里只剩待处理计数
    expect(read.status).toEqual({ tone: 'neutral', label: '空闲' });
    expect(cardPlainText(read)).toContain('待处理审批');
    expect(cardPlainText(read).match(/空闲/gu)).toHaveLength(1);
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
    expect(info.title).toBe('项目 enso-code');
    expect(cardPlainText(info)).toContain('feat/x · 有未提交改动');
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
    expect(skill.title).toBe('提议技能 ship-it');
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
    expect(tool.title).toBe('提议工具 upper');
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
    expect(search.title).toBe('搜索记忆 发布 · 2 条');
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
    expect(saved.title).toBe('记住 工具卡片别折进过程组');
    expect(cardPlainText(saved)).toContain('根因是折叠把卡片吞了');
    const removed = renderToolCall(
      call(
        'memory_delete',
        { id: 'm1' },
        { status: 'deleted', id: 'm1', title: '周五发版', content: '用户喜欢周五发' }
      ),
      ctx()
    );
    expect(removed.title).toBe('删除记忆 周五发版');
    const web = renderToolCall(
      call(
        'web_search',
        { query: 'enso' },
        'Web search results for "enso"\n\nSources:\n1. [Enso](https://enso.example/docs)\n'
      ),
      ctx()
    );
    expect(web.title).toBe('搜索 enso');
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
    expect(page.title).toBe('打开 enso.example');
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
      '更新待办 补工具卡片单测',
      '更新待办 改秘书渲染',
      '更新待办 补验收脚本',
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

describe('usesToolCard', () => {
  it('普通会话一律按工具行渲染，不看工具名', () => {
    for (const name of [
      'bash',
      'read',
      'edit',
      'grep',
      'mcp__fast_context__fast_context_search',
      'plugin_enso-github__github_list',
      'my_upper_text',
      'memory_search',
      'web_search',
      'todo_item_update',
    ]) {
      expect(usesToolCard(name), name).toBe(false);
    }
  });

  it('秘书会话里秘书工具和自造工具走可读卡片', () => {
    for (const name of [
      'todo_item_update',
      'schedule_add',
      'session_create',
      'memory_search',
      'web_fetch',
      'my_upper_text',
    ]) {
      expect(usesToolCard(name, true), name).toBe(true);
    }
    expect(usesToolCard('bash', true)).toBe(false);
    expect(usesToolCard('read', true)).toBe(false);
    expect(usesToolCard('edit', true)).toBe(false);
    // 插件工具一直由 PluginToolCardSlot 单独渲染，不进这套卡片
    expect(usesToolCard('plugin_enso-github__github_list', true)).toBe(false);
    // 秘书会话里 MCP 走注册表的键值兜底，普通会话里它是原来的工具行
    expect(usesToolCard('mcp__fast_context__fast_context_search', true)).toBe(true);
  });
});

describe('只读核实卡片', () => {
  it('repo_status 显示分支、HEAD、改动、领先落后与提交', () => {
    const card = renderToolCall(
      call(
        'repo_status',
        { projectId: 'p1' },
        {
          projectId: 'p1',
          path: '/repo/alpha',
          branch: 'feat/x',
          head: {
            sha: '9c23a80',
            subject: '<untrusted-content source="repo:p1">合并秘书分支</untrusted-content>',
          },
          commits: [
            {
              sha: '9c23a80',
              subject: '<untrusted-content source="repo:p1">合并秘书分支</untrusted-content>',
              author: '<untrusted-content source="repo:p1">J</untrusted-content>',
              at: 1_700_000_000_000,
            },
          ],
          base: { ref: 'main', ahead: 3, behind: 2 },
          contains: { sha: '9c23a8058', inHead: true },
          changes: { total: 2, files: [{ status: ' M', path: 'src/a.ts' }] },
          operation: { merge: false, rebase: true },
          worktrees: [
            { path: '/repo/alpha', branch: 'feat/x', head: '9c23a80' },
            { path: '/wt/alpha-1', branch: 'feat/y', head: '1234567' },
          ],
        }
      ),
      ctx('zh', { projectName: () => 'enso-code' })
    );
    expect(card.title).toBe('仓库状态 enso-code');
    expect(card.status).toEqual({ tone: 'neutral', label: 'feat/x' });
    const text = cardPlainText(card);
    expect(text).toContain('9c23a80 合并秘书分支');
    expect(text).toContain('2 个文件有改动');
    expect(text).toContain('领先 3，落后 2');
    expect(text).toContain('是否包含 9c23a8058');
    expect(text).toContain('变基');
    expect(text).toContain('/wt/alpha-1');
    expect(text).not.toContain('untrusted-content');
  });

  it('repo_status 拒绝时只显示原因', () => {
    const card = renderToolCall(
      call('repo_status', { path: '/etc' }, 'path-out-of-scope', 'error'),
      ctx('zh')
    );
    expect(card.status).toEqual({ tone: 'error', label: '被拒绝' });
    expect(cardPlainText(card)).toContain('path-out-of-scope');
  });

  it('session_tasks 显示命令、状态与存活判断', () => {
    const card = renderToolCall(
      call(
        'session_tasks',
        { conversationId: 'c1' },
        {
          conversationId: 'c1',
          tasks: [
            {
              taskId: 't1',
              command: '<untrusted-content source="task:c1">pnpm dev</untrusted-content>',
              ranMs: 125_000,
              state: 'running',
              status: 'running',
              alive: false,
            },
            { taskId: 't2', command: 'pnpm test', ranMs: 3_000, state: 'killed', status: 'failed' },
          ],
        }
      ),
      ctx('zh', { sessionTitle: () => '写发布说明' })
    );
    expect(card.title).toBe('写发布说明 的后台任务');
    expect(card.status).toEqual({ tone: 'ok', label: '1 个在跑' });
    const text = cardPlainText(card);
    expect(text).toContain('pnpm dev');
    expect(text).toContain('运行中');
    expect(text).toContain('已跑 2m 5s');
    expect(text).toContain('进程已不在');
    expect(text).toContain('已终止');
    expect(text).not.toContain('untrusted-content');
  });

  it('session_activity 显示工具名、成败与耗时，不带输出', () => {
    const card = renderToolCall(
      call(
        'session_activity',
        { conversationId: 'c1' },
        {
          conversationId: 'c1',
          calls: [
            {
              name: 'bash',
              ok: true,
              durationMs: 1_500,
              at: 1_700_000_000_000,
              command: '<untrusted-content source="session:c1">pnpm typecheck</untrusted-content>',
            },
            { name: 'read', ok: false, durationMs: 20, at: 1_700_000_001_000 },
            { name: 'grep', ok: false, pending: true, at: 1_700_000_002_000 },
          ],
        }
      ),
      ctx('zh', { sessionTitle: () => '写发布说明' })
    );
    expect(card.title).toBe('写发布说明 最近的工具调用');
    expect(card.status).toEqual({ tone: 'error', label: '1 次失败' });
    const text = cardPlainText(card);
    expect(text).toContain('bash');
    expect(text).toContain('成功');
    expect(text).toContain('失败');
    expect(text).toContain('运行中');
    expect(text).toContain('pnpm typecheck');
    expect(text).toContain('2s');
    expect(text).not.toContain('untrusted-content');
  });

  it('session_read 的 index 模式显示全文与续读位置，列表模式标出被截断的消息', () => {
    const single = renderToolCall(
      call(
        'session_read',
        { conversationId: 'c1', index: 7 },
        {
          conversationId: 'c1',
          title: '写发布说明',
          index: 7,
          role: 'assistant',
          totalChars: 40_000,
          offset: 0,
          text: '<untrusted-content source="session:c1">很长的正文</untrusted-content>',
          nextOffset: 30_000,
        }
      ),
      ctx('zh')
    );
    expect(single.title).toBe('读取 写发布说明 的第 7 条消息');
    expect(cardPlainText(single)).toContain('很长的正文');
    expect(cardPlainText(single)).toContain('还有正文，从第 30000 字继续');
    expect(cardPlainText(single)).not.toContain('untrusted-content');

    const list = renderToolCall(
      call(
        'session_read',
        { conversationId: 'c1' },
        {
          conversationId: 'c1',
          title: '写发布说明',
          state: 'idle',
          pending: { approvals: 0, asks: 0 },
          messages: [
            {
              index: 3,
              role: 'assistant',
              text: '<untrusted-content source="session:c1">开头</untrusted-content>',
              truncated: true,
            },
          ],
        }
      ),
      ctx('zh')
    );
    expect(cardPlainText(list)).toContain('被截断的消息 #3');
  });
});

describe('看图与清理卡片', () => {
  it('image_view 显示文件名、缩略图与尺寸', () => {
    // 带 path 参数的工具结果会被追加一行 <source_reference>，卡片只解析第一行 JSON
    const card = renderToolCall(
      call(
        'image_view',
        { path: '/tmp/shot.png' },
        `${JSON.stringify({ path: '/tmp/shot.png', size: 2048, width: 1280, height: 720, mimeType: 'image/png' })}\n<source_reference type="file" path="/tmp/shot.png" />`
      ),
      ctx('zh')
    );
    expect(card.title).toBe('查看 shot.png');
    const image = card.blocks.find((block) => block.kind === 'image');
    expect(image).toMatchObject({ src: 'local-image://posix/tmp/shot.png', alt: 'shot.png' });
    const text = cardPlainText(card);
    expect(text).toContain('1280 × 720');
    expect(text).toContain('2 KB');
  });

  it('image_view 被拒时只显示原因，不显示缩略图', () => {
    const card = renderToolCall(
      call('image_view', { path: '/Users/me/x.png' }, 'path is out of scope', 'error'),
      ctx('zh')
    );
    expect(card.status).toEqual({ tone: 'error', label: '被拒绝' });
    expect(card.blocks.some((block) => block.kind === 'image')).toBe(false);
    expect(cardPlainText(card)).toContain('path is out of scope');
  });

  it('cleanup_list 列出条目、合入基线与占用空间', () => {
    const card = renderToolCall(
      call(
        'cleanup_list',
        {},
        {
          items: [
            {
              id: 'branch|/repo|feat/done',
              kind: 'branch',
              name: 'feat/done',
              mergedInto: ['feat/secretary-agent'],
            },
            {
              id: 'worktree|/wt/1',
              kind: 'worktree',
              name: 'feat/wt',
              mergedInto: ['main'],
              sizeBytes: 5 * 1024 * 1024,
            },
            {
              id: 'branch|/repo|feat/open',
              kind: 'branch',
              name: 'feat/open',
              blocked: 'not-merged',
            },
          ],
        }
      ),
      ctx('zh')
    );
    expect(card.title).toBe('可清理项 · 3');
    const text = cardPlainText(card);
    expect(text).toContain('feat/done');
    expect(text).toContain('已合入 feat/secretary-agent');
    expect(text).toContain('5.0 MB');
    expect(text).toContain('还没合入');
  });

  it('cleanup_apply 等确认卡时显示等待状态', () => {
    const card = renderToolCall(
      call(
        'cleanup_apply',
        { ids: ['branch|/repo|feat/done'] },
        { status: 'awaiting_confirmation', proposalId: 'pr9' }
      ),
      ctx('zh', { proposal: () => ({ status: 'pending', kind: 'cleanup' }) })
    );
    expect(card.title).toBe('清理 1 项');
    expect(card.status?.tone).toBe('pending');
    expect(card.status?.label).toContain('清理卡片');
  });

  it('cleanup_apply 用 all: true 时按 Main 回的总数显示', () => {
    const card = renderToolCall(
      call(
        'cleanup_apply',
        { all: true },
        { status: 'awaiting_confirmation', proposalId: 'pr9', total: 7, items: [] }
      ),
      ctx('zh', { proposal: () => ({ status: 'pending', kind: 'cleanup' }) })
    );
    expect(card.title).toBe('清理 7 项');
  });
});
