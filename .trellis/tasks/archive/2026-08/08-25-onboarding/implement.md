# Implement: onboarding

## 执行清单

### 1. 状态
- [x] settings types + store：`onboarded: boolean`（默认 false）、`setOnboarded`
- [x] 老用户不打扰：初始判定「已有 provider/skill/mcp/指令任一 → 视为 onboarded」
- 验证：typecheck

### 2. Onboarding 组件
- [x] `components/onboarding/Onboarding.tsx`：
  - 步骤：welcome → provider → skill → mcp → instruction → done
  - 覆盖层（z 45）+ 卡片：标题、说明、进度（N/6）
  - 每导入步：「扫描并导入」按钮打开对应现有 Dialog（受控），已导入数量提示
  - 导航：上一步 / 下一步 / 跳过（= 下一步）/ 右上角 ×（关闭并 setOnboarded）
  - done 步「完成」→ setOnboarded(true)
- [x] i18n 文案
- 验证：typecheck + lint

### 3. 挂载
- [x] App.tsx：`{!onboarded && <Onboarding />}`
- 验证：typecheck + lint + test

### 4. 真机验证（CDP）
- [x] 临时置 onboarded=false（localStorage/settings）重载 → 自动弹
- [x] 走一步导入 provider → 设置里出现
- [x] × 关闭 → 重载不再弹；重新置 false → 完成流程 → 不再弹
- [x] 老用户模拟（有 provider 无 onboarded 字段）→ 不弹
- [x] 清理测试状态

### 5. 收尾
- [x] 全量校验；小步提交；恢复用户真实设置
