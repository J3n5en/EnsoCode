export type Locale = 'en' | 'zh';

export const zhTranslations: Record<string, string> = {
  'Add to favorites': '添加收藏',
  Appearance: '外观',
  'Bold font weight': '粗体字重',
  'Choose interface theme': '选择界面主题',
  'Color scheme': '配色方案',
  Dark: '深色',
  'Electron multi-window scaffold': 'Electron 多窗口脚手架',
  Font: '字体',
  'Font size': '字号',
  'Font weight': '字重',
  General: '通用',
  'General application settings': '应用通用设置',
  Language: '语言',
  Light: '浅色',
  'No favorite themes yet. Click the heart icon to add favorites.':
    '暂无收藏主题。点击爱心图标添加收藏。',
  'No themes found': '未找到主题',
  Preview: '预览',
  'Remove from favorites': '取消收藏',
  'Search themes...': '搜索主题...',
  Settings: '设置',
  'Show favorites only': '只显示收藏',
  'Sync terminal theme': '同步终端主题',
  System: '系统',
  Terminal: '终端',
  'Terminal appearance': '终端外观',
  'Theme mode': '主题模式',
  // Model providers
  Search: '搜索',
  'No results': '无匹配结果',
  'Preset is locked after the conversation starts': '对话开始后预设已锁定，不能中途替换',
  Path: '路径',
  // Onboarding
  'Welcome to EnsoCode': '欢迎使用 EnsoCode',
  'Import your providers and assets from local AI apps to get started. You can skip any step.':
    '从本地 AI 应用导入模型服务与资源即可开始，每一步都可跳过。',
  'Import model API providers from local AI apps to start chatting':
    '从本地 AI 应用导入模型 API 服务，即可开始对话',
  'Import skills from Claude Code, Codex or Cursor': '从 Claude Code、Codex 或 Cursor 导入技能',
  'Scan and import': '扫描并导入',
  '{{count}} imported': '已导入 {{count}} 个',
  'All set': '全部就绪',
  'You can always import more from Settings later.': '之后随时可在设置里导入更多。',
  Back: '上一步',
  Skip: '跳过',
  Next: '下一步',
  'Get started': '开始',
  Close: '关闭',
  'No new providers imported': '没有新导入的模型服务',
  'Fetch models for each provider, then enable the ones you want.':
    '为每个模型服务拉取模型，再启用你需要的。',
  'Fetch failed': '拉取失败',
  'No models yet': '暂无模型，点击拉取',
  'Bundle skills, MCP servers and an instruction file into a preset (optional)':
    '把技能、MCP 服务和一份指令组合成预设（可选）',
  '{{count}} presets': '已有 {{count}} 个预设',
  'Model Providers': '模型中心',
  'Manage model API providers for this app': '管理应用的模型 API 服务',
  'Import from local apps': '从本地应用导入',
  'Scan providers configured in local AI apps and import them.':
    '扫描本机 AI 应用中已配置的模型服务并导入。',
  'Scanning local apps...': '正在扫描本地应用...',
  'Scan failed': '扫描失败',
  Rescan: '重新扫描',
  'No local apps detected': '未检测到本地应用',
  'Supported: Claude Code, Codex, CC Switch, Alma, Cherry Studio, Hermes, OpenClaw, Grok CLI, Cursor':
    '支持:Claude Code、Codex、CC Switch、Alma、Cherry Studio、Hermes、OpenClaw、Grok CLI、Cursor',
  'No importable providers found': '未发现可导入的模型服务',
  'Already exists': '已存在',
  '{{count}} models': '{{count}} 个模型',
  '{{count}} selected': '已选 {{count}} 项',
  'Import selected': '导入所选',
  'Imported {{count}} providers': '已导入 {{count}} 个模型服务',
  Done: '完成',
  'No providers yet': '暂无模型服务',
  'Import providers from local apps to get started': '从本地应用导入模型服务以开始使用',
  'Edit Provider': '编辑模型服务',
  Name: '名称',
  'API Type': 'API 类型',
  'Base URL': 'Base URL',
  'API Key': 'API Key',
  'Models (one per line)': '模型(每行一个)',
  Models: '模型',
  'Add a model id': '添加模型 ID',
  'Filter models...': '筛选模型...',
  'No models match': '没有匹配的模型',
  'Enable all': '全部启用',
  'Disable all': '全部禁用',
  'Select all': '全选',
  'Deselect all': '全不选',
  '{{enabled}}/{{total}} enabled': '已启用 {{enabled}}/{{total}}',
  'Fetch models': '拉取模型',
  'Test connection': '测试连接',
  Fetching: '拉取中...',
  Testing: '测试中...',
  'Fetched {{count}} models': '拉取到 {{count}} 个模型',
  'Connected ({{ms}}ms)': '连接成功({{ms}}ms)',
  Cancel: '取消',
  Save: '保存',
  // Skills & MCP
  Skills: '技能',
  'Skills registered by reference; files stay in their original location':
    '以引用方式登记,文件仍留在原应用目录',
  'No skills yet': '暂无技能',
  'Import skills from Claude Code, Codex or Cursor to get started':
    '从 Claude Code、Codex 或 Cursor 导入技能以开始使用',
  'Import skills from local apps': '从本地应用导入技能',
  'MCP Servers': 'MCP 服务器',
  'Model Context Protocol servers available to this app': '应用可用的 MCP 服务器',
  'No MCP servers yet': '暂无 MCP 服务器',
  'Import MCP servers configured in local AI apps': '导入本机 AI 应用中已配置的 MCP 服务器',
  'Import MCP servers': '导入 MCP 服务器',
  'Scan local AI apps and register the entries you want to reuse.':
    '扫描本机 AI 应用,登记你想复用的条目。',
  'Nothing importable found': '未发现可导入的条目',
  '{{count}} env vars': '{{count}} 个环境变量',
  'Imported {{count}} entries': '已导入 {{count}} 项',
  'Instruction Files': '指令文件',
  'Global CLAUDE.md / AGENTS.md style files from local AI tools':
    '本机 AI 工具的全局 CLAUDE.md / AGENTS.md 类文件',
  'No instruction files yet': '暂无指令文件',
  'Only one file is active at a time; enabling one disables the others':
    '同一时间仅一份生效（注入会话）；启用一份会自动关闭其余',
  'Import global instruction files configured in local AI tools':
    '导入本机 AI 工具中已配置的全局指令文件',
  'Import instruction files': '导入指令文件',
  'Same content': '内容相同',
  'Same name': '同名',
  'Edit Instruction': '编辑指令文件',
  Content: '内容',
  'Loading...': '加载中...',
  Linked: '链接',
  'Local copy': '本地副本',
  'Local copy — edits stay in this app.': '本地副本 —— 修改只保存在应用内。',
  'Write back to original file': '直接修改原文件',
  'Saving creates a local copy — {{path}} is left untouched, and this entry stops following its updates.':
    '保存后会复制一份到应用内 —— {{path}} 不会被改动,此条目也将不再跟随其更新。',
  'Saving overwrites {{path}} directly — {{source}} will pick up the change.':
    '保存会直接覆盖 {{path}} —— {{source}} 会随之生效。',
  'Overwrite original': '覆盖原文件',
  'Save as local copy': '保存为本地副本',
  'Failed to read content': '读取内容失败',
  'Failed to save': '保存失败',
  Provider: '模型服务',
  Model: '模型',
  'Working directory': '工作目录',
  'Ask the agent…': '想让 agent 做什么…',
  'Steer the running agent…': '给运行中的 agent 补一句…',
  'Thinking…': '思考中…',
  'Thought process': '思考过程',
  Projects: '项目',
  'Add project': '添加项目',
  'Add a project to start': '添加一个项目开始',
  'New conversation': '新对话',
  'Remove project': '移除项目',
  'Select or create a conversation': '选择或新建一个对话',
  'Collapse sidebar': '折叠侧边栏',
  'Expand sidebar': '展开侧边栏',
  '{{count}} turns': '{{count}} 轮',
  '{{turns}} turns · {{steps}} steps': '{{turns}} 轮 · {{steps}} 步',
  'LLM {{duration}}': 'LLM {{duration}}',
  'Tool calls {{duration}}': '工具调用 {{duration}}',
  'First token avg {{duration}}': '首 token 平均 {{duration}}',
  'Cache hit {{percent}}%': '缓存命中 {{percent}}%',
  'Input {{input}} tok · Output {{output}} tok': '输入 {{input}} · 输出 {{output}} tok',
  '{{speed}} tok/s': '{{speed}} tok/s',
  'Search models': '搜索模型',
  'No models found': '没有匹配的模型',
  'Import session': '导入会话',
  'Pick a conversation from a local AI app under {{name}}.':
    '从本地 AI 应用导入 {{name}} 项目下的对话历史。',
  'No sessions found for this project': '没有找到该项目的会话',
  'Select a session to preview': '选择一个会话预览',
  Untitled: '未命名',
  '{{count}} messages': '{{count}} 条消息',
  Import: '导入',
  'Show {{count}} earlier': '显示更早的 {{count}} 条',
  'Scroll to bottom': '滚动到底部',
  'Thinking level': '思考深度',
  Reasoning: '推理',
  'Takes effect in a new conversation': '新对话生效',
  'Load local skills': '加载本机 skill',
  // Presets
  Presets: '预设',
  'New preset': '新建预设',
  'Edit preset': '编辑预设',
  'Default preset': '默认预设',
  Default: '默认',
  None: '不注入',
  'Injection bundles of skills, MCP servers and instruction files, chosen per conversation':
    'skill / MCP / 指令文件的注入组合，按对话选用',
  'Follows the enabled switches on the Skills / MCP / Instructions pages':
    '跟随技能 / MCP / 指令文件页的启用开关',
  '{{skills}} skills · {{mcp}} MCP · {{instruction}} instruction':
    '{{skills}} 个技能 · {{mcp}} 个 MCP · {{instruction}} 份指令',
  'Let the agent auto-discover skills under .agents/skills and .pi/skills':
    '让 agent 自动发现 .agents/skills、.pi/skills 下的 skill',
};

export function normalizeLocale(input?: string): Locale {
  if (!input) return 'en';
  return input.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function getTranslation(locale: Locale, key: string): string {
  if (locale === 'zh') {
    return zhTranslations[key] ?? key;
  }
  return key;
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string {
  const template = getTranslation(locale, key);
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, token) => {
    const value = params[token];
    return value === undefined ? match : String(value);
  });
}
