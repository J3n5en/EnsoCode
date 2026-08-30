# Worktree 隔离会话

## 背景与决策（已定，勿重开讨论）

- 会话**默认本地工作区**（主工作树），worktree 隔离是**显式 opt-in**。拒绝「每会话一个 worktree」。
- 同 cwd 多会话的重叠编辑冲突**不做产品级解决**（已接受的取舍）。
- 不做应用内 merge-back / 冲突解决 UI。merge 交给用户在终端/agent 对话完成。产品只负责「看见 + 拦截」。
- 参考：EnsoAI `WorktreeService`（杀进程、安全删分支等实现经验）、Lody（setup/cleanup、per-session 路径解析）。
- 决策全文见 `docs/plans/2026-08-22-enso-code-design.md` 「trust 与 isolation」节。

## 需求

### 1. 创建隔离会话（opt-in）
- 新建会话入口提供「worktree 隔离」选项，默认关闭。
- 开启时：从当前 HEAD `git worktree add`（新分支，命名可自动生成），worktree 放托管目录（项目外）。
- 会话元数据持久化 cwd / worktree 路径 / 分支。

### 2. Move to worktree（半路切，干净切换）
- 仅当主工作树干净时允许；有未提交改动 → 拒绝并提示先 commit/stash。
- 切换 = 建 worktree + 切 session cwd + 向 agent 注入迁移 system-reminder（此前绝对路径失效）。
- 脏迁移（patch 搬运）不做。

### 3. 侧边栏徽标
- 隔离会话在会话列表显示状态徽标：
  - 未提交改动（worktree dirty）
  - 分支领先主分支未合并
- 状态需要合理的刷新时机（会话活动结束后 / 定时轻量刷新），不能每帧跑 git。

### 4. 清理 / 归档 / 删除拦截
- 右键「清理 worktree」：只删 worktree、保留会话；会话 cwd 回退主工作树 + 注入迁移 reminder。
- 归档 / 删除会话：连带清理 worktree。
- 三者共享同一套拦截：存在未提交/未合并时弹确认，说明将丢失/残留什么。
- 清理前杀 worktree 目录内残留进程；未合并分支默认保留不硬删。

### 5. Resume 校验
- resume 时校验 worktree 是否仍存在；丢失时不自动重建，让用户选「从记录分支重建」或「回退主工作树」（回退同样注入 reminder）。

### 6. 移动端约束（本任务只保证不破坏）
- 路径解析 per-session，不假设全局单 cwd。
- 「Move to worktree」等动作不在移动端提供，但移动端展示会话状态需正确。

## 验收标准

- [ ] 新建会话可选隔离；隔离会话所有 agent 工具调用在 worktree 内执行
- [ ] Move to worktree 干净切换可用，脏工作区被拒绝
- [ ] 侧边栏徽标正确反映未提交/未合并状态
- [ ] 清理/归档/删除带拦截提示，清理后会话回退主工作树可继续对话
- [ ] resume 丢失 worktree 时给出重建/回退选择
- [ ] `pnpm typecheck && pnpm test && biome check` 全绿
- [ ] CDP 真机验证以上主流程

## 非目标

- 应用内 merge / 冲突解决 UI
- 脏迁移（patch 搬运）
- 移动端触发隔离操作
- 多会话同 cwd 冲突模型
