import type { ExtensionPluginPermission } from '@shared/extensionPlugins/manifest';

const LABELS: Record<ExtensionPluginPermission, string> = {
  'agent.tool': '运行 Agent 工具',
  'ui.slot': '在界面挂载组件',
  'ui.view': '打开侧栏页面',
  'ui.notify': '发送系统通知',
  'composer.draft': '读写输入框草稿',
  'fs.read': '读取声明的文件',
  'fs.write': '写入声明的文件',
  'net.fetch': '访问声明的域名',
  'mcp.server': '启动声明的 MCP 服务',
  'mcp.call': '调用宿主 MCP 工具',
  'agent.observe': '观察会话事件',
  'agent.intercept': '拦截并改写会话事件',
  'agent.inject':
    '向会话发送消息，并可触发该会话继续执行；默认只发到发起调用的会话，允许后可发到任意运行中的会话',
  'process.background': '常驻后台并拉起子进程',
  'plugin.call': '调用其他插件',
  'ui.clipboard': '写入剪贴板',
  'ui.openExternal': '用浏览器打开链接',
  'session.read': '查看本项目的会话列表（标题与活动时间）',
  'session.focus': '在你点击时切换到本项目的会话',
  'session.create': '在你点击时于本项目新建会话',
};

export function pluginPermissionLabel(permission: string): string {
  return LABELS[permission as ExtensionPluginPermission] ?? permission;
}
