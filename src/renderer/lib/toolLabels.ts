import type { TFunction } from '@/i18n';
import type { SubagentOp } from '@/stores/sessions/timeline';

/** 工具 id → 显示名 i18n key；只影响 UI，发给模型的工具名不变 */
export const TOOL_LABEL_KEYS: Partial<Record<string, string>> = {
  exec: 'Isolated sandbox',
  codemode: 'Isolated sandbox',
  tool_search: 'Tool search',
  apply_patch: 'Apply patch',
  explore_mark: 'Explore mark',
  explore_fold: 'Explore fold',
  turn_discard: 'Turn discard',
  turn_recall: 'Turn recall',
  subagent: 'Subagent',
  workflow: 'Workflow',
  ask_user: 'Ask user',
  task_output: 'Task output',
  task_stop: 'Task stop',
  message_coworker: 'Message coworker',
  message_main_agent: 'Message main agent',
  recall: 'Recall memory',
  memory_search: 'Memory search',
  memory_capture: 'Memory capture',
  memory_crystallize: 'Memory crystallize',
  memory_delete: 'Memory delete',
  browser_navigate: 'Browser navigate',
  browser_snapshot: 'Browser snapshot',
  browser_click: 'Browser click',
  browser_type: 'Browser type',
  browser_tabs: 'Browser tabs',
  browser_lock: 'Browser lock',
  browser_fill: 'Browser fill',
  browser_press_key: 'Browser press key',
  browser_scroll: 'Browser scroll',
  browser_select_option: 'Browser select option',
  browser_mouse_click_xy: 'Browser click xy',
  browser_drag: 'Browser drag',
  browser_highlight: 'Browser highlight',
  browser_get_bounding_box: 'Browser bounding box',
  browser_screenshot: 'Browser screenshot',
  browser_cdp: 'Browser CDP',
  web_search: 'Web search',
  web_fetch: 'Web fetch',
  todo: 'Todos',
};

export function toolLabel(name: string, t: TFunction): string {
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : name;
}

/** 子代理按 id 指代目标的操作 → 行头动作词 i18n key */
export const SUBAGENT_OP_LABEL_KEYS: Record<SubagentOp, string> = {
  report: 'Read report',
  wait: 'Wait',
  stop: 'Stop',
  dismiss: 'Dismiss agent',
  list: 'List agents',
};
