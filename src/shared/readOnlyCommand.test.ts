import { describe, expect, it } from 'vitest';
import { firstProgram, isReadOnlyCommand } from './readOnlyCommand';

describe('isReadOnlyCommand', () => {
  it.each([
    'ls -la',
    'rg -n "foo" src',
    'grep -r foo . | head -20',
    'cat package.json',
    'find . -name "*.ts" | wc -l',
    'git status && git log --oneline -5',
    'cd packages/phone && ls src',
    'LC_ALL=C rg foo 2>/dev/null',
    'rg foo 2>&1 | sort | uniq -c',
    '/usr/bin/tree -L 2',
    'sed -n 1,20p src/a.ts',
    "sed -n '/foo/p' a.ts",
    'git diff --stat',
    'git remote -v',
    'git config --get user.name',
    'LC_ALL=C sort a.txt',
    "awk -F: '{print $1}' /etc/passwd",
    'yq .a f.yml',
    'git branch',
    'git branch -a',
    'git branch --list "feat/*"',
    'git tag -l',
    'git --no-pager log -3',
    'uniq -c a.txt',
    'fd ts src',
    'git -C /repo status --short',
    'node --version && git -C /repo log --oneline -3 2>/dev/null | head -5',
    'python3 --version',
    'pnpm -v',
    // 写参数识别放宽到组合短参数后，不含写字母的组合仍是只读
    'sort -rn a.txt',
    'fd -H ts src',
    "awk -F, '{print $1}' a.csv",
    '/bin/ls -la',
  ])('只读：%s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });

  it.each([
    'rm -rf dist',
    'ls > out.txt',
    'cat a >> b',
    'sed -i "s/a/b/" x',
    'find . -name "*.log" -delete',
    'find . -exec rm {} \\;',
    'git commit -m x',
    'git checkout -- .',
    'ls && npm install',
    'echo $(rm -rf x)',
    'pnpm test',
    'xargs rm',
    '',
    // 绕过向量
    'ls & rm -rf x',
    'cat <(rm -rf x)',
    'env rm -rf x',
    'awk \'BEGIN{system("rm -rf x")}\' a.txt',
    "sed 's/a/b/e' a.txt",
    'sed --in-place=.bak s/a/b/ x',
    'yq -i .a=1 f.yml',
    'sort -o out.txt in.txt',
    'git log --output=/tmp/x',
    'find . -execdir rm {} \\;',
    'find . -fprint /tmp/x',
    'git config --unset user.name',
    'git remote remove origin',
    'GIT_EXTERNAL_DIFF=./evil git diff',
    'rg foo 2>err.txt',
    'ls\rrm -rf x',
    // Plan 模式加固
    'rg --pre ./evil foo',
    'rg --pre=./evil foo',
    'LESSOPEN="|rm -rf x" less a.txt',
    'RIPGREP_CONFIG_PATH=./evil rg foo',
    'FOO=1 rg foo',
    'git -ccore.pager=evil log',
    'git -c core.pager=evil log',
    'git branch new-feature',
    'git tag v1.0.0',
    'git reflog expire --all',
    'git grep -O foo',
    'git diff --ext-diff',
    "sed 's/a/b/w out.txt' a.txt",
    "sed -n '1w out.txt' a.txt",
    'uniq in.txt out.txt',
    'tree -o out.txt',
    'fd -x rm',
    'fd . --exec-batch rm',
    'sort --compress-program=./evil a.txt',
    'awk -f evil.awk a.txt',
    'awk -i inplace "{print}" a.txt',
    'file -C -m magic',
    'bat --pager="sh -c evil" a.txt',
    'date -s 2020-01-01',
    "node -e \"require('fs').rmSync('x')\"",
    'node --version --eval x',
    'git -C',
    'python3 script.py',
    // 组合短参数 / 粘连参数 / 被空白拆开的 system( / 与只读工具同名的项目脚本
    'sort -uo out.txt in.txt',
    'fd -Hx rm {}',
    'fd -HX rm',
    'awk -fevil.awk a.txt',
    'awk \'BEGIN{system ("rm -rf x")}\'',
    './scripts/cat a.txt',
    '/tmp/evil/cat a.txt',
    'yq -s .a f.yml',
    'yq --split-exp .a f.yml',
  ])('非只读：%s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
  });
});

describe('firstProgram', () => {
  it('跳过环境变量前缀并去掉路径', () => {
    expect(firstProgram('LC_ALL=C /usr/bin/cat a')).toBe('cat');
  });
});
