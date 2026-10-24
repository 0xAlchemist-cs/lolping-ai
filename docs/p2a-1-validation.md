# P2A-1：Windows 本地截图预览交付记录

验证时间：2026-10-24 至 2026-10-25（Asia/Shanghai）。P2A-1 判定：**PASS，可独立提交**（限已验收的 Windows 配置）。

实现、自动化门禁及真实 Electron 的合成桌面验证已通过。用户随后明确确认真实物理手势、截图、重启及本地隐私边界验收通过；这是用户实机确认，与下文的合成验证分开记录。未连接的显示器配置仍未实机测试。P1B 的 SSE 正常结束、停止、复制、重试继续保留 NOT TESTED，不阻止独立交付 P2A-1。

## 1. 修改摘要

功能涉及新增 9 个文件、修改 11 个文件；另附 1 份 P1B 真实 API 脱敏验收报告，记录文字功能与截图功能的验收边界，共 21 个提交文件。

| 文件 | 状态 | 职责 |
|---|---|---|
| `src/main/visionCapture.ts` | 新增 | Electron 截屏、目标显示器校验、实际像素坐标转换、裁剪、JPEG、体积与超时限制 |
| `src/main/captureWindows.ts` | 新增 | 临时隐藏和保护应用窗口、DWM 调用、捕获前后状态检查、finally 恢复 |
| `src/shared/vision.ts` | 新增 | 截图目标、图片、位置标记、错误码、双语文案类型和 IPC 大小上限 |
| `src/renderer/explain/visionPreview.ts` | 新增 | 独立预览状态、两张图片和标记、会话失效、关闭及卸载释放 |
| `tests/main/visionCapture.test.ts` | 新增 | DPI、负坐标、四角、小屏、实际尺寸差异、失败、内存和超时测试 |
| `tests/main/captureWindows.test.ts` | 新增 | 窗口排除、成功/失败恢复、重入、新窗口及恢复异常隔离测试 |
| `tests/renderer/visionPreview.test.ts` | 新增 | 点击触发、显示、旧结果拒绝、关闭释放及本地隐私路径测试 |
| `tools/vision-smoke.cjs` | 新增 | 可重复的真实 Windows Electron 验证，只输出几何和结果，不保存截图 |
| `docs/p2a-1-validation.md` | 新增 | 本交付记录 |
| `src/main/index.ts` | 修改 | 从 wheelPing 冻结原始显示器及位置，注入独立本地截图依赖 |
| `src/main/explainWindow.ts` | 修改 | 主帧截图 IPC、独立会话、重复请求及旧结果处理、截图期间生命周期保护 |
| `src/preload/explain.ts` | 修改 | 类型导入和本地内联频道，暴露有限的截图和预览关闭接口 |
| `src/shared/ipc.ts` | 修改 | 扩展现有 Explain API 和状态类型 |
| `src/shared/i18n.ts` | 修改 | 新增英文和简体中文预览、隐私、加载和错误文案 |
| `src/renderer/explain/main.ts` | 修改 | 将预览控制器接入原卡片，保留原文字状态 |
| `src/renderer/explain/index.html` | 修改 | 原卡片内预览入口、图片及状态区域；有限图片 CSP 和 connect-src none |
| `src/renderer/explain/explain.css` | 修改 | 预览滚动区域、位置标记和隐藏规则 |
| `tests/main/explainWindow.test.ts` | 修改 | 主帧权限、无 Key、本地路径、旧会话、关闭、失焦、重复点击和文字流回归 |
| `tests/main/preloadBundle.test.ts` | 修改 | 检查全部生产 preload 及独立 VM 沙箱加载、截图频道同步 |
| `docs/design.md` | 修改 | 记录 P2A-1 架构、坐标、生命周期、隐私、限制和验收方法 |

对 P1B 的影响：保留原来的文字请求、流式事件、停止、复制、重试、Esc 和设置入口。视觉会话独立于文字流。截图不进入 AI 请求。Windows 之外保留原有卡片位置行为，不提供本阶段截图入口。没有修改 OverlayManager、轮盘实现、输入桥、原生 Hook、房间协议、AI 客户端、密钥存储或设置 schema。

## 2. 实际功能流程

物理事件的既有路径保持为：Hook → InputBridge → OverlayManager → wheel:release → renderer 的 Wheel.release() → reportPing() → wheelPing → index → 原 Explain 卡片。

