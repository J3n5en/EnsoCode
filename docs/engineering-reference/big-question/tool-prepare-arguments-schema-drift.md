# 工具归一化产物必须满足自己声明的 schema

## 症状

`memory_capture` 单测全绿（`prepareArguments` / `execute` 直接调用都通过），真机上模型每次调用都被
拒绝，报参数不合法，记忆永远不落库。同一个工具的 `memory_search` 正常。

## 根因

pi 的工具执行顺序是 **`prepareArguments` → JSON schema 校验（TypeBox `Value.Check`）→ `execute`**。
归一函数在参数里追加了一个内部派生字段 `unitTypeSource`，但工具 schema 的 `properties`
没有声明它，且 `additionalProperties: false`。于是归一后的对象比模型发来的原始对象**多了一个键**，
校验阶段整体判非法。

症状出在「模型传参不合法」，根因却在我们自己的归一函数：症状与根因隔了一层。
测试之所以全绿，是因为直接调 `prepareArguments` / `execute` 绕过了 pi 的校验步骤。

## 修法

1. 派生信息不进工具参数。`unitTypeSource`（`explicit | fallback | default`）改由 Main 侧
   `parseMemoryCaptureRequest` 根据 `unitType` 的原文自行判定；worker 只做 trim / 小写透传。
2. 归一函数只允许产出 schema 里已声明的键；需要「回退到缺省值」时也只能改已声明键的值。

## 回归防线

`src/agent/tools/memory.test.ts`「prepareArguments 的输出必须通过本工具自己的 JSON schema」：
对每个工具、多组代表性输入，断言 `matchesJsonSchema(tool.parameters, prepareArguments(input))`。
新增带 `prepareArguments` 的工具，照抄这条测试。

## 可选演进字段也要成对归一

另一次 `memory_capture` 真机失败来自填齐可选字段：`evolvesFromId: ''` 搭配合法枚举 `evolvesRelation: 'enriches'`。归一只丢空 id、留下关系，虽然 schema 通过，Main 成对校验仍拒绝；改用只传必要字段的调用才成功。

仅将「显式空白字符串 id + 合法关系枚举」视为未指定演进并成对丢弃。关系先 trim/小写；非空 id 缺关系、缺 id 键却给关系、非字符串 id 或非法关系仍拒绝，不得统统降级成新写入。Main 校验不放宽。

回归覆盖完整占位载荷、对象/JSON 字符串、两次归一幂等，以及 `prepareArguments → schema → execute → Main parse`；真正成对的演进参数保持不变。隔离真机用 OpenAI `gpt-4.1-mini` 与 xAI `grok-4.6` 直接调用完整占位载荷，两者均返回 `inserted`。

## 相关代码

- `src/shared/memory/toolParams.ts` — `normalizeMemoryCaptureParams` / `parseMemoryCaptureRequest`
- `src/agent/tools/memory.ts` — schema 声明
- `src/agent/tools/ensoApp.ts` — 同类「归一在校验之前」的注释
- `src/tooling/productCapabilityCoverage.fixture.ts` — `matchesJsonSchema`
