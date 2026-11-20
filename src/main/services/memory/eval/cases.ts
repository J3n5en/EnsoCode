import type { UnitType } from '@shared/memory/constants';

/** 用例维度；README 与报告按此分组 */
export const EVAL_DIMENSIONS = [
  'exact',
  'semantic',
  'crossLingual',
  'temporal',
  'entity',
  'typeFilter',
  'spaceIsolation',
  'distractor',
] as const;
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

/** project = 当前项目；otherProject = 同库里另一个项目，用来验证隔离 */
export type EvalSpace = 'global' | 'project' | 'otherProject';

export interface EvalEntity {
  name: string;
  type: string;
  aliases?: string[];
}

export interface EvalMemory {
  /** 用例内引用名；运行器写库后映射到真实 id */
  key: string;
  content: string;
  space: EvalSpace;
  unitType: UnitType;
  importance?: number;
  eventStart?: string;
  eventEnd?: string;
  /** 写入时刻（ISO）；缺省按写入顺序递增，保证排序平局可复现 */
  createdAt?: string;
  /** 模拟异步 KG 抽取的结果，直接写实体层 */
  entities?: EvalEntity[];
}

export interface EvalCase {
  id: string;
  dimension: EvalDimension;
  description: string;
  memories: EvalMemory[];
  query: string;
  spaces: EvalSpace[];
  /** 模拟模型在工具参数里显式给出的事件时间窗 */
  eventDateFrom?: string;
  eventDateTo?: string;
  /** 只要某类型：searchMemories 没有类型参数，按 memoryAdmin 语义模式在结果上后过滤 */
  unitType?: UnitType;
  expected: string[];
  excluded: string[];
}

/** 检索时刻：2025-11-20（周四）10:00 +08:00；「上周」= 2025-11-10 ~ 2025-11-16 */
export const EVAL_NOW = '2025-11-20T02:00:00.000Z';

/**
 * 每条用例都会写入的背景库：真实项目里常见、与各用例查询主题无关的记忆。
 * 它们既不在 expected 也不在 excluded，作用是让候选池接近真实规模，
 * 防止「库里只有 3 条，怎么排都在前 10」这种虚高。
 */
