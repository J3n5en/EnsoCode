# 打开较大历史对话：加载中、慢、卡

## 问题
用户打开较大的历史对话时，界面长时间显示「加载中」，主线程卡顿。

## 目标（本轮）
交叉排查瓶颈，产出按证据排序的根因假设与验证路径。不先改代码。

## 关注面
- persist / rehydrate 是否一次灌入全部 messages
- selectConversation 是否同步读盘 / 投影整卷 journal
- Chat 时间线是否无虚拟化、一次 mount 全部消息
- Main `readChildHistory` / session JSONL 是否整文件解析后 IPC
- zustand persist 写回是否在打开时被触发

## 验收（排查阶段）
- 有调用链 + 文件锚点
- 假设按「阻塞主线程 / 阻塞 IPC / 渲染 inflame」分类
- 每条假设有可复现或可证伪的检查点
