# Design: onboarding

## 状态与判定
- settings store 加 `onboarded: boolean`（persist），`setOnboarded(true)`。
- App.tsx 顶层：`const onboarded = useSettingsStore(s => s.onboarded)`；
  `{!onboarded && <Onboarding onClose={() => setOnboarded(true)} />}`。
- 关闭（×）与完成都调 `setOnboarded(true)`——一次性。

## 复用现有导入
四类导入对话框已存在且自带扫描+导入+入 store：
- provider：`LocalImportDialog`（props: open/onOpenChange）
- skill/mcp/指令：`LocalAssetImportDialog kind="skill|mcp|instruction"`（同 props）

问题：它们是 Dialog（自带 backdrop/居中）。onboarding 自身也是全屏模态。
两种方案：
- **A（选用）**：onboarding 用一个全屏 Dialog 承载步骤框架（进度+导航），
  每步内容里**内联复用扫描/导入的“内容”**。但现有导入逻辑封装在 Dialog 组件内部，
  直接内联需要把扫描/导入主体抽出。成本高。
- **B（选用，更省）**：onboarding 步骤框架用轻量覆盖层（非 Dialog，避免嵌套 backdrop）；
  provider/asset 步骤直接**渲染现有导入 Dialog（受控 open=true）**，其居中弹窗浮在
  onboarding 覆盖层之上。onboarding 覆盖层只做欢迎/进度/导航按钮，导入交互仍走原 Dialog。

决策：**B**。onboarding = 一个 z 介于主界面与 Dialog 之间的覆盖层（进度条 + 说明 + 上/下/跳过/关闭）；
到 provider/skill/mcp/指令步时，在覆盖层内放一个「扫描并导入」按钮打开对应现有 Dialog；
用户导入完关掉 Dialog，回到 onboarding 点下一步。这样零改动复用导入，无 Dialog 嵌套地狱。

（若希望导入 UI 直接内嵌不弹二级框，则需先把 LocalImportDialog/LocalAssetImportDialog
的 body 抽成无 Dialog 外壳的 `*Panel` 组件——列为可选后续，不在本期。）

## 文件
| 文件 | 改动 |
|---|---|
| `settings/types.ts` + store | `onboarded` + `setOnboarded` |
| `components/onboarding/Onboarding.tsx`（新） | 步骤框架：欢迎/4 类导入/完成，进度、上/下/跳过、× 关闭 |
| `App.tsx` | 顶层挂载 `{!onboarded && <Onboarding/>}` |
| `shared/i18n.ts` | 文案 |

## z-index
onboarding 覆盖层用 `Z_INDEX.SETTINGS_WINDOW`~`MODAL_BACKDROP` 之间（如 45），
导入 Dialog（MODAL_CONTENT 51）自然浮在其上。

## 边界
- persist 迁移：老用户 settings 无 `onboarded` 字段 → 读为 undefined。
  为避免老用户被打扰，rehydrate 时若 settings 已有 provider/skill 等数据，视为已 onboarded。
  简单起见：`onboarded ?? (providers.length>0 || skills.length>0 || ...)`，或 store 初始
  合成。取「有任意配置即视为老用户，不弹」。
