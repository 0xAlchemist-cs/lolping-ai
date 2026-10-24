# lolPing AI 解释功能 · 阶段 0 架构审计报告

> **仓库**：`0xAlchemist-cs/lolping-ai`（自 `darrenprx/lolPing` v0.5.3 导入的派生仓库，MIT）
> **基线**：上游 `main` @ `efa3fe631863a9f89c924110b50c3766234dd0b9`，由 `lolPing-main.zip` 快照导入（commit `chore: import upstream lolPing v0.5.3`）
> **审计日期**：2026-10-24 · **角色**：首席架构师与代码审计负责人
> **范围**：仅分析设计。未修改项目源码、未安装依赖、未运行测试套件、AI 功能未开发。
> **产品目标**：保留 lolPing 原有信号轮盘、问号动画与声音，为本地 `missing`（敌人消失）信号增加**可关闭的** AI 解释功能。最终体验：Chrome 选中文本 → 原版 Alt 拖动打问号 → AI 解释选中内容 → 豆包式可交互桌面浮窗显示答案；无选区时支持手动提问。

---

## 1. 仓库基线与审计摘要

| 项 | 值 |
|---|---|
| 审计对象 | lolPing v0.5.3 源码快照（导入于本仓库 main 首个 commit） |
| 版本定位 | `package.json` v0.5.3；版本号改动权归维护者（`AGENTS.md:47`） |
| 技术栈 | Electron 44 + electron-vite + TypeScript 严格模式；overlay/panel/text 渲染页为无框架 DOM，settings 页为 React 19 + Fluent UI v9；C++ 原生辅助进程 `hook-helper`（Win 低级钩子 / mac 事件 tap / Linux X11），JSON-lines 协议通信 |
| 审计环境 | Windows 11，Node v22.15.0（满足 `engines >=22.12.0`） |
| 测试状态 | **`npm run typecheck` / `npm test` / `npm run test:helper` 均未运行**——`node_modules` 未安装且阶段 0 禁止安装。按 `AGENTS.md:89` 不宣称任何测试通过 |
| 权威文档 | `AGENTS.md`（仓库宪法；`CLAUDE.md` 仅引用它）、`docs/design.md`（436 行设计规格） |

**审计摘要**：架构分层极清晰——`src/shared`（纯逻辑，禁止 Electron/Node 导入）、`src/main`（每特性一模块 + 配套纯逻辑模块）、`src/preload`（每窗口最小桥）、`src/renderer`（每窗口一页）。新功能落位有明确惯例（`AGENTS.md:37`），且已有四条窗口模板（overlay 透传 / settings / text 聚焦输入 / panel 不抢焦点）可复用。为 AI 浮窗新增一条窗口链路完全符合现有模式，**不需要动任何 C++ 代码**。仓库六条保证（`AGENTS.md:11-20`）中与本功能直接相关的是 #1（输入透传）、#4（旧设置兼容）、#5（网络使用必须显性声明）。

---

## 2. `missing` 信号事件时序与推荐挂接点

### 2.1 完整事件链（本地 Alt 拖动 → 问号落地）

```
① C++ decision.cpp 状态机（Idle→Pending→Wheel）
   Alt按住+左键按下  → 吞掉 mousedown，进 Pending     decision.cpp:397-411
   移动>阈值          → 发 wheelOpen{按下点}+wheelMove  decision.cpp:435-446（移动不吞，指针照常动）
   左键松开(轮盘态)   → 吞掉 mouseup，发 wheelRelease{松开点}  decision.cpp:429-431
        │  stdout JSON lines（物理像素坐标）
② InputBridge 解析（parseHelperLine, shared/protocol.ts:31-65）→ emit 'event'
        │  src/main/index.ts:539-551 bridge.on('event') → overlays.handle(ev)（index.ts:550）
③ OverlayManager.handle：物理像素→DIP→该屏 overlay 本地 CSS 像素，路由到按压点所在屏
        │  overlayManager.ts:96-116
④ overlay 渲染器：wheel:release → 选扇区 → 本地播放原版动画+音效 → reportPing
        │  src/renderer/overlay/main.ts:100-111（ping 落地在 107-108，reportPing 在 109）
        │  preload/overlay.ts:17-19 → ipcRenderer.send('overlay:pinged')
⑤ OverlayManager OVERLAY_PINGED 处理器：校验 id/x/y → emit('shared', {id, displayId, x, y})
        │  overlayManager.ts:68-75
⑥ index.ts:329-332 overlays.on('shared') → toShared() → room.sendPing()（房间广播，独立于 AI）
```

