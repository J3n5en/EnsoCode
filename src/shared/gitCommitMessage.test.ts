import { describe, expect, it } from 'vitest';
import {
  cleanCommitMessage,
  DEFAULT_GIT_COMMIT_PROMPT,
  GIT_COMMIT_DIFF_MAX_CHARS,
  GIT_COMMIT_PROMPT_MAX_CHARS,
  gitCommitConfigIssue,
  parseGenerateCommitMessageAbort,
  parseGenerateCommitMessageRequest,
  parseGitCommitPromptWrite,
  redactSensitiveDiff,
  selectCommitDiff,
  truncateCommitDiff,
} from './gitCommitMessage';

describe('DEFAULT_GIT_COMMIT_PROMPT', () => {
  it('写明单条输出、Conventional Commits、72 字符、不解释不加围栏', () => {
    expect(DEFAULT_GIT_COMMIT_PROMPT).toMatch(/exactly one commit message/i);
    expect(DEFAULT_GIT_COMMIT_PROMPT).toContain('Conventional Commits');
    expect(DEFAULT_GIT_COMMIT_PROMPT).toContain('72');
    expect(DEFAULT_GIT_COMMIT_PROMPT).toMatch(/no explanations/i);
    expect(DEFAULT_GIT_COMMIT_PROMPT).toMatch(/code fences/i);
  });
});

describe('cleanCommitMessage', () => {
  it('去掉代码围栏，取围栏内正文', () => {
    expect(cleanCommitMessage('```\nfeat: add x\n```')).toBe('feat: add x');
    expect(
      cleanCommitMessage('Here you go:\n```text\nfix(ui): y\n\nbody line\n```\nHope it helps')
    ).toBe('fix(ui): y\n\nbody line');
  });

  it('去掉 commit: / Commit message: 前缀与包裹引号', () => {
    expect(cleanCommitMessage('commit: feat: add x')).toBe('feat: add x');
    expect(cleanCommitMessage('Commit message: "fix: y"')).toBe('fix: y');
    expect(cleanCommitMessage('Commit message:\n\nchore: z')).toBe('chore: z');
    expect(cleanCommitMessage('`docs: readme`')).toBe('docs: readme');
  });

  it('保留正文 body，遇到第二条候选 message 截断', () => {
    expect(cleanCommitMessage('feat: a\n\n- detail one\n- detail two\n\nfix: b')).toBe(
      'feat: a\n\n- detail one\n- detail two'
    );
    expect(cleanCommitMessage('1. feat: a\n2. fix: b')).toBe('feat: a');
    expect(cleanCommitMessage('feat: a\n---\nfix: b')).toBe('feat: a');
  });

  it('body 里的 --- 分隔与带类型前缀的编号列表原样保留', () => {
    expect(cleanCommitMessage('feat: a\n\nIntro\n\n---\n\nMore details')).toBe(
      'feat: a\n\nIntro\n\n---\n\nMore details'
    );
    expect(
      cleanCommitMessage('feat(git): add generator\n\n1. fix: handle empty diff\n2. docs: readme')
    ).toBe('feat(git): add generator\n\n1. fix: handle empty diff\n2. docs: readme');
    expect(cleanCommitMessage('feat: a\n\nbody\n\n---')).toBe('feat: a\n\nbody');
  });

  it('剥掉思考标签与多余空行', () => {
    expect(cleanCommitMessage('<think>hmm</think>\n\nfeat: a\n\n\n\nbody  ')).toBe(
      'feat: a\n\nbody'
    );
  });

  it('空输出返回空串', () => {
    expect(cleanCommitMessage('```\n```')).toBe('');
    expect(cleanCommitMessage('   ')).toBe('');
  });
});

