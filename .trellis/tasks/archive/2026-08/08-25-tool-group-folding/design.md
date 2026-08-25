# Design: 工具行分组折叠

## 行模型

`TimelineItem` 新增:

```ts
| { kind: 'tool-group'; key: string; expanded: boolean;
    count: number;            // 组内工具数
    stats: { commands: number; reads: number; searches: number; others: number };
    children: TimelineItem[] } // 组内原始行(tool + 夹在其间的 thinking)
```

## 分组规则(纯函数 foldTimeline)

- 输入 `buildTimeline` 的产物 + `running` + `expandedKeys`,输出折叠后的行数组。
- **段**:连续的 `tool | thinking` 行(被 text/user/error 打断);实际时间线 thinking 夹在工具间,严格只数 tool 会把段打碎,故 thinking 收进段内(展开可见),但计数与 ≥3 门槛只数 tool。
- **edit 例外**:段内带 `edits`(diff)的 tool 行不进组,按原相对顺序紧跟组头之后平铺。
- **折叠条件**:段内非 edit 工具数 ≥3,且该段不属于「运行中的最后一轮」(running 时最后一个 user 之后的段不折)。
- 组 key = `group-<段首行 key>`(稳定,支撑展开态与虚拟化 key)。
- `expandedKeys` 含组 key 时输出 `[组头(expanded:true), ...children, ...edit 行]`——children 作为顶层行参与虚拟化,非嵌套 DOM。

## 渲染

- `ToolGroupRow`:chevron + 摘要「N 个工具调用 · 跑了 X 条命令 · 读了 Y 个文件 · 搜索 Z 次」;点击 toggle。
- 展开态 state 放 `MessageTimeline`(per 会话,key 重挂自动清零,满足「会话内存记忆」)。
- toggle 回调经 prop 传入 TimelineRow(memo 比较器忽略函数引用,比较 expanded/count/stats)。

## 摘要归类

按工具名:`bash`→commands;`read`→reads;`grep|find|glob|ls`→searches;其余→others(edit 不计,因为不进组)。
