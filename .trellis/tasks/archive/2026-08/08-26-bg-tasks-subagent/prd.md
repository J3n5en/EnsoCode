# PRD: 后台任务与 Subagent(父任务)

## 用户需求(原话拍板)

参考 EnsoAI 的 SessionBar:**有 background tasks 或 subagent 时显示胶囊,点击胶囊查看 task 和 subagent 的输出和进度**。

## EnsoAI SessionBar 设计要点(调研结论,取形)

- 悬浮药丸容器:`rounded-full border bg-background/80 px-2 py-1.5 shadow-lg backdrop-blur-sm`,浮于内容之上(顶部居中偏上);
- 内部横向排列小胶囊(`rounded-full px-3 py-1 text-sm`,激活 `bg-accent`);
- 状态色:running 绿 / waiting 琥珀 / completed 蓝(脉冲点);
- 注意:EnsoAI 点击胶囊是切换常驻 xterm 终端;enso 无常驻终端,**交互改为点击展开详情浮层**(与用户需求一致)。

## enso 适配设计

- **TaskBar 胶囊条**:浮于消息时间线顶部居中(absolute,不占布局);**仅当当前会话存在后台任务或子代理(running/unread)时出现**,全部结束且已查看后淡出;
- 每个条目一个胶囊:图标(Terminal=后台任务 / Bot=子代理)+ 名称(命令/agent 名截断)+ 状态点(running 绿脉冲 / done 蓝 / failed 红);
- **点击胶囊 → 下方展开详情面板**(浮层):后台任务显示输出尾部(流式追加,等宽字体,可滚动)+ 停止按钮;子代理显示进度(当前步骤/工具 + 最终产出),二级可跳看完整子会话;
- v1 不做:拖拽/吸边收起/辉光(EnsoAI 的辉光实现本身是坏的)。

## 子任务

| 子任务 | 内容 |
|---|---|
| 08-26-background-tasks | bash 工具加 background 能力 + task_output/task_stop 工具 + 胶囊条与输出面板 |
| 08-26-subagent | task 工具(同 worker 子会话)+ 生命周期(abort/审批继承)+ 胶囊接入与子代理详情 |

顺序:background-tasks 先(其「任务事件流→胶囊」的通道被 subagent 复用)。

## 跨任务验收

- agent 后台跑 dev server 不阻塞轮;胶囊实时反映输出;点击可见输出尾部;可手动停止;
- subagent 并行执行时胶囊逐个出现,点击看进度;abort 父会话联动终止;
- 全绿 + 实机验证。