旁路确认（AI 不得误触发的路径）：

- **触发键+点击**（clickPing 开启时）：helper 发 `click` 事件，main 直接 spawn 并 emit `shared`（`overlayManager.ts:117-131`）——不经渲染器；
- **设置页预览**：`previewPing` 只发 `ping:spawn`，**从不 emit `shared`**（`overlayManager.ts:141-144`，入口在 `index.ts:612`）；
- **远端成员的问号**：`room.on('remotePing') → spawnRemote`（`index.ts:328`、`overlayManager.ts:147-149`），只发 `ping:spawn` 带 `tag`，**不产生 `shared`**；
- `missing` 与倒问号 `missingflip` 是两个独立 PingId（`shared/pings.ts:2-3,27,33`），默认轮盘含 `missing`（W 位，`pings.ts:37`）。

### 2.2 推荐挂接点

**`src/main/index.ts:329` 的 `overlays.on('shared', ...)` 处**，在现有房间广播旁加一个订阅：`p.id === 'missing' && featureOn(settings, 'aiExplain')` 时触发 AI 流程。

理由：

1. 它是**本地用户主动完成问号的唯一汇聚点**（轮盘和触发键+点击两条路都到这），且天然排除预览与远端；
2. 位于主进程，拿得到 `displayId + overlay 本地坐标`（可换算屏幕点）、settings、窗口管理器——开浮窗所需的上下文齐全；
3. 与 `room.sendPing` 完全并行，**房间广播行为零改动**（远端成员照旧只看到原版问号，AI 解释纯本地）；
4. 渲染器、preload、C++ 全部不动，满足全部硬性限制。

补充决策点（留给阶段 1 拍板）：`missingflip`（倒问号）是否也触发；触发键+点击把 clickPingId 设为 missing 的场景是否触发。建议首版只认 `missing`。

---

## 3. 三条 AI 接入路线对比

选区获取与模型后端是两个正交的轴。

### 轴一：选区获取

| | A. 自建 Chrome 配套扩展 | B. 复用现有 AI 插件快捷键 | C. 系统级读取（UIA / 模拟 Ctrl+C） |
|---|---|---|---|
| 原理 | MV3 扩展在活动标签页执行 `getSelection().toString()`，经本机回环通道（127.0.0.1 WebSocket，仿 `lanTransport.ts` 只绑回环）或 Native Messaging 送给主进程 | lolPing 只模拟第三方插件的热键 | C1：UI Automation TextPattern 直读；C2：模拟 Ctrl+C 暂读剪贴板再还原 |
| 精度 | **精确**，含跨 iframe（allFrames）；不碰剪贴板 | 拿不到选区内容，结果在第三方弹窗里 | C1 尚可但**未验证**（Chrome 无障碍树冷启动时可能拿不到）；C2 有剪贴板竞态、受保护页面失效 |
| 是否违反硬性限制 | 否（仅在打问号那一刻读一次选区） | 是（假设第三方插件可被外部控制；注入热键） | C2 与"不自动抓取剪贴板"冲突，**排除** |
| 用户成本 | 一次性安装扩展 + 配对 | 最低（但路线不成立） | 零安装 |
| 工程成本 | 中：新增 `extension/` + 回环服务（纯 TS 可测） | 低但不成立 | C1 高：Node 无 UIA 绑定，走 C++ 即违反禁改令 |
| 结论 | **推荐主路线** | **NO-GO**（可作文档说明：用户自行配插件热键） | C1 列为实验分支；C2 排除 |

