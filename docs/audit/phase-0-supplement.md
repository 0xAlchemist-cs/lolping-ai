# lolPing AI · P0 补充验证报告（阶段 0 附录 B）

> **日期**：2026-10-24 · **角色**：技术审计与验证负责人
> **基线**：main @ `7dda4d6`（上游 v0.5.3 快照导入）；本报告与所有实验均未改动 `src/`、`native/` 任何文件
> **实验产物**：`D:\lolping-p0\`（仓库外）：`test.html`（埋点页）、`gesture4.ps1`（手势复刻器）、`sw-lifetimes.md`、`nm.md`（Chrome 官方文档源）、`tree.json`
> **待入库**：本文件按约束应提交至 `audit/phase-0` 分支（当前被 Mimosa 门禁阻塞，见 phase-0-audit.md §8）

---

## 1. 已验证事项与证据

### 1.1 任务 A：Windows/Chrome 选区存留（机制级实验，全部通过）

**方法**。用与 `hook-helper` 同类型的真实 Windows 低级钩子（`WH_MOUSE_LL`=14、`WH_KEYBOARD_LL`=13）逐条复刻 `decision.cpp` 的手势语义：Alt 按下（真实到达应用）→ 按住 Alt 时 LMB down **吞** → 移动穿透 → LMB up **吞**（此刻对应 wheelRelease/问号落地）→ 真实 Alt-up 吞 → 注入 mask 键 `VK_NONAME` + Alt-up 重放（`decision.cpp:358-365` 的防菜单机制）。手势注入用 SendInput（DPI 感知），落点为真实 Chrome 窗口内文本处；页面内埋点捕获全部鼠标/键盘/选区事件。环境：Windows 11，单显示器 2048×1280 @125% DPI（物理像素坐标），Chrome 155（Playwright 驱动的真实浏览器窗口，UA 实录）。

| 场景 | 手势前选区 | 手势后 | 页面收到的事件 | 结论 |
|---|---|---|---|---|
| **S0 对照：无钩子直通拖动** | 段落 217 字符 | 被拖扫**替换**为 34 字符 | 4 mousedown / 3 mouseup / 3 click / 31 selectionchange | 证明「吞键语义」（而非"没有拖动"）才是选区存活的必要条件 |
| **S1 段落文本（吞键）** | 217 字符 | **逐字存活**（217） | **0** mousedown/mouseup/click；仅 mousemove（指针照常移动，符合 `decision.cpp:435-446` 移动不吞） | ✅ |
| **S2 GitHub 风格代码块** | 跨 3 行 117 字符 | **存活** | 0 鼠标事件；键盘面仅 Alt 与 mask 键（Chromium 将 `VK_NONAME` 报为 `Unidentified` 空键，无字符副作用） | ✅ |
| **S3 输入框（焦点+框内选区）** | input 焦点 + 选区 `[8,17]` | 选区 `[8,17]` 原样、焦点仍在 input、value 无污染、无 input 事件 | 0 鼠标事件 | ✅ |
| **S4 真实 GitHub 代码页**（github.com blob 视图，先以真实直通拖动划选模拟用户） | 173 字符代码选区 | **存活**（173，逐字一致） | 0 mousedown/mouseup/click/**0 selectionchange** | ✅ |

**副作用核查**：mask 键机制全程复刻，未观测到 Alt 菜单激活、页面导航或焦点转移；`selectionchange` 计数为 0（S1/S4）证明选区对象本身未被触碰。

**证据边界（如实声明）**：本实验复刻的是钩子**语义**（同类型低级钩子 + 相同判定规则），不是真实 `hook-helper.exe` 端到端（未构建：`node_modules` 未装且本轮禁止安装）。差异面：真实 helper 的独立进程/线程模型、多显示器、其他 DPI、用户手部拖动轨迹的连续 move 流——这些不改变「down/up 被吞则页面无感知」这一机制结论，但**真实 app 冒烟（`npm run dev` + 手动 Alt 拖动）仍列为阶段 1 验收项**。

### 1.2 任务 B：MV3 Service Worker / WebSocket / Native Messaging（官方文档级验证）

来源：Chrome 官方文档站源码仓库（developer.chrome.com，经 gh-proxy 拉取原始 Markdown，本地存档 `sw-lifetimes.md`、`nm.md`）。关键原文：

- 空闲终止："After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer."；单请求硬上限 5 分钟。
- **Chrome 116+**："**Active WebSocket connections now extend extension service worker lifetimes.** Sending or receiving messages across a WebSocket in an extension service worker resets the service worker's idle timer."
- Chrome 120：`chrome.alarms` 最小周期降为 **30s**。
- Chrome 105+：`connectNative` 端口保活 SW；"If the host process crashes or is shut down, the port is closed and the service worker will terminate after timers complete. Guard against this by calling chrome.runtime.connectNative() in the port's onDisconnect event handler."（官方推荐重连模式）
- Native Messaging：**Chrome 按连接启动 host 子进程**（stdio + 32 位长度前缀 JSON，host→Chrome 单消息 ≤1MB）；Windows 需注册表键（HKCU/HKLM）指向 host manifest，`allowed_origins` **不支持通配符**；`connectNative` 保持 host 存活直到端口销毁。

**⚠️ 对 P0 报告的修正**：原报告 §R8 假设「触发时由回环连接唤醒（连接保活期间 worker 不休眠）」**半对半错**——准确模型是：
1. 连接**健在**时（Chrome 116+），活动 WebSocket 阻止 SW 休眠，收发消息重置空闲计时器 → 此时可即时推送；
2. 但 SW 一旦休眠（浏览器重启、5 分钟硬上限、SW 异常终止），**其 socket 已随 SW 终止关闭，桌面应用无法通过 socket 推送唤醒**——唤醒只能来自 SW 侧事件（`onStartup`、`chrome.alarms` ≥30s、任意扩展事件）。

**架构推论**：必须采用**拉模式**——应用侧持久化"待取选区"请求队列；SW 每次醒来（alarm/事件/重连）即拉取并执行。最坏陈旧延迟 ≈ alarm 周期下限 **30s**。UX 需兜底：浮窗在等待期提示"正在唤醒浏览器扩展（最长约 30 秒）"，并始终提供手动粘贴提问。

### 1.3 任务 C：安全与架构复核（代码级，含一处新发现）

1. **挂接点不变**：`src/main/index.ts:329` `overlays.on('shared')` 仍是唯一汇聚点（轮盘 ping 与触发键+点击均 emit，`overlayManager.ts:73/130`）。
2. **预览/远端/倒问号不触发**（结构性保证）：`previewPing`（`overlayManager.ts:141`）只发 `ping:spawn` 无 `shared`；远端 `spawnRemote`（`:147`）同；`missingflip` 是独立 PingId（`pings.ts:27/33`），`id==='missing'` 判断天然排除。
3. **🆕 新发现（阶段 1 决策项）**：`clickPingId` 可被用户设为 `'missing'`（`settings.ts` clickPingId 字段），此时**触发键+点击也会走 `shared`**（`overlayManager.ts:130`）从而触发 AI。建议口径：视为合法触发（同样是刻意的 missing 问号），在设置页文案说明；或提供独立开关。
4. **扩展最小权限**（设计确认）：`permissions: ["scripting", "storage", "alarms"]`；读任意页面选区需 `host_permissions: ["<all_urls>"]`——`activeTab` **不适用**（其授权依赖扩展上下文的用户手势，我们的触发来自桌面侧消息）。这是真实且必须向用户声明的权限成本；缓解：**零常驻 content script**，仅请求瞬间 `executeScript` 读 `getSelection().toString()`；配对 = 一次性 token + Origin 白名单（`chrome-extension://<id>`）。
5. **API Base URL 安全（升级为硬性验收项）**：仅允许 `http:`/`https:`；URL 规范化后校验 host，**默认拒绝 localhost/环回/私有/保留地址**（本地 Hermes 需用户显式选择"本地后端"并明示后方放行，且走同样校验）；**不跟随重定向**（`redirect: 'error'`）；密钥仅存 safeStorage（DPAPI），绝不写入 settings.json、绝不出现在 URL（仅 Authorization 头）、错误提示不回显密钥。
6. **Hermes 与云端不预设差异**：统一抽象为"可配置 OpenAI 兼容 endpoint"；Hermes 同样支持密钥与 TLS，不做"完全离线/免鉴权"假设。
7. **关闭即净**：仿照现有 gate 模式（`index.ts:187` EmoteTransfer `enabled` 闭包、`features.ts` `liveKeys`）：`aiExplain` 关 → 挂接分支不注册、回环 server 不启动、无 alarms、无任何模型请求。

