# renderer 层规范（React 界面）

`src/renderer/` 是两个窗口共用的一套 React 代码，通过不同入口挂载不同根组件。

## 结构

```
src/renderer/
  index.html / index.tsx        主窗口入口
  settings.html / settings.tsx  设置窗口入口
  App.tsx
  components/
    ui/                         base-ui 封装，约 50 个，kebab-case 文件名
    app/                        应用级组件（TitleBar）
    settings/                   设置面板与弹窗，PascalCase
  stores/settings/              唯一 zustand store
  hooks/                        useTrafficLightsGuard 等
  lib/                          utils(cn) / z-index / ghosttyTheme
  i18n.ts                       useI18n
  styles/globals.css            Tailwind 4 @theme 令牌
  data/terminal-themes.json     生成产物，勿手改
```

路径别名：`@/` → `src/renderer/`，`@shared/` → `src/shared/`。
跨层只能引 `@shared`，**不要从渲染层 import 主进程代码**。

## Pre-Development Checklist

- [ ] 需要的 UI 基础组件，`components/ui/` 里是否已有？不要重复造，也不要直接用 base-ui 原语。
- [ ] 新的用户可见文案，是否用 `t()` 包裹并在 `src/shared/i18n.ts` 补了中文？
- [ ] 弹窗是否用了 `DialogHeader` / `DialogPanel` / `DialogFooter` 三件套？见 [dialogs.md](dialogs.md)。
- [ ] 弹窗内有下拉/浮层？必须传 `zIndex={Z_INDEX.DROPDOWN_IN_MODAL}`，否则被遮住。
- [ ] 往 `Input` / `Textarea` 传 `className` 时，样式该落在包裹层还是内部元素？见 [components.md](components.md)。
- [ ] 新增设置项：是否有副作用需要写进 `applySettings()` 才能多窗口同步？
- [ ] 调用主进程能力，preload 里是否已有对应方法？见 [../main/ipc.md](../main/ipc.md)。

## 详细规范

- [components.md](components.md) —— ui 封装约定、组件组织、常见传参陷阱
- [dialogs.md](dialogs.md) —— 弹窗结构、内边距体系、层级
- [state.md](state.md) —— zustand store、持久化、多窗口同步
- [styling.md](styling.md) —— Tailwind 4 令牌、cn()、主题系统
- [i18n.md](i18n.md) —— 翻译键即英文原文