### 轴二：解释后端

| | 云端模型 API | 本地 Hermes Agent |
|---|---|---|
| 质量/速度 | 强模型；依赖外网 | 隐私最优；取决于本机部署 |
| 密钥/安全 | 需存储 API Key（safeStorage/DPAPI，绝不进明文 settings.json）；新增外网出口触发仓库保证 #5 | 无密钥；仅回环 HTTP 调用，须校验目标 host 与 http/https scheme |
| 架构建议 | 设置做成**可配置 endpoint（Base URL + 模型名 + Key，OpenAI 兼容格式）**，一份代码同时覆盖云端与本地 Hermes | 同左 |

**综合推荐**：路线 A（扩展取选区）+ OpenAI 兼容可配置后端 + 无选区时浮窗手动提问。C1/UIA 作为后续可选增强。

---

## 4. 最小文件级改造设计（阶段 1 蓝图）

设计原则：全部走既有模式（`AGENTS.md:37`），C++ `native/` 零改动，`overlayManager.ts` 零改动，房间协议零改动。

**新增文件**

| 文件 | 职责 | 参照模板 |
|---|---|---|
| `src/shared/explain.ts` | IPC 通道名、消息类型、`parseExplainQuery()` 校验、提示词构造纯函数 | `shared/ipc.ts` |
| `src/main/aiClient.ts` | 后端客户端：fetch + AbortController、SSE 流解析；fetch/now 注入可测 | `updater.ts` backend 风格 |
| `src/main/aiKeyStore.ts` | `safeStorage`（DPAPI）加密切片存 `userData/ai-key.bin`；**不进明文 settings.json**（现全仓无 safeStorage 使用，属新增） | — |
| `src/main/explainWindow.ts` | 浮窗：focusable、alwaysOnTop('screen-saver')、**blur 不关闭**（可连续追问）、Esc 关闭、`will-navigate` 锁死、`setWindowOpenHandler` 全拒、位置取 `screen.getCursorScreenPoint()`（`index.ts:387` 先例） | `textWindow.ts:52-118` + `panelWindows.ts` |
| `src/main/explainSelection.ts` | 回环 WebSocket 服务：只绑 127.0.0.1、固定端口（如 47475，紧邻 LAN 47474）、Origin 白名单 `chrome-extension://<id>`、一次性配对 token | `lanTransport.ts` + `floodGuard.ts` |
| `src/preload/explain.ts` | 最小桥：on(answer-chunk)/ask(text)/close() | `preload/text.ts` |
| `src/renderer/explain/`（index.html+main.ts+css） | 对话式浮窗页，无框架 DOM | `renderer/panel/` |
| `extension/`（顶层） | MV3 manifest + service worker：监听回环通道，触发时在活动标签取选区回传 | — |
| `tests/shared/explain.test.ts`、`tests/main/aiClient.test.ts` | 校验、流解析、abort、错误文本；fixtures 假 fetch | `AGENTS.md:63` |

**修改文件（均为小改）**

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | `:329` 旁新增 3-5 行挂接；`before-quit`（:670-682）追加关窗/中止请求/关回环 |
| `src/shared/features.ts` | `FeatureId` 加 `'aiExplain'`（:3）、`FEATURES`（:7）、`DEFAULT_FEATURES` **默认 false**（:15） |
| `src/shared/settings.ts` | `Settings`（:30）加 `aiBaseUrl/aiModel/aiPairToken` 等（不含 Key 本体）；`DEFAULT_SETTINGS` 与 `normalizeSettings`（:290）给默认值 |
| `src/shared/i18n.ts` | 浮窗与设置节英/中双语字符串 |
| `src/shared/ipc.ts` / `preload/settings.ts` / `main/settingsIpc.ts` | SettingsApi 加 `setAiKey/getAiStatus/dismissAiKey` 等 |
| `src/renderer/settings/` | FeaturesSection 卡片 + 新「AI 解释」节 |
| `electron.vite.config.ts` | preload input（:18）与 renderer input（:29-34）各加 `explain` |