## 2. 未验证事项及原因

| 项 | 原因 | 补救 |
|---|---|---|
| 真实 `hook-helper.exe` 端到端选区实验 | 依赖未安装（`npm ci` + `build:helper` 被本轮约束禁止） | 阶段 1 首周：`npm run dev` 实机 Alt 拖动冒烟（5 场景同表） |
| 扩展实机时序（SW 休眠→alarm 唤醒→重连→拉取延迟实测；浏览器/应用重启恢复） | 属开发期实验；文档级证据已足够定型架构（拉模式） | 阶段 1.5 的 E2 实验：约 80 行测试扩展 + 本地 server，量测断连后唤醒延迟分布 |
| 多显示器 / 其他 DPI / 非 Chromium 浏览器 / Edge | 单机环境限制 | 阶段 1 手动清单项；Edge 为 Chromium 内核预期同行为，Safari/Firefox 出范围 |
| 本仓库 CI 从未运行 | 远程仓库为空（门禁阻塞推送）；本地未装依赖 | 解锁推送后首跑 `.github/workflows/ci.yml` |

## 3. Chrome 通信方案最终建议

| | MV3 + 回环 WebSocket + 心跳/重连（拉模式）【**主选**】 | MV3 + Native Messaging【后续加固选项】 | 无扩展手动提问【始终保留的兜底】 |
|---|---|---|---|
| 保活 | Chrome 116+ 活动 WS 即保活；消息重置空闲计时器 | Chrome 105+ connectNative 端口保活 | — |
| 唤醒 | SW 休眠后靠 alarm(≥30s)/事件自醒重连，**拉取**待处理请求 | 同左（NM 无更优唤醒故事） | — |
| 安装面 | 零系统改动（无注册表、无额外二进制），应用即服务端 | 需 host shim exe + HKCU 注册表键 + 安装器改动 | 无 |
| 安全绑定 | 一次性配对 token + Origin 白名单；任何本机进程可连（token 门槛） | `allowed_origins` 钉死扩展 ID，Chrome 亲自拉起 host——绑定更强 | 无 |
| 消息 | 自由 JSON | 长度前缀 JSON，host→Chrome 1MB 上限（选区场景足够） | — |
| 结论 | **阶段 1.5/2 首选**：实现最薄、迭代最快 | 阶段 2+ 若安全评审要求更强绑定再引入 | 阶段 1 即交付（浮窗手动模式） |

