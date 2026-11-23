/**
 * dcg rule_id → 中文解释。rule_id 取自 dcg v0.16.0 二进制 `dcg pack info <pack> --json`
 * 与 `dcg --robot test` 实测输出，不要凭空添加。alt 只放确定不会造成数据丢失的替代，拿不准就不给。
 */
export interface DcgRuleHint {
  zh: string;
  why: string;
  alt?: string;
}

const STASH = 'git stash';
const LEASE = 'git push --force-with-lease';

export const DCG_RULE_HINTS: Readonly<Record<string, DcgRuleHint>> = {
  // core.filesystem
  'core.filesystem:rm-rf-root-home': {
    zh: '递归强制删除根目录或用户主目录',
    why: '会删掉系统文件或全部个人数据，不进废纸篓，无法恢复。',
  },
  'core.filesystem:rm-r-f-separate-root-home': {
    zh: '用分开的 -r -f 参数递归强制删除根目录或用户主目录',
    why: '与 rm -rf / 等价，会删掉系统文件或全部个人数据，无法恢复。',
  },
  'core.filesystem:rm-recursive-force-root-home': {
    zh: '用 --recursive --force 递归强制删除根目录或用户主目录',
    why: '与 rm -rf / 等价，会删掉系统文件或全部个人数据，无法恢复。',
  },
  'core.filesystem:rm-rf-general': {
    zh: '递归强制删除目录（rm -rf）',
    why: '不经确认直接删除，不进废纸篓；路径写错或通配符展开过宽会误删。',
  },
  'core.filesystem:rm-r-f-separate': {
    zh: '用分开的 -r -f 参数递归强制删除',
    why: '与 rm -rf 等价，不经确认直接删除，无法恢复。',
  },
  'core.filesystem:rm-recursive-force-long': {
    zh: '用 --recursive --force 递归强制删除',
    why: '与 rm -rf 等价，不经确认直接删除，无法恢复。',
  },
  'core.filesystem:rm-recursive-general': {
    zh: '递归删除目录（rm -r）',
    why: '会删掉整棵目录树，可写文件不会逐个确认，删除后无法恢复。',
  },
  'core.filesystem:rm-glob-home': {
    zh: '在用户主目录下用通配符删除文件',
    why: '通配符由 shell 展开，实际删除范围事先看不到，可能远超预期。',
  },
  'core.filesystem:find-delete-general': {
    zh: '用 find … -delete 批量删除匹配文件',
    why: '效果等同递归删除匹配到的整棵树，条件写宽就会误删。',
  },
  'core.filesystem:find-delete-root-home': {
    zh: '对根目录、主目录或系统目录执行 find … -delete',
    why: '可能批量删掉系统文件或个人数据，无法恢复。',
  },
  'core.filesystem:unlink-general': {
    zh: '用 unlink 删除文件',
    why: '等同 rm 删除单个文件，不进废纸篓。',
  },
  'core.filesystem:truncate-zero-general': {
    zh: '用 truncate 截断或清空文件',
    why: '文件内容会被直接截掉，无法恢复。',
  },
  'core.filesystem:shred-general': {
    zh: '用 shred 粉碎文件内容',
    why: '多次覆写文件，连取证工具都无法恢复。',
  },
  'core.filesystem:dd-overwrite-general': {
    zh: '用 dd of=<文件> 覆写文件内容',
    why: '目标文件原内容会被就地覆盖，无法恢复。',
  },
  'core.filesystem:mv-dynamic-path': {
    zh: '对含变量展开或转义路径的文件执行 mv',
    why: '实际路径要到运行时才确定，可能把重要文件移走或覆盖同名文件。',
  },
  'core.filesystem:credential-file-write': {
    zh: '写入凭据、私钥或登录 shell 启动文件（如 ~/.ssh、~/.aws/credentials、~/.zshrc）',
    why: '可能覆盖密钥、泄露凭据或植入每次登录都会执行的代码。',
  },
  'core.filesystem:git-internals-write': {
    zh: '直接改写 .git 目录内部文件',
    why: '可能损坏仓库，或写入 git 会自动执行的 hook / 配置。',
  },
  'core.filesystem:redirect-truncate-dynamic-path': {
    zh: '用 > 重定向写入一个含变量展开的路径',
    why: '实际目标要到运行时才确定，可能清空某个重要文件。',
  },
  'core.filesystem:fork-bomb': {
    zh: 'fork 炸弹：无限递归创建进程',
    why: '会耗尽系统资源导致机器卡死，只能强制重启。',
  },
  'core.filesystem:powershell-remove-item-recursive': {
    zh: '用 PowerShell Remove-Item -Recurse 递归删除',
    why: '与 rm -rf 等价，不进回收站，无法恢复。',
  },
  // core.git
  'core.git:reset-hard': {
    zh: '丢弃工作区和暂存区的全部未提交改动（git reset --hard）',
    why: '从未提交过的改动会彻底丢失，git 也找不回来。',
    alt: STASH,
  },
  'core.git:reset-merge': {
    zh: '用 git reset --merge 回退',
    why: '可能丢失未提交的改动。',
    alt: STASH,
  },
  'core.git:clean-force': {
    zh: '强制删除所有未跟踪文件（git clean -f）',
    why: '未跟踪文件从未进过 git，删掉就无法恢复。',
    alt: 'git clean -n',
  },
  'core.git:push-force-long': {
    zh: '强制推送（git push --force）覆盖远端分支',
    why: '会覆盖远端历史，别人已推送的提交可能被抹掉。',
    alt: LEASE,
  },
  'core.git:push-force-short': {
    zh: '强制推送（git push -f）覆盖远端分支',
    why: '会覆盖远端历史，别人已推送的提交可能被抹掉。',
    alt: LEASE,
  },
  'core.git:push-force-refspec': {
    zh: '用 + 前缀 refspec 强制推送',
    why: '等同对该分支强制推送，会覆盖远端历史。',
  },
  'core.git:checkout-discard': {
    zh: '用 git checkout -- 丢弃文件的未提交改动',
    why: '被丢弃的改动从未提交过，无法恢复。',
    alt: STASH,
  },
  'core.git:checkout-discard-cwd': {
    zh: '用 git checkout . 丢弃当前路径下全部未提交改动',
    why: '被丢弃的改动从未提交过，无法恢复。',
    alt: STASH,
  },
  'core.git:checkout-ref-discard': {
    zh: '用 git checkout <ref> -- <路径> 覆盖工作区文件',
    why: '工作区里这些文件的未提交改动会被覆盖，无法恢复。',
    alt: STASH,
  },
  'core.git:checkout-force': {
    zh: '强制切换分支（git checkout -f）',
    why: '会丢弃已跟踪文件的全部未提交改动。',
    alt: STASH,
  },
  'core.git:switch-discard': {
    zh: '丢弃改动并切换分支（git switch --discard-changes / -f）',
    why: '会丢弃已跟踪文件的全部未提交改动。',
    alt: STASH,
  },
  'core.git:restore-worktree': {
    zh: '用 git restore 还原工作区文件',
    why: '会丢弃这些文件的未提交改动，无法恢复。',
    alt: STASH,
  },
  'core.git:restore-worktree-explicit': {
    zh: '用 git restore --worktree 还原工作区文件',
    why: '会丢弃这些文件的未提交改动，无法恢复。',
    alt: STASH,
  },
  'core.git:branch-delete': {
    zh: '删除本地分支',
    why: '分支上未合并、未推送的提交会失去引用，之后难以找回。',
  },
  'core.git:branch-force-delete': {
    zh: '强制删除分支或强制改写分支指向（git branch -D / -f）',
    why: '即使有未合并的提交也会删掉，提交失去引用后难以找回。',
  },
  'core.git:stash-clear': {
    zh: '清空全部 stash（git stash clear）',
    why: '所有暂存的改动会一次性删除。',
    alt: 'git stash list',
  },
  'core.git:filter-branch': {
    zh: '用 git filter-branch 改写仓库历史',
    why: '会改写大量提交，操作不当会永久丢失提交。',
  },
  'core.git:reflog-expire-now': {
    zh: '立即清空 reflog',
    why: 'reflog 是找回误删提交的最后手段，清空后就找不回了。',
  },
  'core.git:rm-force': {
    zh: '强制删除文件（git rm -f）',
    why: '即使文件有未提交改动也会删掉，改动无法恢复。',
  },
  // heredoc / system.disk
  'heredoc.posix:pipeline-consumer': {
    zh: '把下载或其它程序的输出直接管道给 shell 执行（如 curl … | sh）',
    why: '执行的内容事先看不到，可能运行任意代码。',
  },
  'system.disk:dd-device': {
    zh: '用 dd 写入块设备',
    why: '会覆盖整个磁盘或分区上的全部数据。',
  },
  'system.disk:mkfs': {
    zh: '格式化分区（mkfs）',
    why: '会清除该分区上的全部数据。',
  },
  'system.disk:diskutil-erase': {
    zh: '用 diskutil 抹掉磁盘或宗卷',
    why: '会清除目标磁盘或宗卷上的全部数据。',
  },
};

export interface DcgGuardExplanation {
  what: string;
  why?: string;
  alt?: string;
}

/** 查表给出中文解释；查不到回退 dcg 英文 reason */
export function explainDcgGuard(guard: { ruleId: string; reason: string }): DcgGuardExplanation {
  const hint = Object.hasOwn(DCG_RULE_HINTS, guard.ruleId) ? DCG_RULE_HINTS[guard.ruleId] : null;
  if (!hint) return { what: guard.reason };
  return { what: hint.zh, why: hint.why, ...(hint.alt ? { alt: hint.alt } : {}) };
}
