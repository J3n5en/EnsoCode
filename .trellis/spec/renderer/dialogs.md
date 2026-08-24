# 弹窗规范

## 三件套结构

弹窗内容必须由这三个组件承载，**内边距是它们给的**：

```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="max-w-2xl">
    <DialogHeader>
      <DialogTitle>{t('Edit Provider')}</DialogTitle>
      <DialogDescription>{t('...')}</DialogDescription>
    </DialogHeader>

    <DialogPanel className="space-y-4">
      {/* 正文。自带 ScrollArea，内容超高会滚动 */}
    </DialogPanel>

    <DialogFooter>
      <Button variant="outline" size="sm" onClick={onClose}>{t('Cancel')}</Button>
      <Button size="sm" onClick={handleSave}>{t('Save')}</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

`DialogContent` 里**直接放裸 div 会没有内边距** —— 三件套用 `has()` 选择器互相感知，
根据彼此是否存在调整上下留白。绕过它们，内容就会紧贴边框。

各段职责：

- `DialogHeader` —— `p-6`，只放标题和描述
- `DialogPanel` —— `px-6` + 内置 `ScrollArea`，长内容加 `max-h-[50vh]`
- `DialogFooter` —— `px-6 py-4 border-t bg-muted/50`，按钮靠右；
  左右分置时加 `className="sm:justify-between"`

多阶段弹窗（扫描中 / 选择 / 出错 / 完成）**每个阶段都要各自包一层 `DialogPanel`**，
参照 `LocalAssetImportDialog.tsx`。

## 层级

层级令牌在 `src/renderer/lib/z-index.ts`，不要写数字字面量。

弹窗内的下拉、浮层**必须显式提升层级**，否则会沉到弹窗内容之下：

```tsx
<SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
```

因为 `SelectPopup` 默认用 `Z_INDEX.DROPDOWN`(40)，而 `MODAL_CONTENT` 是 51。
症状是点开下拉看不见选项。嵌套弹窗里的下拉用 `DROPDOWN_IN_NESTED_MODAL`。

## 危险操作要变色

会造成不可逆或外溢影响的操作，整块提示区和主按钮都要转为警示色，
让用户在点下去之前就知道代价。范例是 `InstructionEditDialog.tsx` 的「直接修改原文件」开关：

- 关：琥珀色边框 + `Info` 图标 + 按钮「保存为本地副本」
- 开：`border-destructive/32 bg-destructive/8` + `TriangleAlert` 图标
  + `variant="destructive"` 的按钮「覆盖原文件」

提示文案要写清**具体会发生什么**（哪个文件被覆盖、谁会受影响），不要只写"此操作不可撤销"。

## 异步操作的状态

拉取、测试、保存这类异步动作，用一个 `busy` 状态标记当前动作，
禁用相关按钮并换成 `Loader2` 旋转图标：

```tsx
const [busy, setBusy] = React.useState<'fetch' | 'test' | null>(null);
...
<Button disabled={busy !== null} onClick={handleFetchModels}>
  {busy === 'fetch' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListPlus ... />}
  {busy === 'fetch' ? t('Fetching') : t('Fetch models')}
</Button>
```

结果用一行状态提示，成功绿色 + `CircleCheck`，失败 `text-destructive` + `CircleX`，
文本 `truncate` 防止长错误信息撑破布局。

## 编辑弹窗的表单状态

编辑类弹窗的约定（见 `ProviderEditDialog.tsx`、`InstructionEditDialog.tsx`）：

- props 是 `{ entity: T | null; onClose: () => void }`，`open` 由 `entity !== null` 推导。
- `useEffect` 依赖 `entity`，在里面重置**全部**本地状态，包括错误、忙碌、开关等，
  否则关掉再开会带上一次的残留。
- 保存时才写回 store，取消不留痕。