**关键不变式**：轮盘 UI/动画/音效零改动；房间广播原样；预览与远端 ping 因挂接点选择天然不触发；无新增全局热键、无输入吞改；不做整页抓取/剪贴板/屏幕读取。

---

## 5. 安全风险与验证实验

### 风险矩阵

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | **Alt 拖动丢选区** → AI 拿不到文本 | 高（可行性根基） | 代码证据显示**不会丢**：mousedown/mouseup 均被吞（`decision.cpp:403,421`），Chrome 从未收到该次按键；Alt 菜单激活被 mask 键屏蔽（:358-365）。**未经实机验证**，见 E1 |
| R2 | 回环通道被本机其他进程/网页滥用 | 中 | 只绑 127.0.0.1 + Origin 白名单 + 配对 token + 限速（floodGuard 模式） |
| R3 | API Key 泄露 | 中 | safeStorage/DPAPI 加密落盘；渲染层永不见 Key；请求只在主进程发 |
| R4 | 新增外网出口违反"网络使用显性" | 中 | 功能默认关；README 双语隐私说明 + PR 声明新 host（保证 #5） |
| R5 | 浮窗抢焦点干扰游戏/应用 | 低 | 沿用 textWindow 先例（`docs/design.md:417` 的例外论证）；Esc 关闭 |
| R6 | 扩展安装门槛导致功能"看起来坏了" | 中 | 无扩展/无选区时浮窗直接进手动提问模式 |
| R7 | 用户把敏感文本发给云端模型 | 中 | 设置页明示数据去向；默认关；本地 Hermes 一等公民 |
| R8 | MV3 service worker 休眠错过取选区 | 低-中 | 触发时由回环连接唤醒；**未验证**，见 E2 |

### Windows/Chrome 验证实验（阶段 1 前置，全部未执行）

- **E1 选区存留**：Chrome 选中文字 → Alt 拖动打问号 → 高亮仍在，Ctrl+C 仍复制出原选区。
- **E2 回环连通与 worker 唤醒**：30 行临时 MV3 测试扩展连 `ws://127.0.0.1:47475`，验证 host_permissions、保活与休眠唤醒。
- **E3 UIA 探针**（可选，路线 C1 立项依据）：PowerShell 读 Chrome 前台窗口 TextPattern GetSelection，冷/热无障碍树两种状态。
- **E4 safeStorage 往返**：临时 Electron 脚本验证 DPAPI 加密存取。
- **E6 误触发回归**（可单测化）：预览、远端 `missing`、`missingflip` 均不产生 AI 调用。

---

## 6. 阶段 1 分步开发建议与验收清单

**建议步序**（每步一个 Conventional Commit，`AGENTS.md:66-79`）：

1. `feat(explain): settings schema and feature switch` — shared 层 + 测试
2. `feat(explain): ai client with streaming and abort` — aiClient.ts + aiKeyStore.ts + 测试
3. `feat(explain): explain window` — 浮窗页面，手动提问模式先可用
4. `feat(explain): trigger on the missing ping` — index.ts:329 挂接 + 误触发回归测试
5. `feat(explain): selection bridge extension` — 回环服务 + extension/ + 设置页配对
6. `docs(explain): design.md §16 + 双语 README 隐私说明 + PR 声明新 host`

**验收清单**：

- [ ] E1、E2、E4 实验通过并记录在 PR
- [ ] Alt 拖动落 missing：原动画/音效/房间广播逐项与改动前一致（`npm run dev` 实机，Windows）
- [ ] 预览 missing、远端成员 missing、missingflip 均不触发 AI（自动化测试覆盖）
- [ ] 无选区/无扩展/无 Key/断网 → 各自降级到手动提问或明确提示，绝不静默失败
- [ ] Esc 关窗与切换问题时进行中请求被中止（断言 AbortController）
- [ ] Key 不出现在 settings.json 与任何渲染进程内存之外
- [ ] `npm run typecheck && npm test && npm run test:helper` 全绿（阶段 0 未运行，不背书现状）
- [ ] 关闭 aiExplain 特性后：无回环监听、无任何外发请求、挂接代码零副作用

