# Provider 支持手动添加

## 背景

设置页的 Model Providers 目前只能通过「从本地应用导入」（LocalImportDialog 扫描导入）获得 provider，无法手动新建。`ModelProvider.importedFrom` 注释已预留「手动创建时为空」。

## 需求

在 Providers 设置页增加「添加 Provider」入口，允许用户手动填写并保存一个 provider。

## 方案

复用现有 `ProviderEditDialog`（已具备 name / api / baseUrl / apiKey / models 编辑、Fetch models、Test connection 全部能力），扩展出「新建」模式：

- `ProvidersSettings.tsx`：在「Import from local apps」旁增加「Add provider」按钮，打开新建模式弹窗。
- `ProviderEditDialog.tsx`：支持新建模式（无既有 provider 时初始化空表单）；保存时走 `addProviders`（生成新 id、`enabled: true`、不设 `importedFrom`），标题显示「Add Provider」。
- i18n：补充新增文案的中文翻译。

## 验收标准

1. Providers 设置页有「添加」按钮，点击打开空表单弹窗。
2. 填写 name（必填）、api、baseUrl、apiKey，可拉取模型、测试连接（与编辑模式一致）。
3. 保存后 provider 出现在列表中，enabled 为 true，无 importedFrom 徽标。
4. 与既有 provider 指纹（baseUrl+apiKey）重复时不重复入库（沿用 addProviders 去重）。
5. 编辑既有 provider 的行为不受影响。
6. 空列表占位文案同时提示可手动添加。
