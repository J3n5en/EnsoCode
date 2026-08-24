# 弹窗内的下拉被遮住

## 症状

弹窗里放一个 `Select`，点击触发器后**看不到任何选项**。
下拉本身是展开的（DOM 里有节点），只是被弹窗内容盖住了。

## 根因

层级令牌在 `src/renderer/lib/z-index.ts`：

```ts
DROPDOWN: 40,              // SelectPopup 默认用这个
MODAL_BACKDROP: 50,
MODAL_CONTENT: 51,         // 弹窗内容
DROPDOWN_IN_MODAL: 60,     // 专为这种情况准备的
```

`SelectPopup` 通过 Portal 渲染到 body，默认 `zIndex` 是 `DROPDOWN`(40)，
低于 `MODAL_CONTENT`(51)，于是沉到弹窗底下。

令牌体系里本来就有 `DROPDOWN_IN_MODAL`，只是没传。

## 修法

弹窗内的所有浮层显式提升层级：

```tsx
<Select value={api} onValueChange={...}>
  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
  <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
    {MODEL_API_KINDS.map((kind) => (
      <SelectItem key={kind} value={kind}>{kind}</SelectItem>
    ))}
  </SelectPopup>
</Select>
```

嵌套弹窗里用 `DROPDOWN_IN_NESTED_MODAL`(80)。

## 容易漏的地方

同一个弹窗里往往有多个下拉，**每一个都要传**。
`ProviderEditDialog.tsx` 里「API 类型」和「测试模型」两个 Select 都需要 ——
其中「API 类型」的弹层通常正好覆盖在触发器原位，肉眼不容易发现问题，
但性质相同，会在某些定位方向下暴露。

## 规则

- 层级一律用 `Z_INDEX` 令牌，不写数字字面量。
- 新增在弹窗内使用的浮层组件（Popover / Menu / Combobox 等），
  同样要检查它的默认 zIndex 是否够高。
