# 调查模型目录与 Google 最新模型缺失

## Goal

查清当前模型目录与用量价格目录的内容和来源，解释 Google 最新模型 `gemini-3.8-flash-high` 未计入费用的原因，并给出可独立实施的最小修复边界。

## Background

- 用量页按会话 JSONL 中的原始模型字符串聚合，因此当前显示 `gemini-3.8-flash-high`、`gpt-5.6-sol` 和 `imported`。
- 模型目录来自 `@earendil-works/pi-ai` 静态目录，加上运行时动态注册的 Google Antigravity 与 Cursor provider。
- 用量价格目录不是独立数据文件，而是 `src/main/services/usage/usageService.ts` 从运行时模型目录的非零 `cost` 字段派生出来的内存表。

## Confirmed Facts

1. 当前 EnsoCode 使用 `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 0.84.3。
2. pi-ai 0.84.3 静态目录包含 39 个 provider、1312 个模型；其中 Google 22 个、Google Vertex 13 个，最新只到 `gemini-3.7-flash`。
3. npm 最新 0.84.4 发布于 2026-08-28；直接检查其 tarball 后确认仍不含 `gemini-3.8-flash`。
4. Google 于 2026-09-02 正式发布 GA 模型 `gemini-3.8-flash`；`-high` 是 Antigravity wire id 中的思考档位，不是公网 API 正式模型 ID。
5. Google 官方公布的 3.8 Flash 初次体验价截至 2026-12-31 为输入 $0.75/M、输出 $3.75/M；2027-01-01 起为输入 $1.50/M、输出 $7.50/M。
6. `resolvePricing` 会把 `gemini-3.8-flash-high` 回退为 `gemini-3.8-flash`，但本地目录没有该基础 ID，所以仍查不到价格。
7. Antigravity 动态条目使用全零 `cost`；价格表构建逻辑会主动过滤全零条目，避免把订阅模型误显示成免费 API。
8. `imported` 不是模型，而是外部会话导入时写入的虚拟 provider/model；其 token 全为 0，但当前仍被加入无单价模型集合。

## Requirements

- [x] 定位模型目录、价格目录与用量聚合来源。
- [x] 盘点当前 provider 数量及 Google/Gemini 条目。
- [x] 核对 Google 官方最新模型、正式 ID、状态与价格。
- [x] 解释 `gemini-3.8-flash-high` 和 `imported` 出现无单价提示的原因。
- [x] 给出不混淆三个独立问题的最小修复方向。

## Acceptance Criteria

- [x] 已确认模型目录与价格目录不是同一概念，但价格目录由模型目录派生。
- [x] 已确认本地 Google 目录最新到 3.7，且 0.84.4 也未包含 3.8。
- [x] 已通过 Google 官方模型页、Latest Model 页面和 Context7 核验 3.8 的正式 ID与价格。
- [x] 已完成从会话解析、价格匹配到 UI 警告的 file:line 根因链路。
- [x] 已将主会话复核结论写入 `research/verified-conclusion.txt`。

## Proposed Implementation Scope

1. 价格补齐：为用量价格表增加经官方核验的 `gemini-3.8-flash` 本地补充价格，使已有的 `-high` 后缀回退生效。
2. 模型归一：在 Antigravity 逻辑模型表中补 `gemini-3.8-flash`，把 low/medium/high wire id 收拢为一个逻辑模型。
3. 数据清理：从无单价警告中排除 `imported` 这类零 token 虚拟模型。

三项应分别测试、分别提交；其中第 1 项直接解决截图中的费用缺失，第 2 项解决模型目录/选择器命名，第 3 项解决警告噪声。

## Out of Scope

- 不修改上游 npm 包内容。
- 不用模糊匹配或品牌猜测替代精确模型 ID。
- 不将 Antigravity 的订阅实际账单等同于 API 按量账单；用量页继续表达为目录价格估算。
- 未获得用户对最终范围的明确批准前，不修改产品代码。
