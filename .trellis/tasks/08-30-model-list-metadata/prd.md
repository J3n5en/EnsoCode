# listModels 解析并落地 context_length / max_tokens 元数据

## 背景

自定义 provider（如 cfbot 的 OpenAI 兼容 worker）的 `GET /v1/models` 现已返回
`context_length` 等扩展字段；Google 官方 `v1beta/models` 一直返回
`inputTokenLimit` / `outputTokenLimit`。但 EnsoCode 的
`extractModelIds`（`src/main/services/providerApi.ts`）只取 `id`，元数据全部丢弃，
这些模型的 contextWindow 只能走 catalog/default 兜底（自定义站基本 miss，
spawn 时套 128K 假数字）。

参考 DeepChat（`aiSdkProvider.ts` new-api 分支）的字段识别清单与
「API facts 优先级低于用户覆盖」原则。

## 方案（MVP）

1. **shared 类型**：`ListModelsResult.models` 从 `string[]` 改为
   `FetchedModel[] = { id: string; contextWindow?: number; maxTokens? : number }`。
2. **main 解析**：`extractModelIds` → `extractModelEntries`，通用字段探测
   （所有分支共用一个提取器，Ollama `/api/tags` 天然无这些字段）：
   - context: `context_length | contextLength | input_token_limit | max_input_tokens | context_window | context_size | inputTokenLimit`
   - max out: `max_completion_tokens | max_output_tokens | output_token_limit | max_tokens | outputTokenLimit | top_provider.max_completion_tokens`
   - 数值一律过 `positiveFiniteNumber`（复用 `@shared/modelCatalog`），非正/非有限丢弃。
3. **renderer 落地**：新增纯函数 `mergeFetchedModels(current, fetched)`
   （放 `src/shared/modelEntry.ts`，两处 UI 共用）：
   - 新模型：追加 `{ id, enabled: true, contextWindow?, maxTokens? }`；
   - 已有模型：**仅回填缺失字段**，绝不覆盖已有值（已有值 = 用户覆盖，优先级更高）；
   - `ProviderApiForm.handleFetchModels` 与 `LocalImportDialog.fetchModels` 改用它。
4. **capability 契约不变**：`providers.fetch-models`（agent 工具）继续返回
   model id 字符串数组（gateway 处 `map(m => m.id)`），不改对外形状。

## 已知取舍

- 拉取到的元数据写入 ModelEntry 的 override 字段层（行徽章会显示 override）。
  独立 "API facts" 层（DeepChat 五层链）不在本次范围。
- 「仅回填缺失字段」意味着上游改值后已落地的旧值不会自动刷新；用户可手动清除
  override 再拉取。

## 验收

- [ ] `extractModelEntries` 各分支单测（含字段变体、脏数据、优先级顺序）
- [ ] `mergeFetchedModels` 单测（新增/回填/不覆盖）
- [ ] `providers.fetch-models` capability 返回形状不变（string id 数组）
- [ ] `pnpm typecheck && pnpm test` 绿，`biome check` 干净
- [ ] 真机：cfbot 拉取后 `grok-4.6` 行显示 contextWindow 256000