## 4. 修正后风险矩阵

| # | 风险 | 等级变化 | 说明与缓解 |
|---|---|---|---|
| R1 | Alt 拖动丢选区 | **高 → 低-中** | 机制级四场景全部验证存活（§1.1）；残余=真实 app 冒烟 |
| R2 | 回环通道滥用 | 中（不变） | token + Origin 白名单 + 限速 |
| R3 | 密钥泄露 | 中（不变） | §1.3-5 硬性验收项 |
| R4 | 新外网出口可见性 | 中（不变） | 默认关 + README 隐私声明 |
| R5 | 浮窗抢焦点 | 低（不变） | textWindow 先例 |
| R6 | 无扩展时体验断裂 | **中 → 低** | 手动提问为一等公民（阶段 1 即有） |
| R7 | 敏感文本外发 | 中（不变） | 设置页明示去向；Hermes/云同等抽象 |
| R8 | SW 休眠错过请求 | 中-低 → **已定性** | 拉模式 + 30s alarm；UX 等待提示 + 手动兜底（§1.2 修正） |
| **R9** | SW 断连后首次请求延迟至多 ~30s | 新增·低 | 同上 UX 兜底 |
| **R10** | `<all_urls>` 权限的信任/审核成本 | 新增·中 | 零常驻脚本、请求瞬间读取、商店说明如实声明 |
| **R11** | `clickPingId='missing'` 触发口径未定 | 新增·低 | 阶段 1 决策（§1.3-3，建议视为合法触发并文案说明） |

## 5. 需要修改的文档（均已备好/已完成，待门禁解除后入库）

| 文档 | 状态 |
|---|---|
| `README.md` / `README.zh-CN.md`（未提交工作区） | ✅ 已修正：现在时态 → "plans…**not implemented yet**"；并明确「源码快照导入，非 GitHub 原生 Fork」；双语同步 |
| `docs/audit/phase-0-audit.md` | 已在库（待随 audit 分支提交），§8 含门禁诊断 |
| `docs/audit/phase-0-supplement.md`（本文件） | 新增，待入 `audit/phase-0` |
| 建议新增 `docs/plan/`（总计划书、P0 Prompt 归档） | 未入库，建议随 audit 分支补齐（当前仅在会话记录中） |
| `docs/design.md` §16（AI 特性设计） | 阶段 1 编码时随首个 feat commit 撰写 |

