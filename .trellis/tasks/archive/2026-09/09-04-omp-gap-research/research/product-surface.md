# 产品表面：oh-my-pi vs EnsoCode

来源：coworker `omp-product`。

## 对方有而我们没有

- **ACP**：当 Zed/Neovim 后端。我们自己就是宿主，**可观望**。
- **`omp commit`**：hunk 切片、topo、lockfile 配对。**值得抄。** `commit/agentic/`
- **GitHub as FS**：`pr://` `issue://` + Actions `run_watch`。**可观望/值得。**
- **Marketplace**：Claude 插件兼容。**可观望。**
- **stats 大盘**：cache rate/成本/TTFT/工具失败。**值得抄。** `packages/stats/`
- **metaharness / edit bench / dialect**：开源模型不崩。接杂模型时再上。
- **10 角色 + fallback 链**。**值得抄。**
- **Browser Relay**：接管本机 Chrome 登录态。**值得抄，补内置浏览器短板。**
- **computer / voice / 动态 shell 补全**：我们 GUI 不需要补全脚本；computer/voice 非刚需。
- **文档/SDK/RPC**：对方 docs 极密，工程透明度可学。
- **Snapcompact / catalog / omptype**：snapcompact 见 memory；catalog 角色化可学。

## 分发

对方 curl/brew/nix 单文件 CLI；我们是 Electron IDE。形态不同，不是缺口。

## 我们更强

- 多会话 + Worktree UI
- Coworker Tabs + TDD writeScope
- Phone companion
- 可视化审批 / diff
- 内置浏览器 + Cursor bridge

## Top 5

1. 原子拆分 commit  
2. Snapcompact（黑科技，中高）  
3. stats 大盘  
4. 语义角色 + fallback  
5. Browser Relay  