已核实 `Wheel.release()` 返回原轮盘中心，而不是鼠标释放终点。Windows 的 index 保存 SharedPing 的 displayId、局部 DIP x/y，以及显示器 bounds 和 scaleFactor；不重新读取鼠标位置作为截图中心。

问号释放 → 保存位置和视觉会话 → 用户点击本地截图预览 → 暂时隐藏/保护自身窗口并检查状态 → 读取目标 display_id 的图片 → 按实际图片宽高映射原始点 → 裁剪 → finally 恢复窗口 → 通过所属主帧 IPC 展示局部图和整屏预览。

换算公式为 `floor(localDipX * actualImageWidth / displayDipWidth)`，Y 同理，随后限制到有效像素范围。局部裁剪最多 640 × 480 物理像素，四边向内限制；小屏自动缩小。标记使用原始像素中心的归一化位置。完整预览保留该屏全部内容及宽高比，最多 1920 × 1080。

普通点击、clickPingId、设置预览、远程 Ping、表情、取消、未选中轮盘及 AI 功能关闭均没有新增截图触发。仅打开卡片也不截图。无 API Key 时可本地预览。

## 3. 截图验证

| 场景 | 预期 | 实际 | 状态 |
|---|---|---|---|
| 单显示器 | 对应屏幕的局部和完整截图 | 真实 Windows Electron：2560 × 1600；局部 640 × 480，整体预览 1728 × 1080；用户另行确认物理手势与截图通过 | PASS，自动化与用户确认分别记录 |
| 125% DPI | 原始位置准确 | 2560 × 1440 坐标单测通过；本机 2560 × 1600、scaleFactor 1.25 合成桌面验证通过 | PASS，具体几何数据来自合成验证 |
| 150% DPI | 4K 坐标准确 | 3840 × 2160、scaleFactor 1.5 单测通过；本机没有对应显示器配置 | 单测 PASS；实机 MANUAL PENDING |
| 双显示器 | 精确选择目标 ID | 混合 DPI、来源顺序变化、拒绝错误 ID 和主屏回退单测通过 | 单测 PASS；实机 MANUAL PENDING |
| 负坐标副屏 | 左侧/上方副屏裁剪正常 | 负 X、负 Y 及两轴同时负值单测通过 | 单测 PASS；实机 MANUAL PENDING |
| 屏幕边缘 | 四角及越界点不产生越界裁剪 | 四角、超范围点、小于 640 × 480 的显示器及实际缩略图尺寸不同均通过 | 单测 PASS；四角实机 MANUAL PENDING |
| 关闭预览 | 无旧图片残留 | renderer 单测、真实生产卡片及实际应用均确认移除两张图片的 src；新会话拒绝旧结果 | PASS |
| 网络隔离 | 本地路径不上传 | 真实截图作用域 externalRequests、fetchCalls、clipboardWrites、fileWrites 均为 0；未调用文字 ask 或配置依赖 | PASS，仅针对截图路径 |
| preload | 无共享 chunk，桥正常注册 | 5 个独立生产文件；每个在受限 VM 加载；真实沙箱 window.overlay 和 window.explainApi 正常 | PASS |

本机实机证据来自普通 Windows 桌面，没有启动英雄联盟或改变安全/反作弊设置。鼠标由合成验证移动后恢复，仍定位到原始 Ping。已使用已知绿色目标及覆盖其上的应用自身品红窗口验证排除效果，成功与失败路径都恢复窗口。

## 4. 回归验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 最终源码 PASS，退出码 0 |
| `npm run build` | 最终生产构建 PASS，退出码 0 |
| `npx vitest run` | 75 个文件、1170 项测试全部通过，退出码 0 |
| `npm run test:helper` | 使用进程环境 `CL=/utf-8 /Zc:preprocessor` 后，542 passed、0 failed；未修改原生源码 |
| `node tools/vision-smoke.cjs` | 最终生产产物真实 Electron PASS，退出码 0；实际 JPEG 解码、尺寸、标记、合成轮盘与 Ping 动画、窗口排除和失败恢复、图片释放、旧会话拒绝、文字流、停止、Esc 均通过 |
| 实际 `npm run dev` | 两次启动及重启 PASS；两次原生 helper 均为 running；实际 index → Explain 路径、无 Key 预览、图片释放正常 |
| 旧文字 AI | 完整单测通过；真实 renderer 使用注入回答验证流式和停止，复制按钮可用；这些是 Mock 回归。真实 API 结果另见 P1B 报告，四项细分操作仍为 NOT TESTED |
| 截图隐私 | 最终真实冒烟：截图 1 次，externalRequests 0、fetchCalls 0、clipboardWrites 0、fileWrites 0 |