---

## 7. 结论：**CONDITIONAL GO**

✅ 支持项——挂接点（`index.ts:329` 的 `shared` 事件）结构上完美区分"本地刻意发问 / 预览 / 远端"；浮窗、设置、特性开关、存储、测试全部有成熟模板；C++ 与输入行为零触碰。

⚠️ 放行阶段 1 编码的前置条件：

1. **E1 实机通过**（选区存留是可行性根基，当前仅代码级推证）；
2. **E2 实机通过**（扩展-回环通道成立；失败则转 Native Messaging 或先以"纯手动提问"形态上线）；
3. 确认默认关闭 + README 隐私声明的产品决策，以及首版只认 `missing` 的触发口径。

---

## 8. 附：仓库导入时的 Mimosa 门禁诊断（2026-10-24）

向上游代码做首次后续提交时，ZCode 侧 Mimosa L3 门禁持续拦截 `git commit`，报文为固定三条：`index.ts:96 [high] serveAppScheme 是 ssrf 入口`、`[medium] 疑似跨文件污点`、`emote_bake.py:729 [low] 不安全的随机数`。完整诊断结论（全部证据来自 Mimosa 官方产物与命令输出）：

**① 门禁消息与官方状态自相矛盾（缓存回放）**。三次拦截报文逐字节相同；期间对 `appProtocol.ts` 的真实加固使封印扫描中的污点锚点从 `:54` 移到 `:62`，报文却不变。同期官方产物全绿：

| 官方产物 | 结果 |
|---|---|
| 封印扫描 scan-…02-21-40（加固前） | `high:0, medium:1(advisory), low:1` |
| 封印扫描 scan-…02-24-34（加固后） | `high:0, medium:1(advisory), low:1` |
| Stop 钩子增量复审（hook_observed_diff，修订 7dda4d6） | `finding_count:0, denyCount:0` |
| 跨会话 finding 账本（`mimosa status`） | `open=0, blocked=0, latest=clear` |

`[high]` 等级只存在于门禁报文中，两次封印扫描均无 high。medium 条目自带 `advisory:true` 与 proofGap「静态 advisory 需要人工确认真实数据流和可利用性」——本节即该人工确认。

**② SSRF 独立复核（对 high/medium，结论：高置信度误报）**。

- *请求方枚举*：`lolping://` 为本应用特权 scheme，仅本进程四个渲染页可发。全仓唯一 `loadURL`（`src/main/paths.ts:39-41`）只加载 dev `localhost`（Vite）或 `lolping://app/<page>/index.html`，任何窗口从不加载远程内容，渲染进程默认 contextIsolation+sandbox，preload 只暴露最小 API。能构造请求的只有本应用自身的（未被攻破的）页面。
- *数据流*：`serveAppScheme`（`appProtocol.ts:54-67`）中 `request.url` 仅用于 host 精确相等比较与正则校验，**没有任何字节流入 `net.fetch` 的 URL**。`net.fetch` 的目标恒为 `pathToFileURL(本地路径)`。
- *边界*：`lolping://emotes/*` 路径必须匹配 `EMOTE_URL_RE`（`appProtocol.ts:14`：32 位十六进制 + `webp|anim|sound`，正则内无 `/`、`.` 序列与 `%`），目录固定为设置目录下 `emotes/`、`emote-cache/`；`lolping://app/*` 只服务打包产物目录。两路均再经 `resolveInside`（`safePath.ts:4-15`）——先 `decodeURIComponent` 解码再 `relative()` 判 `..`/绝对路径，编码穿越被还原后仍被拦。
- *绕过面枚举*：百分号编码穿越（解码后被 relative 拦）、双重编码（变成字面文件名→404）、反斜杠混用（win32 join/normalize 归一后同判）、盘符/UNC 绝对路径（`isAbsolute(rel)` 拦）、`host` 伪造 via userinfo（`new URL` 后 host 不等→404）、NUL 字节（`statSync` 抛错→`isFile` 捕获→false）、NTFS ADS 冒号（emotes 路径正则不含冒号；app 路径内容为随安装器分发的公开静态资源，无敏感价值）。`emote` 目录内容为用户自己导入的图片/音频，按内容哈希命名。
- *污点源证伪*：medium 条目称「环境变量 → appProtocol.ts」——实际 `rendererRoot = join(__dirname,'../renderer')`（`index.ts:97`），非环境变量输入。
- *结论*：目标集合 = {固定目录内校验过的本地 file: URL}，不存在攻击者可控请求目标（含 localhost），不构成 SSRF 原语；即便假设渲染进程被攻破，该 handler 也只暴露其本已可读的应用静态资源与按哈希命名的表情文件。**SSRF 判定：误报，置信度高**。残余观察（非漏洞，供阶段 1+ 参考）：`app` host 对 `rendererRoot` 的服务面即打包目录整体，粒度比 emotes 宽，属设计取舍。

