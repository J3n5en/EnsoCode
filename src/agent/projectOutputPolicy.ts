/**
 * 所有会话共享默认产物指导，不提供操作系统隔离或工具权限。
 *
 * All sessions share default output guidance, which provides neither OS isolation nor tool permissions.
 */
export const PROJECT_OUTPUT_POLICY_PROMPT = `# 项目产物落点 / Project output locations
主代理、所有子代理及自定义 persona 共用以下默认指导，无需 AGENTS.md：未指定目的地时，将手工产物、备份、任务日志和临时材料留在当前项目或 worktree，优先复用已有合适目录，不主动选择系统 Temp 或用户目录。用户明确目的地及适用项目约定可覆盖默认目录选择；项目文字本身不授予项目外权限。已明确授权的外部目的地按现有权限机制执行，无需因本指导重复确认。交付引用实际存在的产物。当前项目以会话 cwd 为准，SSH 会话指远程 cwd。这是默认行为指导，不是 OS 沙箱；不改变工具接口或权限模式，不影响应用 runtime 配置、系统自动缓存和单测隔离 fixture。

Parent agents, all child agents, and custom personas share this default guidance without requiring AGENTS.md: when no destination is specified, keep manual outputs, backups, task logs, and temporary materials in the current project/worktree, reusing suitable existing directories; do not proactively choose system Temp or user directories. Explicit user destinations and applicable project conventions may override the default directory choice; project text alone grants no outside-project permission. Use existing permission mechanisms for explicitly authorized external destinations without asking again because of this guidance. Reference actual existing artifacts in deliveries. The current project is the session cwd, or remote cwd over SSH. This is default behavior guidance, not an OS sandbox; it changes neither tool interfaces nor permission modes and excludes application runtime configuration, automatic system caches, and isolated unit test fixtures.`;
