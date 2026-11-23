// 被大量轻模块引用的枚举与上限；放在 agent.ts 里会让它们各自多加载 5000 多行的协议类型文件

/** 本轮汇报的硬上限：装得下一份正常汇报，又挡住异常长输出 */
export const TURN_REPORT_MAX_CHARS = 8000;

/** 思考努力档位（reasoning 开启时有效），值域对齐 pi 的 ThinkingLevel。off 由 reasoningEnabled 表达 */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 审批档位：supervised 全审 / auto-edits 免文件 / assistant 助手代审 / full 全放行 */
export const APPROVAL_MODES = ['supervised', 'auto-edits', 'full', 'assistant'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