describe('redactSensitiveDiff', () => {
  const chunk = (file: string, body: string) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${body}\n`;
  it.each([
    '.env',
    'apps/web/.env.local',
    '.envrc',
    'certs/server.pem',
    'tls.KEY',
    'keys/id_rsa',
    'home/.ssh/id_ed25519.pub',
    'store.p12',
    '.npmrc',
  ])('%s 只留文件头，内容替换为说明', (file) => {
    const out = redactSensitiveDiff(chunk(file, 'TOP-SECRET'));
    expect(out).toContain(`diff --git a/${file} b/${file}`);
    expect(out).toContain('content omitted');
    expect(out).not.toContain('TOP-SECRET');
  });
  it('普通文件与相邻块不受影响', () => {
    const diff = `${chunk('.env', 'S')}${chunk('src/env.ts', 'ok')}${chunk('docs/key.md', 'ok2')}`;
    const out = redactSensitiveDiff(diff);
    expect(out).toContain('+ok\n');
    expect(out).toContain('+ok2\n');
    expect(out).not.toContain('+S\n');
  });
  it('带引号的路径也能识别', () => {
    const out = redactSensitiveDiff('diff --git "a/x\\ty/.env" "b/x\\ty/.env"\n+SECRET\n');
    expect(out).not.toContain('SECRET');
  });
});

describe('selectCommitDiff', () => {
  it('staged 优先', () => {
    expect(selectCommitDiff({ staged: 'S', unstaged: 'U' })).toEqual({
      source: 'staged',
      diff: 'S',
    });
  });
  it('staged 为空时取 unstaged', () => {
    expect(selectCommitDiff({ staged: '  \n', unstaged: 'U' })).toEqual({
      source: 'unstaged',
      diff: 'U',
    });
  });
  it('都为空返回 null', () => {
    expect(selectCommitDiff({ staged: '', unstaged: '\n' })).toBeNull();
  });
});

describe('truncateCommitDiff', () => {
  it('未超限原样返回', () => {
    expect(truncateCommitDiff('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
  it('超限按行截断并明确标注 truncated', () => {
    const diff = `${'a'.repeat(6)}\n${'b'.repeat(6)}\n${'c'.repeat(6)}`;
    const result = truncateCommitDiff(diff, 10);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('aaaaaa\n')).toBe(true);
    expect(result.text).not.toContain('bbb');
    expect(result.text).toContain('[diff truncated');
  });
  it('默认上限 200k 字符', () => {
    expect(GIT_COMMIT_DIFF_MAX_CHARS).toBe(200_000);
    const big = 'x'.repeat(GIT_COMMIT_DIFF_MAX_CHARS + 50);
    const result = truncateCommitDiff(big);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(GIT_COMMIT_DIFF_MAX_CHARS + 200);
  });
});

describe('gitCommitConfigIssue', () => {
  const providers = [{ id: 'p1', models: [{ id: 'm1' }, { id: 'm2', enabled: false }] }];
  it('未选择 → provider', () => {
    expect(gitCommitConfigIssue(null, providers)).toBe('provider');
    expect(gitCommitConfigIssue({ providerId: '', modelId: 'm1' }, providers)).toBe('provider');
  });
  it('供应商不可用 → provider', () => {
    expect(gitCommitConfigIssue({ providerId: 'gone', modelId: 'm1' }, providers)).toBe('provider');
  });
  it('模型缺失或停用 → model', () => {
    expect(gitCommitConfigIssue({ providerId: 'p1', modelId: '' }, providers)).toBe('model');
    expect(gitCommitConfigIssue({ providerId: 'p1', modelId: 'x' }, providers)).toBe('model');
    expect(gitCommitConfigIssue({ providerId: 'p1', modelId: 'm2' }, providers)).toBe('model');
  });
  it('配置完整 → null', () => {
    expect(gitCommitConfigIssue({ providerId: 'p1', modelId: 'm1' }, providers)).toBeNull();
  });
});

describe('IPC 入参收窄', () => {
  it('生成请求：坏输入拒绝', () => {
    for (const bad of [
      null,
      'x',
      [],
      {},
      { conversationId: 'c', projectId: 'p' },
      { conversationId: 'c', projectId: 'p', requestId: '' },
      { conversationId: 1, projectId: 'p', requestId: 'r' },
      { conversationId: 'c', projectId: 'p', requestId: 'r'.repeat(200) },
    ]) {
      expect(parseGenerateCommitMessageRequest(bad)).toBeNull();
    }
    expect(
      parseGenerateCommitMessageRequest({
        conversationId: 'c',
        projectId: 'p',
        requestId: 'r',
        x: 1,
      })
    ).toEqual({ conversationId: 'c', projectId: 'p', requestId: 'r' });
  });
  it('取消请求：只收 requestId', () => {
    expect(parseGenerateCommitMessageAbort({})).toBeNull();
    expect(parseGenerateCommitMessageAbort({ requestId: 2 })).toBeNull();
    expect(parseGenerateCommitMessageAbort({ requestId: 'r' })).toEqual({ requestId: 'r' });
  });
  it('提示词写入：只收文本，拒绝空、超长、NUL 与路径字段', () => {
    expect(parseGitCommitPromptWrite({ text: '  ' })).toBeNull();
    expect(parseGitCommitPromptWrite({ text: 'a\0b' })).toBeNull();
    expect(
      parseGitCommitPromptWrite({ text: 'a'.repeat(GIT_COMMIT_PROMPT_MAX_CHARS + 1) })
    ).toBeNull();
    expect(parseGitCommitPromptWrite({ text: 1 })).toBeNull();
    expect(parseGitCommitPromptWrite({ text: 'rules', path: '/etc/x' })).toEqual({ text: 'rules' });
  });
});
