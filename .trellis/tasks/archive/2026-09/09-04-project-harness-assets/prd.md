# 项目级外部工具目录（.claude/.codex/.cursor）的 skills 与规则文件加载开关

## 背景
pi 运行时只自动发现 `.agents/skills`、`.pi/skills` 与 `AGENTS.md`/`CLAUDE.md`。
项目里给 Claude Code / Codex / Cursor 准备的 `.claude/skills`、`.cursor/rules/*.mdc`、
`.cursorrules` 等资源 EnsoCode 会话看不到。

## 目标
设置 → Skills 页新增开关「加载项目内其它工具目录」（`loadHarnessAssets`，缺省关）：
- skills：追加项目内 `.claude/skills`、`.codex/skills`、`.cursor/skills` 为 additionalSkillPaths
- 规则：`.cursorrules`、`.cursor/rules/**/*.{mdc,md}`、`.claude/rules/**/*.md` 拼进 agentsFiles
  （.mdc frontmatter 去掉，globs 保留为一行适用范围说明）
- `/skill` 斜杠菜单预览（listProjectSkills）同步覆盖这些根

## 边界
- 远程（ssh）会话不生效：cwd 不在本机
- 类型化子代理不追加（与 noSkills/noExtensions 隔离策略一致）
- 开关从 main 直接读 settings（同 disabledBuiltinTools），renderer 不传参

## 实现
- `src/agent/harnessAssets.ts`（+test）纯逻辑：resolveHarnessSkillRoots / readHarnessRuleFiles / stripMdcFrontmatter
- `supervisor.ts` createSessionResourceLoader 接 loadHarnessAssets
- spawn-parent 命令新增 `loadHarnessAssets?: boolean`
- settings 字段 + capability `general.load-harness-assets`
