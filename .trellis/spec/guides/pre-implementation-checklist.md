# 动手前检查清单

非平凡改动指：涉及多个文件、跨层、改公开接口、或改动不是你刚写的代码。
小而明确的改动直接做，不必走这个清单。

## 1. 说清改动边界

写下四句话再动手：

- **行为差距**：现在会发生什么，应该发生什么？用最小的一句话描述。
- **行为在哪**：这个行为真正住在哪一层？（不是"在哪拦截最方便"）
- **要改哪些文件**：每个文件为什么必须改？
- **明确不做什么**：这次不碰的相邻问题。

如果写的过程中发现范围明显比预期大，先说出来，不要自行扩大改动。

## 1.5 TDD 角色分离（强烈推荐，不是必须）

可单测的逻辑改动本身仍走 [testing.md](../testing.md) 的 Red-Green。
**逻辑面大的改动**（跨模块、用例多、协议 / 解析器 / 路径与 watch 这类）强烈推荐用 coworker 拆成两个脑子，防「红造假」和「绿自证」：

- **测试先行者**（coworker，`agent_type: tester`）：只读 PRD 与接口契约，产出失败测试并确认红灯；tester 的 edit/write 被工具层限制在测试文件。
- **实现者**（主会话或另一 coworker）：红灯到手前不开写（否则 tester 会读到实现）；只许改实现，不许改测试文件让灯变绿。
- 等待用 `coworker wait {name}`（不要 sleep 轮询）；回报截断用 `coworker report {name}` 取全文。
- 验收看 `gate: "pnpm test"` 的退出码，不采信文字汇报。

小改动直接主会话 inline Red-Green：测试文件预计 < 50 行，或用例 < 10 个。
完整约定见仓库根 `AGENTS.md`「TDD 的角色分离」。跳过时在动手前用一句话说理由（例如「单测不足 10 个、inline」），不要默默省掉。

## 2. 定位层

对照 [cross-layer-thinking-guide.md](cross-layer-thinking-guide.md) 确认：
需要新的 IPC 通道吗？需要新的 store 字段吗？会写进 `settings.json` 吗？

**三点式链路**（通道常量 / handler / preload 出口）缺一处就是运行时才炸的断链。

## 3. 找已有实现

对照 [code-reuse-thinking-guide.md](code-reuse-thinking-guide.md)。
本仓库有几套成型的模式，新功能大概率能套用而不是新造：

- 扫描外部应用 → `services/providerScan/` 或 `services/assetScan/` 的三件套结构
- 设置页的列表 + 导入 + 编辑 → `ProvidersSettings` / `SkillsSettings` 系列
- 弹窗 → `DialogHeader` / `DialogPanel` / `DialogFooter` 三件套

## 4. 想清边界情况

本仓库反复出现的几类：

- **文件不存在 / 格式损坏 / 权限不足** —— 用户没装那个应用是常态，不是错误。
- **旧数据**：改了持久化类型，磁盘上的老 `settings.json` 会怎样？
- **重复**：新增的实体，"什么算同一个"？见 [../big-question/dedupe-identity.md](../big-question/dedupe-identity.md)。
- **敏感数据**：明文密钥、env 值有没有漏到渲染层？
- **多窗口**：这个状态改了，另一个窗口需要同步吗？

## 5. 想清代价

- 会真实调用外部 API 吗？会计费吗？（连通性测试就会）
- 会写用户的原文件吗？路径可控吗？
- 会让 `settings.json` 显著变大吗？

## 6. 收尾

```bash
pnpm typecheck && pnpm lint && pnpm test
```

三者干净，且没有调试残留：

```bash
command grep -rn "TEMP-DEBUG\|remote-debugging-port\|console.log(" src/
```

改动完成后按「一个可独立描述的改动 = 一次提交」的粒度提交。