## 6. 阶段 1 最小可行开发范围（MVP）

1. **shared 层**：`features.aiExplain`（默认 **false**，`normalizeFeatures` 兜底）+ `settings`（`aiBaseUrl`/`aiModel`，不含 key 本体）+ `i18n` 双语。
2. **aiClient**：OpenAI 兼容 chat completions（流式 + AbortController）；URL 校验按 §1.3-5（scheme/host/环回默认拒/不跟随重定向）；fetch 注入可测。
3. **aiKeyStore**：safeStorage(DPAPI) 加密切片，仅主进程读写。
4. **explainWindow 浮窗**：手动提问模式先可用（模板 `textWindow.ts`，blur 不关闭、Esc 关闭销毁即 abort、`will-navigate` 锁死、`setWindowOpenHandler` 全拒）。
5. **挂接**：`index.ts:329` 内 `p.id==='missing' && featureOn(settings,'aiExplain')`；R11 口径按决策实现。
6. **测试**：误触发回归（预览/远端/missingflip/clickPingId 口径）、URL 校验表驱动、abort 行为、密钥不落盘断言。
（扩展桥/配对/选区拉取 = 阶段 1.5/2，依赖 E2 实机时序实验；手动模式不依赖扩展即可交付价值。）

## 7. 结论：**CONDITIONAL GO**（维持，条件更新）

✅ R1（可行性根基）机制级证实：吞键语义下选区四场景全部存活，Chrome 无副作用。
✅ 通信架构定型：WS 回环拉模式（Chrome 116+ 官方文档背书），手动模式兜底。
⚠️ 进入阶段 1 编码仍需：
1. 三项产品决策：R11 触发口径；`<all_urls>` 权限接受度；本地 Hermes 放行环回的交互文案。
2. 阶段 1 期间完成两件实测（不阻塞开发启动）：真实 app 冒烟（5 场景）、E2 扩展唤醒时序。
3. 仓库侧：门禁解除后完成 main/audit 分支推送（README 修正 + 本报告 + phase-0-audit），CI 首跑。

---

## 8. P0 审阅决议修正记录（v0.2，2026-10-24）

依据仓库所有者的 P0 审阅决议（P0-review-decisions-v0.2），对本报告如下修正，以本节为准：

1. **R11 触发口径（已拍板）**：仅本地轮盘释放选中 `missing` 触发 AI；`clickPingId='missing'` 的触发键+单击**不触发**（原 ping 照旧）；`missingflip`、设置预览、远端成员 ping 不触发。实现方式：新增有来源标识的纯本地事件（如 `wheelPing`），不复用无区分的 `shared` 事件；房间广播语义不变。
2. **Chrome 权限（已拍板）**：P1A 不开发扩展、不默认申请 `<all_urls>`；后续优先研究按需权限与 `activeTab`（其授权依赖扩展侧用户主动调用；桌面侧 Alt+问号手势不构成该授权，但不能据此断言二者绝对必需/绝对不可用，需实测）。
3. **Hermes（已拍板）**：仅对用户明确配置的 `127.0.0.1`/`::1` 精确地址放行 HTTP（需独立验证 localhost 解析），不默认放行整个 RFC1918；Hermes 可能调用云端模型、可能需要凭据；Agent 工具（文件写入/shell/浏览器操作）默认禁用。
4. **alarms 时延表述修正**：最短周期约 30s 但**不保证** 30s 内触发，系统可能延迟更久；本文 §1.2/§4 中「最坏 ~30s」应读作「不设上限的 UX 兜底等待提示」。
5. **CI 表述修正**：远程 `main` @ `d5df46b` 的 CI（Windows/macOS/Linux）已成功运行，本文 §2「本仓库 CI 从未运行」按撰写时点成立、现已过时；`audit/phase-0` 分支尚无工作流运行。
6. **README 措辞**：以「计划增加（not implemented yet）」表述 AI 功能，禁止提前声称已交付（修正已随本报告一并提交至本分支）。
7. **路线**：P1A（默认关闭开关 + 模拟答案浮窗，无扩展/无 API/无 Key/无回环）→ P1B（真实 Provider + Key 加密 + 流式/取消 + endpoint 约束）→ P2（选区与扩展通信实测选型）。实施于独立分支 `feat/p1a-missing-window`。
