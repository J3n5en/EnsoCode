/**
 * dcg rule_id → 中文解释。rule_id 取自 dcg v0.16.0 二进制 `dcg pack info <pack> --json`
 * 与 `dcg --robot test` 实测输出、0.17.2 复核，不要凭空添加。alt 只放确定不会造成数据丢失的替代，拿不准就不给。
 * 新版本删掉的规则会在这里查不到，界面回退成 dcg 英文原因，不会显示空。
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
  // core.filesystem 其余已实测规则（0.17.2）
  'core.filesystem:unlink-root-home': {
    zh: '用 unlink 删除系统或主目录下的文件',
    why: '删除的是系统文件或个人数据，不进废纸篓，无法恢复。',
  },
  'core.filesystem:truncate-zero-root-home': {
    zh: '用 truncate 截断系统或主目录下的文件',
    why: '目标文件是个人数据或系统文件，内容会被直接截掉，无法恢复。',
  },
  'core.filesystem:shred-root-home': {
    zh: '用 shred 粉碎系统或主目录下的文件',
    why: '多次覆写个人数据或系统文件，连取证工具都无法恢复。',
  },
  'core.filesystem:dd-overwrite-root-home': {
    zh: '用 dd of= 覆写系统或主目录下的文件',
    why: '目标文件是个人数据或系统文件，原内容会被就地覆盖，无法恢复。',
  },
  'core.filesystem:mv-sensitive-source-root-home': {
    zh: '用 mv 移动敏感系统路径或主目录下的路径',
    why: '可能把密钥、系统文件或整个个人目录移走，等同删除原位置的副本。',
  },
  'core.filesystem:cp-sensitive-then-delete': {
    zh: '把敏感路径复制进临时目录后强制递归删除',
    why: '分段的复制加删除组合：删掉的那一份可能顺着链接指向密钥或个人数据。',
  },
  'core.filesystem:ln-symlink-sensitive-then-delete': {
    zh: '把敏感路径软链进临时目录后强制递归删除',
    why: '沿软链接递归删除会删掉链接背后的真实数据，而不只是链接本身。',
  },
  'core.filesystem:rsync-sensitive-then-delete': {
    zh: '用 rsync 归档敏感路径进临时目录后强制递归删除',
    why: '分段的同步加删除组合，可能顺着归档内容删掉密钥或个人数据。',
  },
  'core.filesystem:rsync-delete-sensitive-dest': {
    zh: '用 rsync --delete 同步进系统目录或主目录根',
    why: '--delete 会删掉目标里源端没有的所有文件，等于镜像清空系统目录或主目录。',
  },
  'core.filesystem:redirect-truncate-git-internals-relative': {
    zh: '用 > 重定向截断写入 .git 目录内部文件',
    why: '会改写仓库内部结构或配置，可能损坏仓库或植入 git 自动执行的内容。',
  },
  'core.filesystem:redirect-append-git-internals-relative': {
    zh: '用 >> 重定向追加写入 .git 目录内部文件',
    why: '追加的内容可能污染仓库配置或 hook，git 后续操作会执行它。',
  },
  'core.filesystem:tar-remove-files-general': {
    zh: '用 tar --remove-files 归档后删除源文件',
    why: '源文件在归档后即被删除；归档损坏或路径写错就只剩一份未必可用的压缩包。',
  },
  'core.filesystem:tar-remove-files-root-home': {
    zh: '用 tar --remove-files 归档系统或主目录下的文件后删除源',
    why: '等同删除个人数据或系统文件，只留压缩包，恢复失败就是永久丢失。',
  },
  'core.filesystem:format-volume': {
    zh: '用 PowerShell Format-Volume 格式化卷',
    why: '会清除该卷上的全部数据，无法恢复。',
  },
  'core.filesystem:clear-disk': {
    zh: '用 PowerShell Clear-Disk 清空磁盘',
    why: '会移除磁盘的全部分区和数据，无法恢复。',
  },
  'core.filesystem:vssadmin-delete-shadows': {
    zh: '用 vssadmin delete shadows 删除卷影副本',
    why: '卷影副本是系统还原与备份的最后防线，删除后无法恢复误删文件。',
  },
  'core.filesystem:wmic-shadowcopy-delete': {
    zh: '用 wmic shadowcopy delete 删除卷影副本',
    why: '卷影副本是系统还原与备份的最后防线，删除后无法恢复误删文件。',
  },
  'core.filesystem:wmi-shadowcopy-delete': {
    zh: '删除 Win32_ShadowCopy 卷影副本实例',
    why: '卷影副本是系统还原与备份的最后防线，删除后无法恢复误删文件。',
  },
  'core.filesystem:sed-exec-unverified': {
    zh: 'GNU sed 执行了无法静态确认的 shell 输入',
    why: '实际执行的命令由运行时内容决定，可能是任意代码。',
  },
  'core.filesystem:tar-exec-unverified': {
    zh: 'GNU tar 执行了无法静态确认的辅助命令',
    why: '实际执行的命令由运行时内容决定，可能是任意代码。',
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
  // core.git 其余已实测规则（0.17.2）
  'core.git:branch-dynamic-token': {
    zh: 'git branch 命令里包含运行时展开的 shell 变量或命令替换',
    why: '展开后的内容可能是删除参数，实际影响哪些分支事先看不到。',
  },
  'core.git:update-ref-delete': {
    zh: '用 git update-ref -d 删除引用（分支、标签等）',
    why: '引用删除后未推送的提交失去入口，之后难以找回。',
  },
  'core.git:read-tree-reset': {
    zh: '用 git read-tree --reset -u 覆写工作区',
    why: '效果等同 git reset --hard，未提交改动会彻底丢失。',
    alt: STASH,
  },
  'core.git:show-redirect-overwrite-source': {
    zh: '把 git show 的输出重定向回同一个源文件',
    why: '会用历史版本覆盖工作区文件，未提交改动丢失。',
    alt: STASH,
  },
  'core.git:stash-drop': {
    zh: '删除单个 stash（git stash drop）',
    why: '被删的暂存只能通过 git fsck 找回 unreachable 对象，且不一定成功。',
    alt: 'git stash list',
  },
  'core.git:lfs-migrate-rewrite': {
    zh: '用 git lfs migrate 改写仓库历史',
    why: '范围内所有提交的哈希都会改变，操作不当会永久丢失提交。',
  },
  'core.git:lfs-prune': {
    zh: '清理本地 LFS 对象（git lfs prune）',
    why: '带 --force 时会删掉远端未必还存在的对象副本。',
  },
  'core.git:lfs-uninstall': {
    zh: '卸载 LFS 过滤器与 hook（git lfs uninstall）',
    why: '之后检出的 LFS 文件会变成指针文本，仓库内容看似损坏。',
  },
  'core.git:git-alias-semantic-unverified': {
    zh: '调用的 git alias 依赖 shell 展开、存在循环或超出分析深度',
    why: '别名实际执行的命令事先无法确认，可能是破坏性操作。',
  },
  // system.processes（0.17.2 新增 pack，需 0.17.2+ 二进制）
  'system.processes:pkill': {
    zh: '用 pkill 按名字或命令行模式批量杀进程',
    why: '共享机器上会误杀同名的其他终端、应用和其他 agent 的工作。',
  },
  'system.processes:killall': {
    zh: '用 killall 按名字批量杀进程',
    why: '会杀掉所有同名进程，包括别人正在运行的工作。',
  },
  'system.processes:kill-every-process': {
    zh: '用 kill -1 向自己拥有的全部进程发信号',
    why: '会同时影响所有应用、终端和 agent 会话，等同注销整个用户会话。',
  },
  'system.processes:kill-computed-pids': {
    zh: 'kill 的目标 PID 由命令替换在运行时算出',
    why: '算出来的 PID 事先看不到，可能杀错进程。',
  },
  'system.processes:xargs-kill': {
    zh: '把进程查询结果管道进 xargs kill',
    why: '杀掉的是查询匹配到的一切，匹配写宽就会误杀。',
  },
  'system.processes:find-exec-kill': {
    zh: '用 find -exec kill 按文件搜索杀进程',
    why: '杀掉的是文件搜索匹配到的一切，条件写宽就会误杀。',
  },
  'system.processes:pid-lookup-feeds-kill': {
    zh: '把 pgrep / pidof / lsof / ps 的查询结果喂给 kill',
    why: '模式匹配的进程集合事先看不到，可能误杀同名进程。',
  },
  'system.processes:ssh-remote-pattern-kill': {
    zh: '通过 ssh 在远端机器上按模式批量杀进程',
    why: '远端共享机器上会误杀别人的工作，且无法当场看到影响范围。',
  },
  'system.processes:interpreter-signals-everything': {
    zh: '内联脚本向全部进程或进程组广播信号',
    why: 'os.kill(-1)、process.kill(-1) 等会影响机器上的一切进程。',
  },
  'system.processes:launchctl-bootout-domain': {
    zh: '用 launchctl bootout 踢出整个 launchd 域',
    why: '会停掉该用户会话里的所有应用与 agent，等同强制注销。',
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
