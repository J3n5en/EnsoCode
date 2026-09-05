# 运行时 / 原生层：oh-my-pi vs EnsoCode

来源：coworker `omp-runtime`。

对方：TS 上层 + N-API + ~80k Rust（shell/builtins/walker/ast/iso/voice/natives）+ 持久 eval。
我们：Electron + 打补丁的 pi-coding-agent + spawn rg/bash。

## 对方有而我们没有

- 进程内 rg/glob/find，Windows 无 fork 风暴
- brush bash + 50+ 进程内 coreutils（含 jaq），会话跨 tool call 保活，Windows 免 WSL
- eval 内核 + `agent()`/`tool.*` 回桥
- notebook 虚拟文本 + 复用 python eval
- 桌面 AX computer-use
- natives loader（AVX2 分级、嵌入 .node）
- fs-scan-cache、artifact://、prewalk
- auth-broker 集中 OAuth/轮换
- Hashline 内核

## 双方都有

- 都能跑 shell、搜文件、改文件；质量和延迟差一个数量级叙事（巨型仓/Windows 更明显）

## 我们更强

- 不必自研 80k Rust 也能做桌面产品；跟整套 natives 是战略选择不是功能清单

## Top 5（按「能抄且不必先造 Rust」）

1. `artifact://` — 低  
2. Prewalk — 中低  
3. Hashline 作 TS 库 — 中  
4. 持久 eval + bridge — 高  
5. 进程内 bash/rg — 极高，除非我们要做跨平台 CLI 内核  

不要把「没有 Rust crate」本身当成产品缺口。  