上述两次自动化应用启动使用隔离的 `out/dev-acceptance` appData、userData、sessionData 和设置，重启保留该测试配置；这两次主进程触发使用合成 reportPing，相应测试进程在该阶段结束时均已退出。用户随后在普通应用中完成物理手势、截图及重启验收，未以合成触发代替物理操作证据。

环境问题及解决：沙箱内 Vite/Vitest 的 Windows realpath 产生 EPERM，已在获准的沙箱外运行并通过；首次原生测试受到已有 CP936 代码页问题影响，添加上述编译环境参数后通过。新安装的 Electron 包缺少运行时，已只读复制本机 baseline 的相同 Electron 44.5.1 发行运行时到 P2A 的 node_modules，并核对 electron.exe SHA256 一致，没有复制 P1B 项目源码或 Hook 改动。

## 5. 已知限制与剩余人工验收

- Electron getSources 没有按显示器 ID 过滤请求的参数，会在主进程内短暂生成所有屏的缩略图。仅目标屏被裁剪、编码和传给卡片，其他屏不传出、不保存；因此没有声称底层只生成一屏像素。严格要求连其他屏的瞬时缩略图也不生成时，当前 API 路径仍存在此限制。[Electron 文档](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- DwmFlush 子进程不是 Electron 绘制的通用同步屏障；隐藏状态、临时内容保护、捕获前后检查和本机颜色目标实证构成当前可验证方案。尚未证明所有 Windows 合成器、远程桌面及全屏程序的排除效果。[Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmflush)
- 受保护内容、DRM 或特定全屏窗口可能呈黑色；不能把非空黑图自动判定为成功读取了受保护内容。系统策略禁用 PowerShell/DWM 调用时会返回错误并恢复窗口，不修改安全设置。
- 截图取得的是点击预览时的桌面内容，中心固定在原始问号位置，不保留打出问号瞬间的历史画面。
- 总缩略图上限为 32 Mi 像素，单边不超过 8192；两张 data URL 合计不超过 8 Mi 字符。超限明确报错；整屏预览经过本地缩小和 JPEG 压缩。
- 截屏 API 有 10 秒期限。超时恢复窗口，但无法取消 Electron 的底层请求；底层尚未结束时后续捕获返回 busy，永久不返回时需重启应用。文字及信号路径不依赖该请求。
- 应用不写截图文件、日志、设置、诊断、剪贴板或网络；内存引用及 img 源会释放。操作系统内存转储及 Chromium 内部的内存回收不在应用可保证范围内。

用户已确认真实物理手势、截图、重启及本地隐私边界验收通过。真实文字回答已另行确认，详见 P1B 报告；SSE 正常结束、停止、复制、重试仍为 NOT TESTED。100%/150%、混合 DPI 双屏、负坐标副屏和四角的对应硬件验收仍为 NOT TESTED，单测通过不代表这些硬件配置已实机通过。这些范围限制随 P2A-1 交付保留。

## 6. 收尾前 Git 快照

分支：`feat/p2a-vision-capture`。

收尾审查基线：`8372815b49d72b8cf12baf28b8908a4de409587e`。

以下是提交前快照，不代表后续提交、推送或合并状态。工作区有 20 个功能相关变动及 1 份补充 P1B 脱敏报告。没有修改 main、旧工作区源码、原生源码、package.json、package-lock.json、electron.vite.config.ts、AI 客户端或安全存储。提交与 PR 状态以 Git 记录为准；本任务不发布安装包。

```text
 M docs/design.md
 M src/main/explainWindow.ts
 M src/main/index.ts
 M src/preload/explain.ts
 M src/renderer/explain/explain.css
 M src/renderer/explain/index.html
 M src/renderer/explain/main.ts
 M src/shared/i18n.ts
 M src/shared/ipc.ts
 M tests/main/explainWindow.test.ts
 M tests/main/preloadBundle.test.ts
?? docs/p2a-1-validation.md
?? docs/p1b-real-api-validation-2026-10-25.md
?? src/main/captureWindows.ts
?? src/main/visionCapture.ts
?? src/renderer/explain/visionPreview.ts
?? src/shared/vision.ts
?? tests/main/captureWindows.test.ts
?? tests/main/visionCapture.test.ts
?? tests/renderer/visionPreview.test.ts
?? tools/vision-smoke.cjs
```
