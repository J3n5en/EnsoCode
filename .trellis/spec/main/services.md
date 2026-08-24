# services 层规范

`src/main/services/` 放不依赖 `ipcMain` 的业务逻辑。两类典型：**扫描外部应用配置**、
**对外发起网络请求**。

## 扫描器的三件套结构

`providerScan/` 和 `assetScan/` 都是同一套形状，新增扫描来源时照此扩展：

| 文件 | 职责 |
|------|------|
| `locations.ts` / 编排文件里的 `sourceSpec()` | 「去哪找」：各应用配置路径，含平台差异与自定义数据目录 |
| `readers.ts` / `skills.ts`、`mcp.ts`… | 「怎么读」：每种格式一个纯函数，返回归一化结构 |
| `index.ts` | 编排：遍历来源、去重标记、缓存明文、对外暴露 scan / collect |

读取器必须是**纯函数**：入参是路径，出参是归一化数组，不打印、不抛给上层。
格式解析失败就返回空数组（见 `assetScan/skills.ts` 的 `readFrontmatter`）。

单个来源出错不能让整体扫描失败 —— 编排层逐来源 try/catch，把状态记进报告：

```ts
try {
  // 读取该来源
  report.status = 'found';
} catch (error) {
  console.warn(`[AssetScan] Failed reading ${sourceId}:`, error);
  report.status = 'read-error';
}
```

## 敏感数据不出主进程

明文 API Key、MCP 的 env 值只保留在主进程的一次性缓存里：

```ts
// 仅保留最近一次扫描，供确认导入时取回完整数据（含 env 明文）
let lastScan: { scanId: string; byId: Map<string, Cached> } | null = null;
```

流程是两段式：

1. `scan()` 返回**脱敏候选**（`apiKeyMasked`、`envKeys` 只有键名）+ 一个 `scanId`
2. 用户确认后 `collect(scanId, ids)` 才从缓存里取出完整数据返回

`scanId` 不匹配就返回空数组，防止用过期的 id 捞数据。新增扫描类型时保持这个切分。

## 去重按各自的身份定义

不同资产的「同一个」含义不同，用错就会漏判或误判。当前的定义：

| 资产 | 指纹 | 为什么 |
|------|------|--------|
| 模型服务 | `baseUrl + apiKey` | 同一个端点同一把钥匙就是同一个服务 |
| 技能 | **名称**（小写） | 技能以名称调用，同名无法共存；同一技能常被多个工具各装一份到不同路径 |
| MCP 服务器 | 启动命令 + 参数，或 URL | 名字各家不同（`cunzhi` / `寸止`），命令才是身份 |
| 指令文件 | **内容 SHA-256** | 文件名相同内容各异（多家的 `AGENTS.md`），内容相同文件名各异（`CLAUDE.md` 与 `AGENTS.md` 常是同一份） |

实现在 `assetScan/index.ts` 的 `skillNameKey` / `mcpKey` / `seenInstructionHashes`。

重复项**标记而不丢弃**：候选带 `duplicated` 和 `duplicateReason`
（`registered` / `same-content` / `same-name`），界面上置灰且默认不勾选，
用户仍可手动选。三层都要拦：扫描标记、collect 批内去重、store 落库前再判一次。

## 网络请求按协议分派

`providerApi.ts` 按 `ModelApiKind` 分派 URL、请求头和请求体。约定：

- base URL 为空时用 `DEFAULT_BASE_URLS` 兜底。
- 版本段用 `withVersionSegment()` 拼接，已含 `/v1` 就不重复加。
- 统一 15 秒超时（`AbortController` + `setTimeout`，`finally` 里清 timer）。
- 错误统一转成可读字符串：`errorText()` 截断响应体到 300 字符，
  `toMessage()` 把 `AbortError` 翻译成 `Request timed out`。

**连通性测试会真实调用模型**（`max_tokens: 1` 的最小请求），会计费。
没指定模型时退化为拉取模型列表，只验证鉴权和连通。改动这里要保持这个代价意识。

## 写入校验

任何按渲染层传入的路径写文件，都必须先校验。`instructionStore.ts` 的两道：

```ts
// 1. id 只接受 uuid 形态，避免路径穿越
const isValidId = (id: string): boolean => /^[a-f0-9-]{36}$/i.test(id);

// 2. 写回源文件前，核对该路径确实是这个条目已登记的 sourcePath
function isRegisteredSource(id: string, sourcePath: string): boolean { ... }
```

没有第二道，`instructions:write-source` 就成了「渲染层可写任意文件」的通道。
新增任何写文件通道时想清楚：**攻击者控制这个参数能写到哪里**。