**③ low 条目复核（误报，置信度高）**：`emote_bake.py:729` 为 `random.Random(seed)`——素材烘焙管线**刻意**使用种子化确定性 PRNG（`docs/design.md` §13「Baker」，烘焙结果要求可复现）。且 `tools/` 不进发行包：electron-builder `files` 仅 `out/**/*` 与 `package.json`（`package.json` build 段），脚本不在任何运行时路径上。

**④ 首次导入 commit 为何通过**：导入 commit 是会话内首个 git 提交，此前会话没有任何 Edit/Write 记录（hook 状态 `touched` 为空），仓库原生 git hooks（`git-gate status` 显示 pre-commit/pre-push）尚不存在；ZCode 侧门禁在首次 Edit/Write + commit 组合后才产生拦截。属证据支撑的推断（中置信度）——引擎源码为加密资产，无法直接验证内部逻辑。

**⑤ 官方豁免机制实验（负结果，已撤销）**：`mimosa policy init` 生成的 `.mimosa/security-policy.json` 支持 `threatModel.exclusions`（字符串数组）与 `policy check` 校验。实验（scan-…02-40-04）：exclusions 字符串（`path :: findingId :: 理由` 格式）**未被引擎消费**（原 medium/low 原样重现）；而默认模板 `command.forbidShell:true` 反而新增 14 条 high「Shell 执行策略违反」误报（`keys.ts`、`roomProtocol.ts` 等纯标识符模式命中）。实验后已删除该策略文件，仓库恢复无策略状态。`ledger record`（需 `--stdin`，事件 schema 无文档）与 `validate`（只认账本内 finding，账本为空）均不可用。结论：当前版本（0.1.0/1.0.3）不存在**已文档化且实测生效**的误报豁免通道。

**⑥ 处置**：代码保持上游 v0.5.3 原始字节（加固实验已撤销，`git diff` 为空）。误报证据链（本节 + 两次封印扫描 + 全绿账本）随审计分支入库，供后续版本 Mimosa 提供正式豁免机制时引用。

**⑦ 复验（2026-10-24 10:44，上下文压缩后的延续会话）**：按清单重验——工作区、分支（main @ `7dda4d6`）、双语声明与本报告均在；`git diff src/ native/` 为空；官方账本仍全绿、门禁作用域确认为本项目（`git-gate status` 输出 lolPing-main）。单次正常提交尝试仍被逐字节相同的缓存消息拦截，随即停止，未重复尝试。关键新证据：`.mimosa/hook-state/session_202e26f6396d3cc3dd42c8074b586f08.json`（mtime 10:44，本轮 hook 更新）与 bash 临时目录 `zcode-bash-HBJgbd` 均未变——**延续会话与被拦会话是同一 ZCode 会话**（同 session id），会话级缓存从未获得失效机会。「真正重启会话后缓存是否消散」仍属未验证项，需完全退出 ZCode 开新会话方可检验。
