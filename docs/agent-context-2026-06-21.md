# 2026-06-21 桌宠阶段记录

从原 AGENTS.md 移出的历史状态和路线。内容尚未按当前源码重新验收，不是新任务的自动实施要求。只在相关记忆、模型或漫游任务需要背景时读取；当前任务以根 AGENTS.md 和用户要求为准。

## 当前技术事实

- 后端：Python、FastAPI、WebSocket、OpenAI 兼容 API、ChromaDB、SQLite。
- 前端：React 18、Vite 6、PixiJS 6、pixi-live2d-display、Electron 28。
- 当前模型：`frontend/public/models/PinkFox/PinkFox.model3.json`。
- Electron 窗口：300x420、透明、无边框、置顶、可手动拖动、托盘切换点击穿透。
- 登录用户通过 `user_id` 隔离账号、人格和记忆。
- 工作区可能有大量用户未提交改动；不要回滚、覆盖或格式化无关文件。

## 已有能力，不要重复造

### 长期记忆

- `backend/memory.py` 已有 `MemorySystem`。
- 事实：每用户 JSON 文件，临时文件 + `os.replace` 原子写入。
- 经历：每用户独立 Chroma collection，语义检索相关记忆。
- Prompt：所有事实 + 最多 3 条相关经历 + 小概率旧记忆。
- 模型输出 `memory_operation`，由 `execute_updates()` 校验基础类型后写入。
- 已有记忆完整性、隐私和存储路径测试。

### 动作

- `useIdleAnimations.js` 已有眨眼、呼吸、环顾和伸懒腰参数动画。
- `Live2DModel.jsx` 已有窗口内“伪走动”实现，但没有调用入口。
- PinkFox 当前没有在 `model3.json` 注册 Motion；`kuku.motion3.json` 存在但未挂载。
- 当前伪走动只改变 Pixi canvas 中模型的 `x`，不会移动 Electron 窗口。

## 核心判断

### “长期记忆”不是继续增加记忆数量

下一阶段重点是：

- 数据目录在应用升级后仍可靠。
- 相关记忆才召回，避免无关 Top-K 污染回复。
- 去重、冲突更新、编辑、遗忘、导出和删除。
- Prompt 有 token 预算。
- 写入经过确定性验证，不让模型随意污染事实库。

详细方案见 `docs/LONG_TERM_MEMORY_ARCHITECTURE.md`。

### “桌面走动”必须移动 BrowserWindow

Renderer 中移动 Live2D 模型只是在 300px 窗口里晃动。真正跨桌面走动必须由 Electron main process 使用 `BrowserWindow.setPosition/setBounds`，并通过受限 IPC 与 Renderer 同步动作状态。

详细方案见 `docs/DESKTOP_ROAMING_AND_ANIMATION.md`。

## 已知测试约束

`frontend/src/desktopSurface.test.js` 当前明确禁止主界面出现 `setWander` 和“走动”。这是之前为了拒绝虚假按钮玩法建立的产品契约。

实现真正 Electron 桌面漫游时，必须在同一次改动中更新该测试：删除“禁止真实走动”的旧断言，替换为 main-process IPC、安全边界和屏幕范围测试。不要只删测试。

## 最小迭代顺序

1. 动作清单和参数诊断：确认 PinkFox 实际支持的参数、表情和 Motion。
2. 注册现有 Motion，建立 `idle/walk/talk/think` 动作映射。
3. Electron 当前显示器内横向漫游，托盘开关，默认关闭。
4. 漫游与说话、思考、控制面板、拖动互斥。
5. 记忆数据目录迁移到持久用户目录。
6. 召回阈值、去重和 token 预算。
7. 编辑/忘记/导出/删除记忆。
8. 会话总结和长期记忆合并。

一次只完成一个可运行闭环。
