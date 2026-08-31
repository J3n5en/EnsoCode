# 手机端同步桌面侧边栏排序

## 背景

手机端抽屉（packages/phone/src/SessionDrawer.tsx）的项目/会话排序与桌面侧边栏
（src/renderer/components/chat/Sidebar.tsx）脱节，共三处：

1. 项目拖拽顺序：桌面存 renderer localStorage `enso-project-order`（Sidebar.tsx:119），
   未进 settings store；pairCatalog.ts 下发的是 settings.projects 原始顺序。
2. 置顶手动拖拽顺序：桌面存 localStorage `enso-pinned-order`（Sidebar.tsx:130），catalog 不含。
3. 组内排序：桌面项目组内/置顶组内/归档栏按 lastActiveAt 倒序
   （src/renderer/stores/sessions/pinned.ts），手机端只做 pinned-first、保持 catalog 原序。

## 方案（A + 组内排序）

- 桌面：pairCatalog.ts 下发 `projectOrder: string[]` 与 `pinnedOrder: string[]`
  （读取同一份 localStorage；Sidebar 拖拽落盘后需触发 catalog 重推）。
- 类型：PairCatalogPayload（src/shared/types/pair.ts）新增两个可选字段；
  手机端类型 @enso/pair 同步。
- 手机端：
  - 项目列表按 projectOrder 排序（未收录的追加末尾，语义同桌面 applyProjectOrder）。
  - 置顶栏按 pinnedOrder 排前、未收录的按 updatedAt 倒序追加（同 pinnedConversationIds）。
  - 项目组内 pinned-first + 各组内按 updatedAt 倒序（同 projectConversationIds）。
  - 归档栏按 updatedAt 倒序。

## 兼容性

- 旧桌面 + 新手机：字段缺失时手机回落现有行为（catalog 原序），组内 updatedAt 倒序仍生效。
- 排序逻辑为纯函数，按 TDD 先写测试（放 packages/phone/src，参照 deviceList.test.ts 模式）。

## 验收

- [ ] 桌面拖拽项目/置顶后，手机抽屉顺序在 debounce 后一致
- [ ] 项目组内、置顶组、归档栏与桌面同为活跃时间倒序
- [ ] 旧桌面（无新字段）不报错，手机回落原行为
- [ ] pnpm typecheck && pnpm test 通过