export const BACKGROUND_MEMORIES: EvalMemory[] = [
  {
    key: 'bg-lang',
    space: 'global',
    unitType: 'preference',
    content: '回复用中文，代码注释和提交信息保持英文。',
  },
  {
    key: 'bg-shell',
    space: 'global',
    unitType: 'preference',
    content: '终端偏好 zsh + starship，不装 oh-my-zsh，启动要快。',
  },
  {
    key: 'bg-sqlite',
    space: 'project',
    unitType: 'fact',
    content:
      'Main 进程用 better-sqlite3 打开 userData/memory/memory.db，开启 WAL 和 busy_timeout。',
  },
  {
    key: 'bg-path',
    space: 'project',
    unitType: 'decision',
    content: 'Renderer 只传标识符，不传任意磁盘路径；路径由 Main 根据权威记录推导并校验边界。',
  },
  {
    key: 'bg-notarize',
    space: 'project',
    unitType: 'learning',
    content: 'electron-builder 在 macOS 上公证失败，多半是 Apple ID 的应用专用密码过期了。',
  },
  {
    key: 'bg-mirror',
    space: 'global',
    unitType: 'fact',
    content: '公司内网 npm 镜像是 npmmirror 的代理，新发布的包偶尔同步延迟半小时。',
  },
  {
    key: 'bg-codepage',
    space: 'project',
    unitType: 'learning',
    content: 'Windows 用户反馈 PowerShell 后台任务输出乱码，根因是控制台代码页不是 UTF-8。',
  },
  {
    key: 'bg-virtuoso',
    space: 'project',
    unitType: 'plan',
    content: '下个迭代把会话列表改成虚拟滚动，react-virtuoso 已经在依赖里，不用再引新库。',
  },
  {
    key: 'bg-worker',
    space: 'project',
    unitType: 'fact',
    content: 'worker 与 Main 之间走 MessagePort，每条事件带单调递增的 seq，过期 seq 直接丢弃。',
  },
  {
    key: 'bg-pty',
    space: 'project',
    unitType: 'event',
    content: '11 月初升级 Electron 45 之后 node-pty 需要重新编译，postinstall 脚本已经补上。',
    eventStart: '2025-11-03',
  },
  {
    key: 'bg-font',
    space: 'global',
    unitType: 'preference',
    content: '等宽字体用 JetBrains Mono，字号 13，开启连字。',
  },
  {
    key: 'bg-ipc',
    space: 'project',
    unitType: 'procedure',
    content: '新增 IPC 要同步改三处：通道常量、Main handler 注册、preload 的 typed 出口。',
  },
  {
    key: 'bg-concise',
    space: 'global',
    unitType: 'preference',
    content: '说明文字尽量短，先给结论再给原因。',
  },
  {
    key: 'bg-minutes',
    space: 'global',
    unitType: 'preference',
    content: '会议纪要用要点列表，不要写成大段散文。',
  },
  {
    key: 'bg-gpu',
    space: 'global',
    unitType: 'fact',
    content: '常用的 GPU 机器是一台 4090，显存 24GB，跑 7B 模型够用。',
  },
  {
    key: 'bg-proxy',
    space: 'global',
    unitType: 'fact',
    content: '家里网络访问 GitHub 要走本地代理，端口 7890。',
  },
  {
    key: 'bg-mermaid',
    space: 'global',
    unitType: 'preference',
    content: '画架构图优先用 mermaid，导出 PNG 放进文档。',
  },
  {
    key: 'bg-spotlight',
    space: 'global',
    unitType: 'learning',
    content: 'macOS 上 Spotlight 索引 node_modules 会拖慢磁盘，已在隐私设置里排除。',
  },
  {
    key: 'bg-weekend',
    space: 'global',
    unitType: 'preference',
    content: '周末不处理工作消息，紧急情况直接打电话。',
  },
  {
    key: 'bg-blog',
    space: 'global',
    unitType: 'fact',
    content: '个人博客托管在 Cloudflare Pages，域名在 Namecheap 续费。',
  },
  {
    key: 'bg-settings',
    space: 'project',
    unitType: 'decision',
    content: 'settings.json 不存大段文本，长内容放独立文件，外部实体删除时一并清理本地副本。',
  },
  {
    key: 'bg-apikey',
    space: 'project',
    unitType: 'decision',
    content: 'API key 明文只留在 Main，Renderer 拿到的是脱敏后的占位串。',
  },
  {
    key: 'bg-configcli',
    space: 'project',
    unitType: 'procedure',
    content: '新增设置项要同步 configCli 的 policy.ts 和 docs/config-cli.md。',
  },
  {
    key: 'bg-jsonl',
    space: 'project',
    unitType: 'fact',
    content: '会话正文是可丢弃的投影，worker 写的 jsonl 才是权威源。',
  },
  {
    key: 'bg-telegram',
    space: 'project',
    unitType: 'learning',
    content: 'Telegram 插件长轮询在电脑休眠唤醒后会卡住，要检测时间跳变后主动重连。',
  },
  {
    key: 'bg-kanban',
    space: 'project',
    unitType: 'plan',
    content: '考虑给看板插件加按标签筛选卡片，优先级低。',
  },
  {
    key: 'bg-hotkey',
    space: 'project',
    unitType: 'fact',
    content: '快捷键 Cmd+K 打开命令面板，Cmd+P 切换会话。',
  },
  {
    key: 'bg-mcpenv',
    space: 'project',
    unitType: 'decision',
    content: 'MCP 服务器的 env 只在 Main 展开，不经过 IPC 传给 Renderer。',
  },
  {
    key: 'bg-xterm',
    space: 'project',
    unitType: 'learning',
    content: 'xterm 不开 unicode11 插件时 emoji 宽度会算错，导致光标错位。',
  },
  {
    key: 'bg-users',
    space: 'project',
    unitType: 'context',
    content: '用户群体以中文开发者为主，也有少量日本用户。',
  },
  {
    key: 'bg-updater',
    space: 'project',
    unitType: 'fact',
    content: '自动更新走 electron-updater，更新源是 GitHub Releases。',
  },
  {
    key: 'bg-repro',
    space: 'project',
    unitType: 'procedure',
    content: '界面错位类反馈先让用户在设置里打开调试面板复现，再要截图。',
  },
  {
    key: 'bg-remote',
    space: 'project',
    unitType: 'event',
    content: '10 月中旬远程服务器模式第一次跑通，手机端可以连上桌面会话。',
    eventStart: '2025-10-15',
  },
  {
    key: 'bg-zustand',
    space: 'project',
    unitType: 'event',
    content: '9 月底把渲染层状态管理从 Context 迁到 zustand。',
    eventStart: '2025-09-28',
  },
  {
    key: 'bg-scanner',
    space: 'project',
    unitType: 'decision',
    content: '扫描器按来源定位、格式读取、编排去重三层拆分，单个来源失败不阻断整体。',
  },
  {
    key: 'bg-other-go',
    space: 'otherProject',
    unitType: 'fact',
    content: 'other-app 的后端是 Go 1.23 + gRPC，部署在 k8s。',
  },
  {
    key: 'bg-other-mongo',
    space: 'otherProject',
    unitType: 'decision',
    content: 'other-app 的数据库用 MongoDB，按租户分库。',
  },
  {
    key: 'bg-other-ci',
    space: 'otherProject',
    unitType: 'procedure',
    content: 'other-app 发版走 GitLab CI，打 tag 后自动部署到预发环境。',
  },
];

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'exact-db-choice',
    dimension: 'exact',
    description: '查询词与记忆原文高度重合（产品名 + 版本号 + 中文术语）',
    memories: [
      {
        key: 'pg',
        space: 'project',
        unitType: 'decision',
        content: '数据库选型定为 PostgreSQL 16，放弃 MySQL，主要看重 JSONB 和部分索引。',
      },
      {
        key: 'mysql',
        space: 'project',
        unitType: 'fact',
        content: 'MySQL 8 的 utf8mb4 排序规则要在建库时显式指定，否则默认值随版本变化。',
      },
    ],
    query: 'PostgreSQL 16 数据库选型',
    spaces: ['global', 'project'],
    expected: ['pg'],
    excluded: [],
  },
  {
    id: 'exact-vitest-stub',
    dimension: 'exact',
    description: '查询是记忆里的几个原词拼起来（agent 常见的空格分词写法）',
    memories: [
      {
        key: 'stub',
        space: 'project',
        unitType: 'procedure',
        content: 'vitest 跑主进程测试用 environment: node，electron 模块用 test/stubs 下的桩替换。',
      },
      {
        key: 'e2e',
        space: 'project',
        unitType: 'procedure',
        content: 'server 端 e2e 测试要设 ENSO_RUN_E2E=1 才会执行，默认跳过。',
      },
    ],
    query: 'vitest electron 桩替换',
    spaces: ['global', 'project'],
    expected: ['stub'],
    excluded: [],
  },
  {
    id: 'semantic-dark-theme',
    dimension: 'semantic',
    description: '换说法问偏好：查询与记忆没有任何共同词',
    memories: [
      {
        key: 'dark',
        space: 'global',
        unitType: 'preference',
        content: '编辑器和终端一律用深色配色，浅色主题看久了眼睛疼。',
      },
      {
        key: 'copy',
        space: 'global',
        unitType: 'preference',
        content: '界面文案统一用简体中文，不要中英混排。',
      },
    ],
    query: '用户喜欢什么样的外观风格',
    spaces: ['global', 'project'],
    expected: ['dark'],
    excluded: ['copy'],
  },
  {
    id: 'semantic-flaky-ci',
    dimension: 'semantic',
    description: '用口语描述现象（「不稳定」）去找技术化记录（「偶发超时」）',
    memories: [
      {
        key: 'flaky',
        space: 'project',
        unitType: 'learning',
        content: 'CI 上 e2e 用例偶发超时，原因是 runner 共享 CPU；给 waitFor 加 30s 上限后稳定了。',
      },
      {
        key: 'coverage',
        space: 'project',
        unitType: 'decision',
        content: '单元测试覆盖率目标 80%，新增模块不得低于这个数。',
      },
    ],
    query: '为什么自动化测试时好时坏',
    spaces: ['global', 'project'],
    expected: ['flaky'],
    excluded: ['coverage'],
  },
  {
    id: 'xlang-zh-to-en',
    dimension: 'crossLingual',
    description: '中文查询找英文记忆，双方没有共同的英文术语',
    memories: [
      {
        key: 'narrow',
        space: 'project',
        unitType: 'decision',
        content:
          'Inter-process message payloads are typed as unknown and narrowed with explicit validators; type assertions are not allowed.',
      },
      {
        key: 'retry',
        space: 'project',
        unitType: 'fact',
        content:
          'Network requests to the update server retry three times with exponential backoff.',
      },
    ],
    query: '进程间通信的参数怎么做校验',
    spaces: ['global', 'project'],
    expected: ['narrow'],
    excluded: ['retry'],
  },
  {
    id: 'xlang-en-to-zh',
    dimension: 'crossLingual',
    description: '英文查询找中文记忆',
    memories: [
      {
        key: 'review',
        space: 'project',
        unitType: 'decision',
        content: '合并请求必须至少一位同事审核通过才能合入主干。',
      },
      {
        key: 'force',
        space: 'project',
        unitType: 'fact',
        content: '主干分支禁止强推，误操作要找管理员从备份恢复。',
      },
    ],
    query: 'pull request approval rule before merging',
    spaces: ['global', 'project'],
    expected: ['review'],
    excluded: ['force'],
  },
  {
    id: 'temporal-last-week-filter',
    dimension: 'temporal',
    description: '「上周」由模型换算成 eventDate 过滤参数；同类事件分布在不同周',
    memories: [
      {
        key: 'cert',
        space: 'project',
        unitType: 'event',
        content: '发布 0.3.10 时 Windows 安装包签名证书过期，回滚到 0.3.9 并补签后重发。',
        eventStart: '2025-11-12',
        createdAt: '2025-11-12T09:00:00.000Z',
      },
      {
        key: 'notary',
        space: 'project',
        unitType: 'event',
        content: '发布 0.3.8 时 macOS 公证排队两小时，发布推迟到晚上。',
        eventStart: '2025-10-20',
        createdAt: '2025-10-20T09:00:00.000Z',
      },
      {
        key: 'smooth',
        space: 'project',
        unitType: 'event',
        content: '发布 0.3.11 一切顺利，没有回滚。',
        eventStart: '2025-11-19',
        createdAt: '2025-11-19T09:00:00.000Z',
      },
    ],
    query: '上周发布出了什么问题',
    spaces: ['global', 'project'],
    eventDateFrom: '2025-11-10',
    eventDateTo: '2025-11-16',
    expected: ['cert'],
    excluded: ['notary', 'smooth'],
  },
  {
    id: 'temporal-recent-no-filter',
    dimension: 'temporal',
    description: '「最近」但模型没传时间参数：新旧两条字面几乎一样，只能靠新近度区分',
    memories: [
      {
        key: 'new',
        space: 'project',
        unitType: 'event',
        content: 'Redis 连接池在晚高峰被打满，把 maxClients 从 50 提到 200，并加了熔断。',
        eventStart: '2025-11-17',
        createdAt: '2025-11-17T13:00:00.000Z',
      },
      {
        key: 'old',
        space: 'project',
        unitType: 'event',
        content: 'Redis 连接池在压测时被打满，临时把 maxClients 从 20 提到 50。',
        eventStart: '2025-06-02',
        createdAt: '2025-06-02T08:00:00.000Z',
      },
    ],
    query: '最近 Redis 连接池 打满 怎么处理的',
    spaces: ['global', 'project'],
    expected: ['new'],
    excluded: ['old'],
  },
  {
    id: 'entity-person',
    dimension: 'entity',
    description: '人名查询；其中一条正文只用代词，只有实体层（MENTIONS）能召回',
    memories: [
      {
        key: 'owner',
        space: 'project',
        unitType: 'fact',
        content: '张伟负责 memory 子系统的评审，涉及 sqlite-vec 的改动都要他过目。',
        entities: [{ name: '张伟', type: 'PERSON' }],
      },
      {
        key: 'pronoun',
        space: 'project',
        unitType: 'decision',
        content: '向量表分区方案由他拍板：model 和 space_id 做 partition key。',
        entities: [{ name: '张伟', type: 'PERSON' }],
      },
      {
        key: 'other',
        space: 'project',
        unitType: 'fact',
        content: '李娜负责 Telegram 插件的评审，周三统一过 PR。',
        entities: [{ name: '李娜', type: 'PERSON' }],
      },
    ],
    query: '张伟 负责哪些事',
    spaces: ['global', 'project'],
    expected: ['owner', 'pronoun'],
    excluded: ['other'],
  },
  {
    id: 'entity-file-alias',
    dimension: 'entity',
    description: '文件名查询，记忆正文用的是模块的别称',
    memories: [
      {
        key: 'echo',
        space: 'project',
        unitType: 'decision',
        content: '乐观回显必须在确认 worker 会接收之后才发出，否则界面会出现幽灵消息。',
        entities: [{ name: 'deliveryEcho.ts', type: 'DOCUMENT', aliases: ['乐观回显'] }],
      },
      {
        key: 'toast',
        space: 'project',
        unitType: 'preference',
        content: '消息投递失败时用 toast 提示用户重试，不要弹模态框。',
      },
    ],
    query: 'deliveryEcho.ts 有什么约束',
    spaces: ['global', 'project'],
    expected: ['echo'],
    excluded: ['toast'],
  },
  {
    id: 'type-decision-logging',
    dimension: 'typeFilter',
    description: '只要 decision：同主题非决策记忆很多，决策条较早写入',
    memories: [
      {
        key: 'decision',
        space: 'project',
        unitType: 'decision',
        content: '日志统一用 pino 输出 JSON，按天切分，保留 14 天。',
        createdAt: '2025-08-01T08:00:00.000Z',
      },
      {
        key: 'lnav',
        space: 'global',
        unitType: 'preference',
        content: '看日志更喜欢 lnav，不用 less。',
      },
      {
        key: 'since',
        space: 'project',
        unitType: 'procedure',
        content: '排查线上问题先拉最近一小时日志：enso logs --since 1h。',
      },
      {
        key: 'dir',
        space: 'project',
        unitType: 'fact',
        content: '日志目录在 userData/logs 下，按进程分文件。',
      },
      {
        key: 'redact',
        space: 'project',
        unitType: 'learning',
        content: '日志里曾经打出过 API key，之后加了脱敏中间件。',
      },
      {
        key: 'level',
        space: 'project',
        unitType: 'fact',
        content: '日志级别默认 info，设置页可以切到 debug。',
      },
      {
        key: 'rotate',
        space: 'project',
        unitType: 'event',
        content: '日志切分脚本 11 月出过一次 bug，导致单文件涨到 2GB。',
      },
      {
        key: 'plan',
        space: 'project',
        unitType: 'plan',
        content: '计划把日志上报接到远程收集端，先做开关。',
      },
      {
        key: 'worker',
        space: 'project',
        unitType: 'fact',
        content: 'worker 的日志通过 stderr 转发到 Main 统一落盘。',
      },
      {
        key: 'export',
        space: 'project',
        unitType: 'procedure',
        content: '用户反馈问题时让他在帮助菜单里导出日志压缩包。',
      },
      {
        key: 'crash',
        space: 'project',
        unitType: 'learning',
        content: '崩溃前的日志可能没刷盘，排查时要同时看 Crashpad 转储。',
      },
    ],
    query: '日志 方案',
    spaces: ['global', 'project'],
    unitType: 'decision',
    expected: ['decision'],
    excluded: [
      'lnav',
      'since',
      'dir',
      'redact',
      'level',
      'rotate',
      'plan',
      'worker',
      'export',
      'crash',
    ],
  },
  {
    id: 'type-preference-style',
    dimension: 'typeFilter',
    description: '只要 preference：代码风格类的决定和事实不该出现',
    memories: [
      {
        key: 'type-alias',
        space: 'global',
        unitType: 'preference',
        content: '写 TypeScript 偏好用 type 声明联合类型，对象结构才用 interface。',
      },
      {
        key: 'indent',
        space: 'global',
        unitType: 'preference',
        content: '代码缩进用 2 空格，行宽 100，字符串用单引号。',
      },
      {
        key: 'biome',
        space: 'project',
        unitType: 'decision',
        content: '项目统一用 Biome 做格式化和 lint，不再用 ESLint + Prettier。',
      },
      {
        key: 'rule',
        space: 'project',
        unitType: 'fact',
        content: 'biome.json 里关闭了 noNonNullAssertion 规则，代码里允许非空断言。',
      },
    ],
    query: '代码风格 偏好',
    spaces: ['global', 'project'],
    unitType: 'preference',
    expected: ['type-alias', 'indent'],
    excluded: ['biome', 'rule'],
  },
  {
    id: 'space-global-only',
    dimension: 'spaceIsolation',
    description: '只查 global：项目层的同主题记忆一条都不能出现',
    memories: [
      {
        key: 'stash',
        space: 'global',
        unitType: 'preference',
        content: '提交前习惯先 git stash 保存没做完的改动，确认工作区干净再提交。',
      },
      {
        key: 'enso',
        space: 'project',
        unitType: 'procedure',
        content: '本项目提交前要跑 pnpm typecheck && pnpm lint && pnpm test。',
      },
      {
        key: 'other',
        space: 'otherProject',
        unitType: 'procedure',
        content: '本项目提交前要跑 make check，Go 代码还要过 golangci-lint。',
      },
    ],
    query: '提交前 要做什么',
    spaces: ['global'],
    expected: ['stash'],
    excluded: ['enso', 'other'],
  },
  {
    id: 'space-other-project',
    dimension: 'spaceIsolation',
    description: '当前项目 + global：另一个项目的同名流程不能串进来',
    memories: [
      {
        key: 'enso',
        space: 'project',
        unitType: 'procedure',
        content: '本项目提交前要跑 pnpm typecheck && pnpm lint && pnpm test。',
      },
      {
        key: 'other',
        space: 'otherProject',
        unitType: 'procedure',
        content: '本项目提交前要跑 make check，Go 代码还要过 golangci-lint。',
      },
    ],
    query: '提交前 检查命令',
    spaces: ['global', 'project'],
    expected: ['enso'],
    excluded: ['other'],
  },
  {
    id: 'distractor-tuning-constants',
    dimension: 'distractor',
    description: '一组同为「检索调参常量」的记忆，只有一条回答问题',
    memories: [
      {
        key: 'mmr',
        space: 'project',
        unitType: 'decision',
        content: '检索的 MMR λ 定为 0.7，是经验值，后续用评测再调。',
      },
      {
        key: 'rrf',
        space: 'project',
        unitType: 'decision',
        content: '检索的 RRF k 取 60，沿用论文默认值。',
      },
      {
        key: 'decay',
        space: 'project',
        unitType: 'decision',
        content: '检索的 decay 权重 0.15，只做同分附近的次要依据。',
      },
      {
        key: 'dedup',
        space: 'project',
        unitType: 'decision',
        content: '写入去重阈值余弦 0.8，正文少于 100 字不走候选网。',
      },
      {
        key: 'crystal',
        space: 'project',
        unitType: 'decision',
        content: '检索时 crystal 加权 1.25，乘在 finalScore 上。',
      },
    ],
    query: 'MMR 的 lambda 取多少',
    spaces: ['global', 'project'],
    expected: ['mmr'],
    excluded: ['rrf', 'decay', 'dedup', 'crystal'],
  },
  {
    id: 'distractor-package-manager',
    dimension: 'distractor',
    description: '包管理相关的多条记忆，问的是「锁文件冲突怎么处理」',
    memories: [
      {
        key: 'lock',
        space: 'project',
        unitType: 'procedure',
        content: 'pnpm-lock.yaml 冲突时不要手改，先合并 package.json，再跑 pnpm install 重新生成。',
      },
      {
        key: 'pm',
        space: 'project',
        unitType: 'decision',
        content: '包管理器统一用 pnpm 10，不接受 npm 或 yarn 提交的锁文件。',
      },
      {
        key: 'patch',
        space: 'project',
        unitType: 'procedure',
        content: '第三方包的补丁放在 patches/ 目录，用 pnpm patch 生成。',
      },
      {
        key: 'built',
        space: 'project',
        unitType: 'fact',
        content: 'pnpm 的 onlyBuiltDependencies 白名单里没有 better-sqlite3，原生模块走预编译。',
      },
    ],
    query: 'pnpm 锁文件 冲突 怎么解决',
    spaces: ['global', 'project'],
    expected: ['lock'],
    excluded: ['patch', 'built'],
  },
];
