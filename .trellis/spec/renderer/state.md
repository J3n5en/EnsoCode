# 状态管理规范

两个 store：持久化的 `stores/settings/` 与内存态的 `stores/sessions/`。

```
stores/settings/
  types.ts     SettingsState：数据字段 + 全部 action 的签名
  storage.ts   electronStorage：persist 的 IPC 存储适配器
  index.ts     create + persist + 副作用
stores/sessions/
  reducer.ts   applyAgentEvent：agent 事件 → 会话投影的纯函数（seq 单调守卫）
  index.ts     create（不 persist）+ onAgentEvent 订阅 + spawn/send/abort
```

`sessions` 是**可丢弃投影**（权威源在 worker/jsonl），不 persist、不进 settings.json。
消息按 `message-upsert` 的 index 整条替换，**没有增量归并**；
过期 seq 的事件在 reducer 里丢弃。改事件处理逻辑时改 `reducer.ts`（纯函数，有测试），
不要把逻辑写进订阅回调。

## 加字段的完整流程

漏掉任何一步都会出问题：

1. `types.ts` 的 `SettingsState` 加字段和 action 签名（带中文注释说明约束）
2. `index.ts` 的 `initialState` 加默认值
3. `index.ts` 的 create 里实现 action
4. 有副作用（主题、字体、语言）→ 同时写进 `applySettings()`，
   否则多窗口同步时另一个窗口不生效
5. 会被主进程读取（去重比对）→ 同步 `src/main/services/assetScan/index.ts` 的 `existingKeys()`

## 订阅要选片，不要整取

```tsx
// 正确：只在 providers 变化时重渲染
const providers = useSettingsStore((state) => state.providers);
const updateProvider = useSettingsStore((state) => state.updateProvider);

// 错误：任何设置变化都会重渲染
const { providers, updateProvider } = useSettingsStore();
```

## 批量新增返回实际数量

导入类 action 内部去重，返回**真正新增的条数**，让界面能如实反馈
（"已导入 37 项"而不是"已导入 59 项"）：

```ts
addSkills: (skills) => {
  const knownNames = new Set(get().skills.map((s) => nameKey(s.name)));
  const fresh = skills.filter((skill) => { /* 判重并累积 */ });
  if (fresh.length > 0) set((state) => ({ skills: [...state.skills, ...fresh] }));
  return fresh.length;
},
```

去重的身份定义各不相同，见 [../main/services.md](../main/services.md) 的去重表。
主进程扫描时已经标记过重复，store 这层是最后一道 —— 两处都要有。

## 删除要清理外部资源

`removeInstruction` 除了改 state 还要删掉磁盘上的本地副本：

```ts
removeInstruction: (id) => {
  // 只删本地副本，源文件不动
  void window.electronAPI.instructions.delete(id);
  set((state) => ({ instructions: state.instructions.filter((i) => i.id !== id) }));
},
```

新增「有外部落地物」的实体时照此处理，别让文件残留。

## 持久化边界

store 里的一切都会被写进 `settings.json`。因此：

- **大段文本不要进 store** —— 指令文件内容存 `userData/instructions/<id>.md`，
  store 只留元数据（`name` / `sourcePath` / `local` / `bytes`）。
- 临时 UI 状态（弹窗开合、筛选词、忙碌标记）用 `React.useState`，不要进 store。
- 字段的兼容性约束见 [../shared/types.md](../shared/types.md) 的"持久化类型的演进"。

## 多窗口同步

store 末尾注册了 `settings.onChanged` → `persist.rehydrate()`。
这意味着**任何窗口的写入都会让其它窗口重载整个 store**。
写操作要幂等、要小、不要在 rehydrate 的副作用里再触发写入，否则会形成回环。
