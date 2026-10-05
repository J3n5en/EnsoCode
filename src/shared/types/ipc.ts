export const IPC_CHANNELS = {
  // Settings persistence
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  SETTINGS_WRITE_KEY: 'settings:write-key',
  SETTINGS_CHANGED: 'settings:changed',

  // Portable configuration sync
  CONFIG_SYNC_EXPORT: 'config-sync:export',
  CONFIG_SYNC_OPEN_IMPORT: 'config-sync:open-import',
  CONFIG_SYNC_PREVIEW_IMPORT: 'config-sync:preview-import',
  CONFIG_SYNC_COMMIT_IMPORT: 'config-sync:commit-import',
  CONFIG_SYNC_CANCEL_IMPORT: 'config-sync:cancel-import',

  // Window controls
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_IS_FULLSCREEN: 'window:is-fullscreen',
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',
  WINDOW_FULLSCREEN_CHANGED: 'window:fullscreen-changed',
  WINDOW_SET_TRAFFIC_LIGHTS_VISIBLE: 'window:set-traffic-lights-visible',
  WINDOW_OPEN_SETTINGS: 'window:open-settings',
  /** main → settings renderer：打开后切分类并闪行 */
  SETTINGS_DEEP_LINK: 'settings:deep-link',
  SETTINGS_DEEP_LINK_CONSUME: 'settings:deep-link-consume',
  WINDOW_POPUP_MENU: 'window:popup-menu',
  APP_CLOSE_REQUEST: 'app:close-request',
  APP_CLOSE_RESPONSE: 'app:close-response',
  APP_FLUSH_PERSIST_REQUEST: 'app:flush-persist-request',
  APP_FLUSH_PERSIST_RESPONSE: 'app:flush-persist-response',
  APP_SET_BADGE_COUNT: 'app:set-badge-count',

  // Local provider scan/import
  PROVIDERS_SCAN_LOCAL: 'providers:scan-local',
  PROVIDERS_COLLECT_IMPORT: 'providers:collect-import',
  PROVIDERS_LIST_MODELS: 'providers:list-models',
  PROVIDERS_TEST: 'providers:test',
  PROVIDERS_MODEL_META: 'providers:model-meta',
  PROVIDERS_CLASSIFIER_MODELS: 'providers:classifier-models',

  // Local token usage statistics
  USAGE_SUMMARY: 'usage:summary',

  // Resource monitor
  RESOURCES_SAMPLE: 'resources:sample',
  RESOURCES_STORAGE_SCAN: 'resources:storage-scan',
  RESOURCES_STORAGE_CLEAN: 'resources:storage-clean',
  RESOURCES_STORAGE_REVEAL: 'resources:storage-reveal',
  RESOURCES_STORAGE_CANCEL: 'resources:storage-cancel',
  RESOURCES_STORAGE_LAST: 'resources:storage-last',
  RESOURCES_STORAGE_PROGRESS: 'resources:storage-progress',
  RESOURCES_SESSIONS_CLEAN: 'resources:sessions-clean',
  RESOURCES_SESSIONS_CLEAN_REQUEST: 'resources:sessions-clean-request',
  RESOURCES_SESSIONS_CLEAN_DONE: 'resources:sessions-clean-done',

  // Memory administration
  MEMORY_LIST: 'memory:list',
  MEMORY_DETAIL: 'memory:detail',
  MEMORY_ARCHIVE: 'memory:archive',
  MEMORY_RESTORE: 'memory:restore',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_STATS: 'memory:stats',
  MEMORY_JOBS: 'memory:jobs',
  MEMORY_JOBS_CLEAR: 'memory:jobs-clear',
  MEMORY_EVOLVES_PENDING: 'memory:evolves-pending',
  MEMORY_EVOLVES_REVIEW: 'memory:evolves-review',
  MEMORY_PENDING_WRITES: 'memory:pending-writes',
  MEMORY_PENDING_WRITE_REVIEW: 'memory:pending-write-review',
  MEMORY_MODELS: 'memory:models',
  MEMORY_MODEL_DOWNLOAD: 'memory:model-download',
  MEMORY_MODEL_CANCEL: 'memory:model-cancel',
  MEMORY_MODEL_DELETE: 'memory:model-delete',
  MEMORY_MODEL_PROGRESS: 'memory:model-progress',
  MEMORY_CHAT_MODELS: 'memory:chat-models',
  MEMORY_CHAT_MODEL_DOWNLOAD: 'memory:chat-model-download',
  MEMORY_CHAT_MODEL_CANCEL: 'memory:chat-model-cancel',
  MEMORY_CHAT_MODEL_DELETE: 'memory:chat-model-delete',
  MEMORY_CHAT_MODEL_PROGRESS: 'memory:chat-model-progress',
  SPEECH_STATUS: 'speech:status',
  SPEECH_DOWNLOAD: 'speech:download',
  SPEECH_CANCEL: 'speech:cancel',
  SPEECH_DELETE: 'speech:delete',
  SPEECH_PROGRESS: 'speech:progress',
  SPEECH_STATUS_CHANGED: 'speech:status-changed',
  SPEECH_SESSION_PUSH: 'speech:session-push',
  SPEECH_SESSION_FINISH: 'speech:session-finish',
  SPEECH_SESSION_CANCEL: 'speech:session-cancel',
  SPEECH_PARTIAL: 'speech:partial',
  SPEECH_MIC_ACCESS: 'speech:mic-access',
  MEMORY_REEMBED: 'memory:reembed',
  MEMORY_CHANGED: 'memory:changed',
  MEMORY_GRAPH: 'memory:graph',
  MEMORY_GRAPH_ENTITY: 'memory:graph-entity',
  MEMORY_TREE: 'memory:tree',
  MEMORY_INSIGHT: 'memory:insight',
  MEMORY_CRYSTALLIZE: 'memory:crystallize',
  MEMORY_DISTILLABLE_SESSIONS: 'memory:distillable-sessions',
  MEMORY_DISTILL_SESSION: 'memory:distill-session',

  // OAuth subscription providers (pi builtin)
  OAUTH_PROVIDERS_LIST: 'oauth-providers:list',
  OAUTH_LOGIN: 'oauth-providers:login',
  OAUTH_LOGIN_RESPOND: 'oauth-providers:login-respond',
  OAUTH_LOGIN_CANCEL: 'oauth-providers:login-cancel',
  OAUTH_LOGIN_REOPEN: 'oauth-providers:login-reopen',
  OAUTH_LOGOUT: 'oauth-providers:logout',
  OAUTH_IMPORT_CODEX: 'oauth-providers:import-codex',
  OAUTH_LOGIN_EVENT: 'oauth-providers:login-event',
  OAUTH_ACCOUNT_INFO: 'oauth-providers:account-info',
  OAUTH_CREDENTIAL_KEYS_LIST: 'oauth:credential-keys-list',
  OAUTH_CREDENTIALS_CHANGED: 'oauth:credentials-changed',

  // Local skill / MCP scan/import
  ASSETS_SCAN_LOCAL: 'assets:scan-local',
  ASSETS_COLLECT_IMPORT: 'assets:collect-import',
  ASSETS_LIST_PROJECT_SKILLS: 'assets:list-project-skills',
  ASSETS_LIST_WORKFLOW_PRESETS: 'assets:list-workflow-presets',
  ASSETS_SKILL_OCCUPANCY: 'assets:skill-occupancy',
  ASSETS_INSTRUCTION_OCCUPANCY: 'assets:instruction-occupancy',
  ASSETS_MCP_OCCUPANCY: 'assets:mcp-occupancy',
  ASSETS_BUILTIN_TOOL_OCCUPANCY: 'assets:builtin-tool-occupancy',
  /** Claude Code 已装插件及其组件摘要 */
  PLUGINS_LIST_INSTALLED: 'plugins:list-installed',

  // MCP OAuth 授权与连接状态
  MCP_AUTHORIZE: 'mcp:authorize',
  MCP_REVOKE: 'mcp:revoke',
  MCP_AUTH_STATE: 'mcp:auth-state',
  MCP_STATUS_EVENT: 'mcp:status-event',
  MCP_STATUS_SNAPSHOT: 'mcp:status-snapshot',

  // Instruction content (copy-on-write)
  INSTRUCTIONS_READ: 'instructions:read',
  INSTRUCTIONS_WRITE: 'instructions:write',
  INSTRUCTIONS_WRITE_SOURCE: 'instructions:write-source',
  INSTRUCTIONS_DELETE: 'instructions:delete',
  // Settings-managed workflow presets (userData/agent/workflows)
  WORKFLOW_PRESETS_LIST: 'workflow-presets:list',
  WORKFLOW_PRESETS_READ: 'workflow-presets:read',
  WORKFLOW_PRESETS_SAVE: 'workflow-presets:save',
  WORKFLOW_PRESETS_DELETE: 'workflow-presets:delete',

  // Preset custom system prompt content (UUID-backed external files)
  PRESETS_SYSTEM_PROMPT_READ: 'presets:system-prompt-read',
  PRESETS_SYSTEM_PROMPT_WRITE: 'presets:system-prompt-write',

  // Agent sessions (Renderer → Main → utilityProcess)
  AGENT_SPAWN: 'agent:spawn',
  AGENT_PROMPT: 'agent:prompt',
  AGENT_STEER: 'agent:steer',
  AGENT_ABORT: 'agent:abort',
  AGENT_ABORT_RETRY: 'agent:abort-retry',
  AGENT_RETRY: 'agent:retry',
  AGENT_EVENT: 'agent:event',
  AGENT_SNAPSHOT: 'agent:snapshot',
  /** 已结束 child 的 safe journal 只读回放（路径由 Main 推导，请求只带 conversationId） */
  AGENT_CHILD_HISTORY_READ: 'agent:child-history-read',
  /** 手动「重新读取会话」：Main 选来源（worker 活快照 / safe journal），只读不 spawn */
  AGENT_CONVERSATION_RELOAD: 'agent:conversation-reload',
  /** 父会话 jsonl 尾窗/分页只读（不 spawn）；路径由 Main 从已登记 sessionFile 推导 */
  AGENT_PARENT_HISTORY_TAIL: 'agent:parent-history-tail',
  AGENT_SUMMARIZE_TITLE: 'agent:summarize-title',
  /** 已启动会话就地换模型；worker 换完回报，Main 据此更新已启动模型记录 */
  AGENT_SET_MODEL: 'agent:set-model',
  AGENT_SET_THINKING: 'agent:set-thinking',
  AGENT_SET_REASONING: 'agent:set-reasoning',
  AGENT_APPROVAL_RESPOND: 'agent:approval-respond',
  AGENT_SET_APPROVAL_MODE: 'agent:set-approval-mode',
  AGENT_SET_PLAN_MODE: 'agent:set-plan-mode',
  AGENT_PLAN_RESPOND: 'agent:plan-respond',
  NOTIFICATION_FOCUS_SESSION: 'notification:focus-session',
  /** renderer → main：上报当前正在查看的会话，供系统通知抑制判断 */
  NOTIFICATION_ACTIVE_SESSION: 'notification:active-session',
  AGENT_TASK_STOP: 'agent:task-stop',
  /** 把运行中的前台命令移交为后台任务 */
  AGENT_TOOL_BACKGROUND: 'agent:tool-background',
  AGENT_SUBAGENT_STOP: 'agent:subagent-stop',
  AGENT_WORKFLOW_STOP: 'agent:workflow-stop',
  AGENT_REWIND: 'agent:rewind',
  /** 手动压缩会话上下文（/compact 与上下文面板按钮共用） */
  AGENT_COMPACT: 'agent:compact',
  AGENT_FORK: 'agent:fork',
  AGENT_DISMISS_COWORKER: 'agent:dismiss-coworker',
  AGENT_HIRE_COWORKER: 'agent:hire-coworker',
  AGENT_ASK_RESPOND: 'agent:ask-respond',
  AGENT_RELEASE: 'agent:release',

  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_BIND: 'worktree:bind',
  WORKTREE_BRANCHES: 'worktree:branches',
  WORKTREE_SWITCH_BRANCH: 'worktree:switch-branch',
  WORKTREE_RENAME: 'worktree:rename',
  WORKTREE_GET: 'worktree:get',
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_STATUS: 'worktree:status',
  WORKTREE_REMOVE: 'worktree:remove',
  WORKTREE_REBUILD: 'worktree:rebuild',
  WORKTREE_REPO_CLEAN: 'worktree:repo-clean',

  // Agent type registry + sender-bound deterministic child dispatch
  AGENT_TYPES_REGISTRY_LIST: 'agent-types:registry-list',
  AGENT_MODEL_SELECTION_REGISTER: 'agent-dispatch:model-selection-register',
  AGENT_DISPATCH_BIND_SOURCE: 'agent-dispatch:bind-source',
  AGENT_DISPATCH: 'agent-dispatch:dispatch',
  AGENT_DISPATCH_EVENT: 'agent-dispatch:event',
  AGENT_SUMMON: 'agent-dispatch:summon',
  AGENT_COMPOSER_PREFILL: 'agent-dispatch:composer-prefill',

  // Main-owned project/conversation authority (generic settings are projection only)
  SOURCE_AUTHORITY_READ: 'source-authority:read',
  SOURCE_AUTHORITY_CHANGED: 'source-authority:changed',
  SOURCE_PROJECT_CREATE: 'source-authority:project-create',
  SOURCE_PROJECT_SELECT: 'source-authority:project-select',
  SOURCE_PROJECT_REMOVE: 'source-authority:project-remove',
  SOURCE_CONVERSATION_CREATE: 'source-authority:conversation-create',
  SOURCE_CONVERSATION_SELECT: 'source-authority:conversation-select',
  SOURCE_CONVERSATION_END: 'source-authority:conversation-end',
  SOURCE_CONVERSATION_REMOVE: 'source-authority:conversation-remove',
  SOURCE_CONVERSATION_UPDATE_SELECTION: 'source-authority:conversation-update-selection',

  // Enso child capability approval (result returns Main → worker command)
  CAPABILITIES_ASK: 'capabilities:ask',
  CAPABILITIES_RESPOND: 'capabilities:respond',

  // Native dialogs
  DIALOG_SELECT_DIRECTORY: 'dialog:select-directory',
  DIALOG_SELECT_FILE: 'dialog:select-file',

  // Recent projects from local apps
  PROJECTS_GET_RECENT: 'projects:get-recent',
  /** 在系统文件管理器或指定 appId 的应用里打开项目根目录或会话 worktree（仅本地项目） */
  PROJECTS_REVEAL: 'projects:reveal',
  PROJECTS_CODE_SOURCES: 'projects:code-sources',
  /** 列出本机已安装、可打开项目目录的编辑器 / 终端 */
  PROJECTS_OPEN_IN_APPS: 'projects:open-in-apps',

  // SSH connection profiles (settings + add-project picker)
  SSH_CONNECTIONS_LIST: 'ssh-connections:list',
  SSH_CONNECTIONS_UPSERT: 'ssh-connections:upsert',
  SSH_CONNECTIONS_DELETE: 'ssh-connections:delete',
  SSH_CONNECTIONS_TEST: 'ssh-connections:test',
  SSH_CONNECTIONS_LIST_DIRS: 'ssh-connections:list-dirs',
  SSH_CONNECTIONS_TRUST_HOST: 'ssh-connections:trust-host',

  // File search (@ mention)
  FILES_SEARCH: 'files:search',
  FILES_READ: 'files:read',
  // 目录媒体文件枚举（背景图文件夹随机模式）
  FILES_LIST_MEDIA: 'files:list-media',
  FILES_LIST_DIR: 'files:list-dir',
  FILES_READ_REL: 'files:read-rel',
  /** Markdown 预览相对图片：返回 data URL，不开放任意文件读取 */
  FILES_READ_IMAGE: 'files:read-image',
  /** Markdown 预览远程图片：主进程带 SSRF 防护代理读取，返回 data URL */
  FILES_FETCH_REMOTE_IMAGE: 'files:fetch-remote-image',
  FILES_WRITE: 'files:write',
  FILES_WATCH_START: 'files:watch-start',
  FILES_WATCH_STOP: 'files:watch-stop',
  FILES_WATCH_EVENT: 'files:watch-event',
  FILES_MKDIR: 'files:mkdir',
  FILES_CREATE: 'files:create-file',
  FILES_RENAME: 'files:rename',
  FILES_REMOVE: 'files:remove',
  FILES_ABS: 'files:abs-path',
  FILES_COPY_PATH: 'files:copy-path',
  FILES_COPY_FILE: 'files:copy-file',
  FILES_REVEAL: 'files:reveal',
  FILES_SEARCH_WORKSPACE: 'files:search-workspace',

  GIT_DIFF_HEAD: 'git:diff-head',

  // Changes 面板「Session」模式的编辑前快照（主进程按会话落盘）
  CHANGES_SNAPSHOTS_READ: 'changes:snapshots-read',
  CHANGES_SNAPSHOTS_WRITE: 'changes:snapshots-write',

  // External session import
  SESSIONS_SCAN_EXTERNAL: 'sessions:scan-external',
  SESSIONS_READ_EXTERNAL: 'sessions:read-external',
  SESSIONS_IMPORT_EXTERNAL: 'sessions:import-external',

  // 右侧面板终端(node-pty)
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DISPOSE: 'terminal:dispose',
  /** main → renderer:pty 输出 */
  TERMINAL_DATA: 'terminal:data',
  /** main → renderer:pty 退出 */
  TERMINAL_EXIT: 'terminal:exit',

  // 右侧面板内嵌浏览器(WebContentsView 叠层)
  BROWSER_SET_VIEWPORT: 'browser:set-viewport',
  /** 渲染层有模态浮层时，guest 立刻沉到 workbench 之下（避免弹窗被网页挡一帧） */
  BROWSER_SET_OVERLAY_ACTIVE: 'browser:set-overlay-active',
  BROWSER_NAVIGATE: 'browser:navigate',
  BROWSER_GO_BACK: 'browser:go-back',
  BROWSER_GO_FORWARD: 'browser:go-forward',
  BROWSER_RELOAD: 'browser:reload',
  BROWSER_CLEAR_DATA: 'browser:clear-data',
  BROWSER_SET_LOCKED: 'browser:set-locked',
  /** main → renderer:当前 tab 状态 */
  BROWSER_STATE: 'browser:state',
  /** main → renderer:agent 已打开页，请建 Browser 面板 */
  BROWSER_REVEAL: 'browser:reveal',
  BROWSER_RESTORE_TABS: 'browser:restore-tabs',
  BROWSER_LIST_SEARCHABLE_TABS: 'browser:list-searchable-tabs',
  BROWSER_CLOSE_TAB: 'browser:close-tab',
  BROWSER_CLOSE_SESSION: 'browser:close-session',
  /** renderer → main:开关面板内嵌 DevTools */
  BROWSER_SET_DEVTOOLS: 'browser:set-devtools',
  /** renderer → main:DevTools 洞矩形 */
  BROWSER_SET_DEVTOOLS_VIEWPORT: 'browser:set-devtools-viewport',
  /** main → renderer:agent 关了页，拆掉 dock tab */
  BROWSER_TAB_CLOSED: 'browser:tab-closed',
  /** renderer → main:开关 Design Mode */
  BROWSER_SET_DESIGN_MODE: 'browser:set-design-mode',
  /** main → renderer:圈选结果 / 取消 */
  BROWSER_DESIGN_MODE_EVENT: 'browser:design-mode-event',

  // Auto updater
  COMPUTER_CAPABILITIES: 'computer:capabilities',
  COMPUTER_OPEN_PERMISSIONS: 'computer:open-permissions',
  UPDATER_CHECK: 'updater:check',
  UPDATER_DOWNLOAD_UPDATE: 'updater:downloadUpdate',
  UPDATER_QUIT_AND_INSTALL: 'updater:quitAndInstall',
  UPDATER_SET_AUTO_UPDATE_ENABLED: 'updater:setAutoUpdateEnabled',
  UPDATER_SET_AUTO_RESTART_WHEN_IDLE: 'updater:setAutoRestartWhenIdle',
  UPDATER_STATUS: 'updater:status',

  // Network proxy
  PROXY_APPLY: 'proxy:apply',

  // Phone second screen (pairing + relay)
  PAIR_START: 'pair:start',
  PAIR_CANCEL: 'pair:cancel',
  PAIR_REVOKE: 'pair:revoke',
  PAIR_RENAME: 'pair:rename',
  PAIR_SET_SCOPE: 'pair:set-scope',
  PAIR_STATUS: 'pair:status',
  PAIR_SET_RELAY: 'pair:set-relay',
  PAIR_CATALOG: 'pair:catalog',
  PAIR_STATUS_CHANGED: 'pair:status-changed',
  /** main → renderer：手机订阅了某会话，请求恢复（历史会话在 worker 里没有投影） */
  PAIR_RESUME_SESSION: 'pair:resume-session',
  /** main → renderer：手机新建了会话，请求登记（否则桌面列表里没有它，其事件也会被丢弃） */
  PAIR_SESSION_CREATED: 'pair:session-created',
  /** main → renderer：手机改了会话模型/推理档位，请求应用到会话 store（与桌面同一路径） */
  PAIR_SESSION_CONFIG: 'pair:session-config',
  /** main → renderer：手机的排队消息 / 会话目标操作（只存于 renderer store，不走 agent bridge） */
  PAIR_QUEUE_ACTION: 'pair:queue-action',

  // Remote nodes: this desktop as guest connecting to another EnsoCode desktop
  NODES_LIST: 'nodes:list',
  NODES_PAIR: 'nodes:pair',
  NODES_REMOVE: 'nodes:remove',
  NODES_RENAME: 'nodes:rename',
  NODES_SEND: 'nodes:send',
  /** main → renderer：节点列表/连接状态变化 */
  NODES_STATUS_CHANGED: 'nodes:status-changed',
  /** main → renderer：解密后的 host 下行帧 */
  NODES_MESSAGE: 'nodes:message',

  WORKSPACE_SEARCH_QUERY: 'workspace-search:query',

  BTW_PROMPT: 'btw:prompt',
  BTW_ABORT: 'btw:abort',
  BTW_SPAWN: 'btw:spawn',
  BTW_DISPOSE: 'btw:dispose',

  // Bot 模式（实验）：成员、聊天、投递；身份 / 工作区 / 人设一律由 Main 推导
  BOTS_LIST: 'bots:list',
  BOT_GET: 'bots:get',
  BOT_CREATE: 'bots:create',
  BOT_UPDATE: 'bots:update',
  BOT_ARCHIVE: 'bots:archive',
  BOT_DELETE: 'bots:delete',
  BOT_SET_AVATAR: 'bots:set-avatar',
  BOT_CHATS_LIST: 'bots:chats-list',
  BOT_CHAT_CREATE: 'bots:chat-create',
  BOT_CHAT_UPDATE: 'bots:chat-update',
  BOT_CHAT_DELETE: 'bots:chat-delete',
  BOT_CHAT_NEW_SESSION: 'bots:chat-new-session',
  BOT_CHAT_CLONE: 'bots:chat-clone',
  BOT_CHAT_STOP: 'bots:chat-stop',
  BOT_CHAT_STATE: 'bots:chat-state',
  BOT_CHAT_SESSIONS: 'bots:chat-sessions',
  BOT_CHAT_TIMELINE: 'bots:chat-timeline',
  BOT_SEND: 'bots:send',
  BOT_OPEN_WORKSPACE: 'bots:open-workspace',
  /** bot 会话正文（含已结束的历史会话），只接受 bot 会话 id */
  BOT_SESSION_HISTORY: 'bots:session-history',
  BOT_DELEGATIONS_LIST: 'bots:delegations-list',
  BOT_DELEGATION_CANCEL: 'bots:delegation-cancel',
  BOT_DELEGATION_RETRY: 'bots:delegation-retry',
  BOT_ROUTINES_LIST: 'bots:routines-list',
  BOT_ROUTINE_SAVE: 'bots:routine-save',
  BOT_ROUTINE_DELETE: 'bots:routine-delete',
  BOT_ROUTINE_RUN_NOW: 'bots:routine-run-now',
  /** 批准 / 拒绝成员提议或改动的例行任务版本 */
  BOT_ROUTINE_REVIEW: 'bots:routine-review',
  /** 某例行任务最近 20 次运行历史 */
  BOT_ROUTINE_RUNS: 'bots:routine-runs',
  /** 成员 / 群核心笔记：只收 botId 或 chatId，保存带 version 防覆盖 */
  BOT_NOTES_GET: 'bots:notes-get',
  BOT_NOTES_SAVE: 'bots:notes-save',
  /** 群任务看板：列表 / 新建或编辑 / 指派（以人类身份 @ 成员）/ 完成 / 取消 / 删除 */
  BOT_TASKS_LIST: 'bots:tasks-list',
  BOT_TASK_SAVE: 'bots:task-save',
  BOT_TASK_ASSIGN: 'bots:task-assign',
  BOT_TASK_COMPLETE: 'bots:task-complete',
  BOT_TASK_CANCEL: 'bots:task-cancel',
  BOT_TASK_DELETE: 'bots:task-delete',
  /** 「自动设置能力」：便宜模型按成员描述推荐能力，只返回建议不落盘 */
  BOT_SUGGEST_ABILITIES: 'bots:suggest-abilities',
  BOT_SUGGEST_PERSONA: 'bots:suggest-persona',
  BOT_SUGGEST_GOAL: 'bots:suggest-goal',
  /** 团队模板 / 导入：校验并预览改名 */
  BOT_TEAM_PREVIEW: 'bots:team-preview',
  /** 原子创建团队（成员 + 群） */
  BOT_TEAM_CREATE: 'bots:team-create',
  /** 成员用量：按周期排行 / 今日·7 天·30 天概览与预算状态 */
  BOT_USAGE_SUMMARY: 'bots:usage-summary',
  BOT_USAGE: 'bots:usage',
  /** Bot 收件箱（Main 持久化）：列表 / 忽略与重新打开 */
  BOT_INBOX_LIST: 'bots:inbox-list',
  BOT_INBOX_UPDATE: 'bots:inbox-update',
  /** main → renderer：Bot 数据变化提示 */
  BOT_EVENT: 'bots:event',
  /** Bot 聊天全文搜索：群时间线 + 私聊当前 / 历史会话 */
  BOT_SEARCH: 'bots:search',
  /** 产物卡片：只收聊天 + 条目 / 会话消息标识，路径由 Main 推导并校验在工作区根内 */
  BOT_ARTIFACTS_LIST: 'bots:artifacts-list',
  BOT_ARTIFACT_READ: 'bots:artifact-read',
  BOT_ARTIFACT_OPEN: 'bots:artifact-open',
  /** 输入框 @文件补全：只收 chatId + 查询词，工作区根由 Main 推导 */
  BOT_FILE_SEARCH: 'bots:file-search',
  /** 回退 / 重试：只收 chatId（群重试加失败 entryId），会话由 Main 按聊天推导 */
  BOT_REWIND: 'bots:rewind',
  BOT_RETRY: 'bots:retry',
  /** 成员 / 团队模板库（userData/bot-templates.json）；写入后广播 CHANGED */
  BOT_TEMPLATES_GET: 'bots:templates-get',
  BOT_TEMPLATES_SAVE: 'bots:templates-save',
  BOT_TEMPLATES_CHANGED: 'bots:templates-changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
