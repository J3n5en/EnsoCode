# Design: 消息列表虚拟化与滚动跟随

## 选型

**react-virtuoso**。理由:
- 聊天场景专用 API:`followOutput`(贴底自动跟随,支持 'smooth'/'auto' 与函数式条件)、`atBottomStateChange`(贴底态回调,天然实现「上滚解除跟随」)、`atBottomThreshold`(对应 ref-chat-a 的 40px rearm 阈值)、`scrollToIndex`、`initialTopMostItemIndex`(打开会话定位到底部)。
- 动态行高自动测量,无需手工 measure(diff/终端输出高度不可预知)。
- React 19 兼容,纯 web(ref-chat-a 的 @legendapp/list 是 RN 优先,web 端文档弱;@tanstack/react-virtual 需手搭测量与跟随逻辑,等于自己重写 virtuoso)。

## 结构

```
ChatView.tsx
└─ MessageTimeline.tsx (新组件,替换现有 map 渲染的滚动容器)
   ├─ <Virtuoso
   │    data={items}                  // buildTimeline 产物,不变
   │    itemContent={(i,item)=><TimelineRow item={item}/>}  // 现有行组件原样复用
   │    followOutput={follow}         // 三态派生
   │    atBottomStateChange={setAtBottom}
   │    atBottomThreshold={40}
   │    initialTopMostItemIndex={items.length-1}
   │    increaseViewportBy={{top:400,bottom:400}}  // 预渲染缓冲,减少滚动白块
   │  />
   └─ ScrollToBottomButton (浮动,!atBottom 时显示)
```

## 滚动三态映射(对齐 ref-chat-a TimelineScrollMode)

| ref-chat-a | 本实现 |
|---|---|
| following-end | `atBottom && running` → `followOutput='auto'`(流式增量跟随) |
| free-scrolling | `!atBottom` → `followOutput=false`;Virtuoso 自身不会抢滚 |
| anchoring-new-turn | 用户发送时 `scrollToIndex({index: 新 user 消息, align:'start'})`,把新消息顶到视口顶部 |

- 展开/折叠行内内容:Virtuoso 自动重测该行;贴底态下展开导致的高度变化由 followOutput 吸收;非贴底态天然保位(该行上方内容不动)。
- key:沿用 TimelineItem.key(computeItemKey),保证行组件状态(展开态)在数据更新时不丢。

## 风险与对策

- **CSP/样式**:Virtuoso 注入 inline style,Electron renderer CSP 需允许 style inline(现状已允许,tailwind 运行时同源)。
- **hover 条 group 样式**:行外层结构变化不影响(group 在行内部)。
- **测试**:jsdom 无布局,Virtuoso 在 jsdom 下渲染需要 `initialItemCount`;现有测试不直接渲染滚动容器,不受影响;新增逻辑(follow 派生)抽纯函数测。
