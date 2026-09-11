# Neuro 项目协作规则

按当前任务读取 README.md 和相关模块。记忆任务参考 [记忆架构](docs/LONG_TERM_MEMORY_ARCHITECTURE.md)，桌面动作任务参考 [漫游与动画](docs/DESKTOP_ROAMING_AND_ANIMATION.md)；不要求每次通读所有文档。

[2026-06-21 阶段记录](docs/agent-context-2026-06-21.md)保留旧模型、能力清单、测试状态与迭代路线，仅作历史背景。当前版本、文件入口和已完成状态须按本次相关源码核实。

## 不可违反的边界

1. 不读取、打印、提交 `.env` 或 API Key。
2. 私密记忆内容不得写入日志、测试快照或错误遥测。
3. 保持 Electron `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
4. Renderer 不能直接获得完整 `ipcRenderer`；只由 `preload.cjs` 暴露白名单 API。
5. BrowserWindow 位置只能由 main process 修改。
6. 漫游第一版只在当前显示器 `workArea` 内横向移动，不做桌面图标/其他窗口碰撞。
7. 不把模型输出的任意字符串直接当作 IPC、文件路径或动作命令执行。
8. 复用现有 `MemorySystem`，只完成当前授权的改动，不因历史路线图自行实施下一阶段。
9. 未明确要求时，不新增养成数值、喂食、金币或虚假“桌宠玩法”。

## 验证与交付

- 选择覆盖当前修改和真实影响的测试；已有测试足够时复用，不新增固定 QA 流程。
- 后端相关检查可用 `python -X utf8 -m unittest discover -v`；前端相关检查可用 `npm test` 和 `npm run build`。按项目目录执行，实际命令以当前项目脚本为准；文字改动只检查差异和引用。
- 真正涉及 Electron 漫游时，验证工作区边界、拖动/输入/说话/控制坞互斥、关闭后的稳定位置、点击穿透与退出，以及相关多屏/缩放/断屏行为。
- 不删除或放宽安全、身份隔离或真实行为测试来通过验收；原“禁止走动”的旧测试只在对应业务实现和正确替代断言一起变更时调整。
- 报告修改文件、用户可见行为、实际自动/人工验证和仍未完成的边界；不把原型描述为完整产品。
