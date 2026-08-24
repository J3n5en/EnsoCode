# 代码复用思考指南

新建文件或复制一段实现之前，先花两分钟找一遍。本仓库已有几套成型模式，
多数新需求是"再来一个同类"，不是"从零造一个"。

## 已有的可复用模式

| 需求 | 照抄哪里 |
|------|----------|
| 扫描某个本地应用的配置 | `services/assetScan/`：`sourceSpec()` 定位 + 独立读取器 + 编排层 |
| 读某种新格式 | `assetScan/mcp.ts`（JSON/TOML）、`skills.ts`（frontmatter）、`ccSwitch.ts`（sqlite） |
| 设置页新增一类实体 | `SkillsSettings.tsx` / `McpSettings.tsx`：列表 + 空态 + 导入按钮 + 编辑弹窗 |
| 多类型共用的导入弹窗 | `LocalAssetImportDialog.tsx`：`kind` 参数过滤候选 |
| 编辑弹窗 | `ProviderEditDialog.tsx`：`{ entity \| null, onClose }` + effect 重置状态 |
| 按协议分派的网络调用 | `services/providerApi.ts` 的 `switch (config.api)` |
| 带脱敏的两段式导入 | `providerScan/index.ts` 的 `lastScan` 缓存 + `scanId` |

## 三个问题

**1. 这个逻辑是不是已经存在？**

先搜一遍再写。例：想写"路径转 `~/` 显示"，`assetScan/skills.ts` 已有 `displayPath()`。
想写"合并类名"，`lib/utils.ts` 已有 `cn()`。

**2. 我要复制的这段，差异在哪？**

如果只有少数几个值不同 → 提参数，不要复制。
如果结构相同但语义不同 → 复制可以接受，但**注释写清为什么不共用**。

反例参考：技能、MCP、指令文件的去重逻辑结构几乎一样，
但**指纹定义完全不同**（名称 / 命令 / 内容哈希），
强行抽象成一个通用去重函数只会把关键差异藏起来。这里的重复是对的。

**3. 抽象的代价是什么？**

本仓库倾向"三次以上才抽象"。两处相似先留着，第三处出现时再提。
过早抽象出来的通用函数往往参数比逻辑还多。

## 不要重复的东西

这几类必须单一来源，出现第二份就是 bug 隐患：

- **IPC 通道名** —— 只在 `IPC_CHANNELS`，不写字符串字面量
- **层级数值** —— 只在 `Z_INDEX`，不写数字
- **跨进程共享的几何常量** —— 如 `TRAFFIC_LIGHT_POSITION`，导出复用
- **去重指纹函数** —— 主进程和 store 两处都要判，但**规则要一致**；
  改了一处就得改另一处（当前这是刻意的重复，改动时注意同步）
- **翻译文案** —— 同一句话在多处出现时用同一个 key
