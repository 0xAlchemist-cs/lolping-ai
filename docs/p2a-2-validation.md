# P2A-2：确认截图上传与视觉流式问答验收

日期：2026-10-25（Asia/Shanghai）。工作区 `D:\lolping\lolPing-p2a2`，分支
`feat/p2a2-vision-ai`，基线 `5c133fbe805fb7e6b5e8a3ee6e837a605d069860`。

最新结论：`GO FOR COMMIT`；`CODE GATE: PASS`；`REAL DUAL IMAGE: NOT TESTED`（本轮无真实请求授权，未调用）。
§10记录双图专项排障的复现、修复与门禁；此前双图尝试的历史状态为BLOCKED，不能推断服务端成功或失败。
用户明确确认文字入口只发文字、截图入口能够识图，两个入口均可调用已配置的 API。
真实视觉请求的正文增量及正常结束已观察到。真实模型的停止、复制、重试、双图片发送仍为 NOT TESTED；
对应 Mock 或注入回答的验证单独记录。未提交、推送、合并或发布，等待用户验收。

## 1. 文件变更

共 28 个任务文件：新增 8 个、修改 20 个。运行产物及本机临时诊断在忽略的 `out/`，不属于交付文件。

| 范围 | 文件 | 作用 |
|---|---|---|
| 主进程 | `src/main/visionSnapshot.ts`（新增） | 有界 JPEG 校验、不可变快照、会话/版本/接收方绑定及过期释放 |
| 主进程 | `src/main/aiClient.ts` | 同一客户端的文字/图片请求、SSE、取消、探针与脱敏错误 |
| 主进程 | `src/main/explainWindow.ts` | 主帧授权、截图快照、确认发送、目标显示器校验与生命周期 |
| 主进程 | `src/main/index.ts` | 现有 key/DNS/端点准备、接收配置绑定、取消与请求分流 |
| 主进程 | `src/main/aiRequest.ts`（新增） | 可注入准备阶段，准备后复核取消、有效期、会话/版本和接收配置 |
| 桥 | `src/preload/explain.ts` | 原入口内联新增频道，不引入共享运行时导入 |
| 界面 | `src/renderer/explain/main.ts`、`visionPreview.ts`、`index.html`、`explain.css` | 上传选择、隐私说明、正文状态、快速响应与重试确认 |
| 共享 | `src/shared/vision.ts`、`ipc.ts`、`aiConfig.ts`、`i18n.ts` | 最小请求类型、错误类别、双语界面文案 |
| 测试 | `tests/main/visionSnapshot.test.ts`、`fixtures/visionJpeg.ts`（新增） | 合成 JPEG、大小/格式/解码/快照归属与过期验证 |
| 测试 | `tests/main/aiClient.test.ts`、`explainWindow.test.ts`、`preloadBundle.test.ts` | 请求、SSE、授权、会话、安全桥及取消回归 |
| 测试 | `tests/main/aiRequest.test.ts`（新增） | 准备期间取消、过期、替换和配置变化的确定性回归 |
| 测试 | `tests/renderer/explainMain.test.ts`（新增）、`visionPreview.test.ts` | 实际 renderer 竞态复现、确认选择、停止与迟到事件 |
| 工具 | `tools/vision-ai-smoke.cjs`（新增）、`tools/vision-smoke.cjs` | 多模态 Mock 集成及真实 Electron 本地截图/合成回答操作 |
| 文档 | `README.md`、`README.zh-CN.md`、`docs/design.md`、本报告（新增） | 入口区别、上传隐私及实现与验收边界 |

没有修改原生 Hook、InputBridge、OverlayManager、依赖/lockfile、构建配置、密钥存储、设置 schema、旧工作区源码或 main。

## 2. 文字与视觉请求分离

- 原来的「提问」按钮只调用 `ask(question)`，`messages[0].content` 保持字符串。
- 视觉按钮调用 `askVision`，渲染层仅提供会话、快照版本、问题、选择范围和本次明确确认。
- 主进程拒绝额外图片/路径/URL/Base64 字段。图片只能从当前可信快照中选取。
- 同一 `streamChat` 构造 text + image_url 段，默认一张局部 JPEG；主动勾选后才追加完整显示器 JPEG。
- 图片不重截、不重新压缩。文本附带图序和归一化问号坐标，因为预览的十字标记是 CSS 叠层，没有写入 JPEG。
- 连接测试经 `runChat` 的空回调分支调用 `pingEndpoint`，一 token 探针可返回空正文且强制不含图片；普通问答仍拒绝空回答。

## 3. 快照、同意与生命周期

主进程最多保留一个快照，包含局部和整屏 JPEG 的不可变副本。它绑定当前问号会话、主进程递增版本、
规范化 Base URL 与模型。120 秒后定时清除；再次截图、新问号、关闭预览、关闭窗口和接受一次视觉发送均清除。
发送前还检查显示器仍存在、位置/尺寸/DPI 未变。配置在 key/DNS 等异步准备期间改变则拒绝发送。
消费确认时保留原始期限及主进程会话/版本守卫；key/DNS准备后、进入客户端前再次校验，过期或替换也拒绝发送。

图片要求 JPEG MIME、规范 Base64、完整结构、有效尺寸和 marker，先检查结构尺寸再由 nativeImage 解码核对。
单张最多 3 MiB、合计 6 MiB，两个 data URL 合计不超过 8 Mi 字符；边长不超过 8192，单张不超过 32 Mi 像素。
过期后主进程释放快照，界面禁用发送并直接显示「重新截图」；须主动重拍、重新检查并确认，整屏选择重置为关闭。
图片加载中、加载失败、无上传快照和生成中分别提示。新可信快照会更新过时的初始配置状态。
可见图片的 src 在关闭、发送、换会话和卸载时释放。

界面默认局部图，说明选择数量、接收域名/模型、第三方接收和检查个人信息。必须图片加载完成且快照有效，
才启用「发送所选截图并提问」。视觉重试仅返回重新检查，不自动截图或再次上传。每次上传确认只消费一次。

## 4. GLM 与协议依据

通过应用现有设置接口核实，重启后状态为 `hasKey=true`、`configured=true`、`encryptionAvailable=true`。
首次实际模型值为 `glm-5.3-Flash`；用户亲自在设置中保存为 `glm-5.3-flash`，之后通过相同接口确认。
没有静默覆盖模型，也没有读取、导出、打印或重新保存密钥。

- 服务商域名：`open.bigmodel.cn`。
- Base URL：`https://open.bigmodel.cn/api/paas/v4`，客户端追加 `/chat/completions`。
- 实际配置模型：`glm-5.3-flash`。
- [模型文档](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)说明多模态能力；
  [Chat Completions](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)定义多段图片输入。
- [流式文档](https://docs.bigmodel.cn/cn/guide/capabilities/streaming)区分 content/reasoning_content，并展示 `[DONE]`。
- 没有加入未经真实验证的模型专用参数。通用的 `stream=true`、已有输出 token 上限及安全规则保留。

## 5. SSE、状态与错误

先用实际 `main.ts` 的测试复现：首个 delta 和 done 早于 IPC 返回时，基线回答为空。修复在等待 ID 期间进行
有界缓存，再只重放匹配 ID 的正文和终止事件；请求 epoch 防止停止、重试或关闭后的迟到回复污染新状态。
生成期间发送按钮保持禁用。成功、错误及停止均清空生成提示。窗口关闭/新问号也使旧视觉请求失效。

SSE 支持 UTF-8 分块、半行、多 data 行、CRLF、独立 reasoning 及正常 `[DONE]`。只有 content 进入正文；
finish_reason 不独立终止流。缺少 `[DONE]`、推理后没有正文或空回答均明确失败。事件/回答/错误体受限。
停止在 key/DNS 准备前就拥有 AbortController，流式读取取消后也拒绝同块的迟到正文。

错误只暴露固定双语类别：401 认证、403 权限、404 路径/模型、413 图片限制、429 速率、5xx 服务端、网络/超时等。
已知数字业务码单独映射，例如 HTTP 429 + 1314 为套餐问题，不误称临时限流；拒图、过大、过期、失效等也有明确提示。
不展示或记录原始服务端错误文本。[官方错误码](https://docs.bigmodel.cn/cn/api/api-code)

## 6. 最终自动化与可执行验收

| 项目 | 状态 | 证据 |
|---|---|---|
| TypeScript | PASS | `npm run typecheck` 退出 0 |
| 生产构建 | PASS | `npm run build` 退出 0，原有 5 个 preload 独立产物 |
| 全部 Vitest | PASS | `npx vitest run`：78 文件、1268 测试，退出0；专项新增24项，包含双图跨层集成及准备期竞态 |
| helper | PASS | `npm run test:helper`：542 passed、0 failed；仅进程环境 `CL=/utf-8 /Zc:preprocessor` |
| 本地截图冒烟 | PASS | `node tools/vision-smoke.cjs`：真实 Windows Electron、2560×1600、125%；局部640×480、整屏1728×1080、原点、轮盘/Ping、窗口排除/恢复及图片释放 |
| 多模态冒烟 | PASS | `node tools/vision-ai-smoke.cjs`：6 次 Mock 请求，真实 snapshot/client；单/双图原字节、默认不含整屏、文字字符串、坐标文本、UTF-8、停止、迟到事件和1314分类 |
| 快速首 token/done | PASS | 实际 renderer 测试先失败再修复；IPC 返回前正文和 done 不丢失 |
| 确认/归属/过期 | PASS | 拒绝未确认、伪造字段、旧会话/版本、过期、配置变化、显示器失效及重复发送 |
| 停止/关闭/重试 | PASS | Mock/注入事件验证实际取消、保留正文、丢弃迟到事件、视觉重试重新确认；关闭新预览也发终止事件退出生成 |
| 复制合成回答 | PASS | 真实 Electron 点击复制，等成功提示后 `await clipboard.readText()` 与合成可见正文一致 |
| preload/沙箱 | PASS | 所有生产桥在受限 VM 单独加载，window.overlay/window.explainApi 注册，频道一致；无 sibling/shared chunk |
| 捕获隐私 | PASS | 实际截图作用域 externalRequests/fetchCalls/clipboardWrites/fileWrites 均0；合成回答复制在该作用域之外 |
| Mock 网络隔离 | PASS | 多模态冒烟 externalRequests=0、imageFileWrites=0；合成 JPEG 不是用户真实截图 |

首次新复制冒烟把异步 clipboard.readText() 与字符串直接比较，检查错误；按本地 Electron 类型及
[官方 API](https://www.electronjs.org/docs/latest/api/clipboard)加入 await 后通过。产品使用 navigator.clipboard.writeText，未因此改写产品复制逻辑。

## 7. 真实 Windows / API 验收

| 项目 | 状态 | 证据 |
|---|---|---|
| 物理手势与卡片 | PASS | 用户使用 Alt＋左键拖动，并提供两个实际界面确认入口 |
| 本地预览/默认局部 | PASS | 用户确认；页面直接读到640×480已加载、整屏未勾选、仅1图、目标域名/模型正确 |
| 安全配置与重启保存 | PASS | 应用状态接口确认加密/密钥存在/配置完成；正常退出重启后保留用户所存模型，无须重输Key |
| 本轮连接测试按钮 | NOT TESTED | 控制费用，未追加真实探针；分流及空正文兼容有Mock测试 |
| 纯文字真实回答 | PASS | 页面 lastMode=text；模型回复未收到图片。用户确认第一入口仅文字且API可用，符合预期 |
| 单图真实视觉回答 | PASS | 页面 lastMode=vision；用户提供视觉描述并明确确认第二入口可以识图，两个入口均连API |
| 真实 SSE 正常完成 | PASS | 页面现有 on 接口观察145个delta、252个正文字符、1个done、0个error（单个request ID） |
| 真实生成状态退出 | PASS | 正文252字符，hint空、Stop隐藏、发送/复制启用、错误隐藏、两图src释放 |
| 真实模型复制 | NOT TESTED | 用户明确回答没有点击复制；卡片已关闭，不追加模型调用；未冒充通过 |
| 真实模型停止 | NOT TESTED | 未增加真实停止请求；Mock及注入流通过 |
| 真实模型重试 | NOT TESTED | 未增加真实重试请求；Mock及界面确认流程通过 |
| 双图片真实请求 | NOT TESTED | 历史尝试BLOCKED：曾观察120秒过期禁用，重开后反馈仍不可用或失败，没有真实发送/完成证据。本轮专项仅Mock；须取得新的明确确认后才可由用户发送一次 |
| 精确HTTP/网络层图片数量 | NOT TESTED | 没有抓取真实请求正文/响应头；不把Mock报文或界面推断冒充实际网络抓包 |
| 100%/150%/混合DPI多屏 | NOT TESTED | 本机实测125%；其他几何由单测覆盖，未声称对应硬件实机通过 |

模型返回描述了局部中心的留白及邻近面板/侧栏，用户明确确认识图成功。本报告不保存实际回答全文、
真实截图、Base64、请求头或用户附件。JPEG选择和原字节一致性由主进程约束及Mock报文验证；真实网络正文没有采集。
根据正常客户端完成路径可推断远端HTTP通过了res.ok检查，但具体成功状态码未采集，不能声称亲见HTTP200。

开发阶段已确认真实问答为2次：用户先在原入口发1次文字，再亲自在截图入口发1次视觉问题；用户明确允许补1次。
最终审计阶段用户另行同意尝试1次双图，但没有取得完成证据，也未采集服务端计数，不能据此确认该尝试是否产生请求。
代理自动真实请求0次，没有自动连接探针、循环、停止、重试或压力请求。这里统计已确认操作，不声称总调用量恰为2，
也不声称掌握用户历史或其他时段的账单总量。Mock请求与真实请求独立计数。

## 8. 安全审查、限制与 Git

- 复用现有safeStorage/DPAPI与AiKeyStore；未读取或展示加密文件内容。Key只按既有主进程请求路径使用。
- 保留HTTPS、DNS/private-address校验、TLS、redirect:error、沙箱、contextIsolation及主帧权限。
- 图片仅发送到用户已配置且本次确认的服务；既有网络客户端之外没有新服务、图床或截图遥测。
- 自动审批拒绝主进程V8 inspector，因其可触及密钥处理/认证状态；未启用或绕过，改用允许的页面状态计数。
  因而具体HTTP状态/真实报文没有采集。这不影响已有页面正常完成和用户视觉确认的证据。
- 旧P2A-1的多显示器瞬时缩略图、DWM跨进程同步、保护内容/全屏、系统内存转储/Chromium回收限制仍存在，详见§16。
- 临时本机观察器不输出正文、截图或请求头，结束随窗口释放。用户的两张附件截图未复制到项目或构建产物。
- 凭据/嵌入截图扫描及完整差异审查未发现密钥、真实截图或敏感日志。合成JPEG测试夹具是无屏幕内容的2×1黑图。
- HEAD保持基线5c133fb，修改/新增文件均未暂存。没有commit、push、PR、merge、发布或破坏性Git操作。

交付为待用户验收的工作区修改；真实未测项保持上表状态，不以Mock结果替代。

## 9. 最终独立审计与用户追加的窗口设计

用户在最终审计期间另行明确要求调整小框设计、支持缩放并保留英雄联盟风格。本节记录这项授权后的修改，
不是从最初的只读审计要求自行扩大范围。本节记录当时26个任务文件；后续专项见§10，最终清单为28个文件。
没有新依赖或额外收费调用。

### 交付决策

代码与自动化门禁判定：**GO FOR COMMIT**。没有未解决的已确认P0/P1问题；本轮发现的两个UI问题已修复。
这只表示可以按明确清单准备提交，不表示全部真实API操作已验收，也不代替用户对commit/push/PR的批准。
当时双图实机项目记为BLOCKED；本轮最新状态为REAL DUAL IMAGE: NOT TESTED，详见§10。
真实停止、复制和重试仍保持NOT TESTED。没有执行Git写操作。

### 设计与可执行检查

- 按用户最新选择收敛为客户端海克斯风格：深蓝黑底、细哑金边、少量青色点缀、深色描边主按钮；
  去掉大块金色填充、四角装饰与空白态大问号，缩小标题徽记。仅调整CSS及移除装饰元素，未变更请求行为。
  标题栏可拖动，原生窗口边角可缩放，标题栏双击可放大/恢复。
- 初始560×600 DIP，最小400×360 DIP；初始尺寸及最小值对显示器workArea作限制。原问号坐标不随窗口变化。
- 文字输入和回答独立布局；图片区滚动，确认信息可滚动，问题输入和发送按钮保持可达；宽窗两图并排。
- 没有增加窗口控制IPC或preload入口，没有改动上传同意、客户端、安全存储和Hook。
- 真实Electron使用完全合成的页面、JPEG及回答，验证400×360、560×600、900×700请求尺寸、拖动区域样式、
  原生可缩放/最大化能力及最大化恢复。英文双图说明、合法长域名和100字符模型名也通过。
- 本次样式调整后重新运行合成布局检查；最小窗口实际返回402×362 DIP时，长文案发送按钮仍可见，
  图片滚动区68像素；标准中文对应86像素。类型检查、构建、77文件1244项测试及Windows截图冒烟重新通过。
  三种尺寸调整合计只生成一次合成预览，没有因缩放重新捕获，externalRequests=0。
- 设计预览仅是合成窗口内容，位于忽略的out目录；没有把用户桌面或附件保存为设计图或提交文件。

### 按严重程度的审计结果

P0：未发现。P1：未发现。P2：两项UI正确性问题，均已修复。P3：没有确认的新增产品缺陷；下述覆盖/环境限制保留。
Standards轴发现两项UI问题并复审确认解决；Spec轴未发现新增功能/安全缺陷。审查没有把代码气味猜测当成漏洞。

| 严重度/问题 | 位置 | 触发与后果 | 证据、修复与回归 |
|---|---|---|---|
| P2：视觉请求显示纯文字提示 | `src/renderer/explain/main.ts`的updateModeLabel/setState；共享ExplainText及双语文案 | 确认图片后返回回答区，原固定标签错误声称不发送截图；首字前错误/停止也可能误导 | 实际renderer测试先复现失败；改为按最后提交模式显示，并说明下次普通提问仅文字；新会话及新文字问题重置。正常视觉、首字前错误/停止及后续文字均通过，复审无残留 |
| P2：小窗长接收信息挤出发送按钮 | `src/renderer/explain/explain.css`的visionConsent/visionDetails/visionComposer及`index.html` | 402×362实际窗口中，英文双图和长合法接收信息使按钮越出视口 | 原生布局检查先得到sendVisible=false；将可滚动详情与固定输入/发送区分离后，三种尺寸、两种文案配置全部sendVisible=true；未裁去域名内容 |

本轮新增窗口测试先在原固定460×360、不可缩放窗口上失败，修复后通过。整体最终Vitest为77文件1244项；
typecheck、build、542项helper、多模态Mock和原有Windows截图冒烟均在本轮重新执行通过，没有跳过失败测试。

复制一致性冒烟曾在与全量测试并行时出现一次answerCopyMismatch；独立复现通过，尚未得到稳定的产品失败条件。
系统剪贴板是全局资源，这一环境/检查不稳定性保留为限制，不虚构已定位原因，也不据此把真实模型复制标为PASS。

### 未修复缺陷与保留限制

- 没有已确认而未修复的P0/P1/P2产品缺陷。真实双图失败/不可用的反馈尚未定位；观察到的快照过期属于预期拒绝，
  不能从混合反馈推断发生了服务端故障，也不能将它改记为双图通过。没有为追求全绿重复付费请求。
- 当时key/DNS await期间只有源码及边界检查；§10已把生产使用的相同生命周期提取为AiRequests并加入跨层测试。
  实际KeyStore和真实DNS不在本轮测试中调用。
- `src/shared/aiConfig.ts`/`index.ts`仍是请求前DNS预解析，实际fetch连接没有固定到已验证地址；
  不声称彻底防止DNS rebinding，也没有未经授权放宽或改写既有安全规则。
- macOS/Linux视觉、其他DPI/多屏及精确HTTP报文仍未新增真实验证。不能从Windows和Mock推断这些项目通过。

### 最终暂存清单与PR准备

分支`feat/p2a2-vision-ai`，HEAD仍为`5c133fbe805fb7e6b5e8a3ee6e837a605d069860`。
修改20、新增8、暂存0；没有无关修改、删除、依赖、未忽略构建产物或大文件。扫描无真实凭据/截图命中，
唯一编码图片夹具是已核实来源的2×1合成黑图，不是实际屏幕内容。拟逐项暂存以下28个文件，禁止git add -A：

```text
README.md
README.zh-CN.md
docs/design.md
docs/p2a-2-validation.md
src/main/aiClient.ts
src/main/aiRequest.ts
src/main/explainWindow.ts
src/main/index.ts
src/main/visionSnapshot.ts
src/preload/explain.ts
src/renderer/explain/explain.css
src/renderer/explain/index.html
src/renderer/explain/main.ts
src/renderer/explain/visionPreview.ts
src/shared/aiConfig.ts
src/shared/i18n.ts
src/shared/ipc.ts
src/shared/vision.ts
tests/main/aiClient.test.ts
tests/main/aiRequest.test.ts
tests/main/explainWindow.test.ts
tests/main/fixtures/visionJpeg.ts
tests/main/preloadBundle.test.ts
tests/main/visionSnapshot.test.ts
tests/renderer/explainMain.test.ts
tests/renderer/visionPreview.test.ts
tools/vision-ai-smoke.cjs
tools/vision-smoke.cjs
```

拟提交/PR标题为`feat(ai): add consent-based vision chat for question pings`，PR目标main。
正文应包含单/双图显式同意、可信快照、既有文字路径、单图真实证据、快速SSE竞态修复、窗口设计及上述测试/限制。
用户批准后才commit/push/创建PR；CI任一平台失败须先调查，合并和发布另需明确批准。

## 10. 双图BLOCKED专项排障与最终门禁

日期：2026-10-25。结论：`GO FOR COMMIT`；`CODE GATE: PASS`；`REAL DUAL IMAGE: NOT TESTED`。
没有已确认而未修复的阻塞产品缺陷；历史真实双图是否离开客户端仍无法确定。本轮没有新的真实请求授权，
真实API调用0次，没有连接探针、自动重试、抓包或新增调试端口。工具可用，未遇到工具额度阻塞。
真实模型复制、停止、重试均保持NOT TESTED；已有单图145 delta/1 done及退出生成状态属于此前证据。

### 实际原因与复现

此前能够确认的是快照已到120秒期限，UI按设计禁止发送；等待人工确认的流程跨过期限。
重新操作后“按钮不可用或失败”的反馈没有对应请求阶段证据，不能追认为智谱拒绝双图或已成功上传。
本轮在合成数据中确认并修复以下问题，不把它们全部追认为历史失败的唯一原因：

| 确认的问题 | 确定性复现与修复前结果 | 修复位置 |
|---|---|---|
| 过期恢复入口隐藏 | 假时钟推进到120000ms，发送禁用但预览入口仍隐藏，必须先关预览才能重拍 | `visionPreview.ts:230`：直接显示重新截图；主动重拍后整屏选项复位，重新检查并点击才发送 |
| 图片加载失败无说明 | 局部load成功、选整屏、整屏error：发送禁用，status原为空 | `visionPreview.ts:44`及`:243`：分别提示等待和失败；切回可用局部图能恢复；不静默丢掉整屏图 |
| 配置完成后的陈旧标志 | 卡片初始configured=false；随后主进程返回有效新快照，加载双图后发送仍禁用 | `visionPreview.ts:138`：新主进程快照更新初始配置状态；无有效快照仍禁止上传 |
| 准备期间期限/版本不再复核 | 点击时有效，挂起准备，推进120秒或替换快照，再完成准备；原逻辑仍成功调用Mock客户端 | `aiRequest.ts:25`、`explainWindow.ts:108`、`visionSnapshot.ts:165`：消费确认保留原期限和主进程会话/版本守卫，准备完成后复核；失败时fetch=0 |
| HTTP413诊断过于笼统 | 注入413且错误体无可用业务码，原返回http | `aiClient.ts:106`：返回既有imageTooLarge固定错误；不展示原始响应 |

上述问题均先得到失败断言再修复。120秒期限、JPEG限制、HTTPS/DNS/TLS、redirect:error及主帧授权没有放宽。
`index.ts:382`复用同一配置准备函数和客户端，将原生命周期移至可注入的AiRequests，便于覆盖异步竞态；
未改变密钥存储/读取实现，没有访问实际KeyStore或解析真实服务商DNS进行本轮测试。

### 状态转换与阶段诊断

状态只保留于内存、固定双语文案及按钮`data-block-reason`，没有新增永久日志。该属性不含会话内容、图片或凭据。
截图成功、两图加载、整屏选择、快照存在/期限、会话/版本、配置变化、busy及确认分别由以下条件记录和测试：

| 场景 | UI/快照条件与转换 | 主进程和客户端结果 |
|---|---|---|
| 正常可发送 | capture成功；局部load；选整屏后必须full也load；配置有效、快照未过期、非busy：ready | 点击前confirmed尚未提交；点击构造confirmed=true且携带当前sessionId/snapshotId；授权主帧校验后仅一次consume/ask/client.fetch；两个image_url原字节、顺序均匹配；SSE done后退出生成 |
| 图片未就绪 | localPending/fullPending；若所选图error则imageFailed；发送禁用且显示具体提示 | 未进入askVision，不调用客户端；不能将显示的双图自动降为单图 |
| 120秒过期 | expiresAt<=now：expired；禁用发送并出现重新截图 | UI阻止；绕过UI直调也得到snapshotExpired；未调用客户端 |
| 主动恢复 | 点击重新截图取得新版本，默认仅局部；重新load、选整屏并确认 | 不静默截图/发送；新版本可正常发送双图一次，旧版本失效 |
| 会话/版本失效 | 新问号重置预览；旧异步capture回复丢弃；错误版本不获确认 | IPC当场snapshotStale；已在准备中的旧会话由取消/守卫拒绝，fetch=0 |
| 取消预览 | closePreview递增版本、清快照；关闭后的异步截图无效 | 未确认时不发送；视觉生成/准备中的取消返回aborted；迟到事件不改变新UI |
| 上传范围变化 | 单/双连续切换；仅选整屏时要求full就绪；恰好到期切换仍expired | 请求scope与最后选择一致；无隐式扩图/缩图；没有因切换重新捕获或联网 |
| 重复提交 | 首次点击清空本地快照并进入generating | 主进程也消费一次确认；双击只产生一次请求；重复版本被拒绝 |
| 配置变化 | 捕获期间配置变动则不返回可上传快照；重拍取得新配置后恢复 | 点击前接收方不符为snapshotStale；准备期间变动为configChanged，fetch=0 |
| 准备期间过期/重拍 | UI已提交，挂起key/DNS准备，再推进期限或触发新capture | 最后一道守卫分别snapshotExpired/snapshotStale，未进入客户端 |
| 网络调用失败 | 仅在已通过本地确认、主进程校验并进入客户端后归网络阶段 | DNS预检失败为resolve；连接/TLS/fetch错误为network，超时为timeout。客户端不会根据原始异常文字猜测具体TLS根因 |
| 模型/服务拒绝 | Mock客户端已调用，固定错误码进入failure；重试返回重新检查 | 401 auth、403 permission、404 notFound、413 imageTooLarge、429 rate、5xx server；已知业务码另行映射；未追加请求 |
| SSE不完整 | 客户端已接收流，但无DONE/空回答/无有效正文 | badResponse；显示错误并退出generating，不与本地按钮禁用混淆 |

授权失败在main.authorize阶段返回null；会话与版本拒绝在main.snapshot阶段返回固定snapshotStale。
单独测试分别传入外来frame、旧session及错误revision，均不进入ask/client；不为诊断增加新的IPC或泄露内部状态。
跨层正常路径的内存阶段序列是capture.success → renderer.askVision → main.ask → main.prepare → client.fetch → sse.done。
本轮真实请求没有该阶段观察，不能把上述Mock阶段序列当成远端发送证据。

### 新增回归与自动化记录

专项相对1244项版本新增24项，总计78文件1268项：

- `tests/renderer/visionPreview.test.ts:80`起新增6项：配置恢复、120秒过期重拍、加载失败、就绪/未就绪切换及期限边界。
- `tests/main/aiRequest.test.ts:28`起6项：准备期间Stop、配置变化、关闭功能、过期、替换，以及实际客户端正常SSE。
- `tests/main/explainWindow.test.ts:231`起10项：实际renderer/main IPC/快照/准备/客户端贯通；双击、期限、新capture、配置、会话、关闭、Stop、403及重新检查。
- `tests/main/visionSnapshot.test.ts:94`新增一次性consume且不延期；`tests/main/aiClient.test.ts:196`新增413脱敏分类。

| 最终命令 | 实际退出码 | 结果 |
|---|---|---|
| npm run typecheck | 0 | PASS |
| npm run build | 0 | PASS；out/preload只有text.js、panel.js、explain.js、settings.js、overlay.js，无共享chunk；VM独立加载测试通过 |
| npx vitest run | 0 | PASS；78文件1268项 |
| 指定CL环境的npm run test:helper | 0 | PASS；542 passed, 0 failed；finally清除CL |
| node tools/vision-smoke.cjs | 0 | PASS；Windows Electron 2560×1600/125%、原点/标记、窗口排除恢复、图片释放、缩放及注入文字/Stop/复制；捕获作用域externalRequests/fetchCalls/clipboardWrites/fileWrites均0 |
| node tools/vision-ai-smoke.cjs | 0 | PASS；6次Mock请求；精确单/双图、文字不附图、SSE/DONE/Stop/迟到事件；externalRequests=0、imageFileWrites=0 |

保留失败过程：helper首次因正在运行的开发应用占用hook-helper.exe，LNK1104，尚未运行测试。
当时PowerShell的finally掩盖了npm非零退出（外层0），因此明确判为FAIL；托盘正常退出本项目应用后，
重跑时显式透传LASTEXITCODE，构建与542项测试通过。没有修改Hook或关闭安全措施。
首次Windows冒烟退出1，固定码answerCopyMismatch；独立复跑及最终构建后的串行复跑均退出0。
未打印剪贴板正文，不能确定首次不一致的根因；将这项环境/检查不稳定性保留，不把真实模型复制标为PASS。

### 交付与保留限制

完整Git清单见§9的28个文件：20修改、8新增、0暂存、无删除，HEAD仍为5c133fb。
新增的两个专项文件只有aiRequest.ts和其测试；不新增依赖、Hook、共享preload或配置文件。
逐项暂存清单和PR正文仅准备在被忽略的out/p2a2-final-audit；本轮没有git add、commit、push、PR、merge或发布。
最终28文件凭据/嵌入图片扫描无命中（已知2×1合成黑图夹具除外），暂存0；native及密钥存储等受保护路径无改动。
git diff --check退出0，只有既有LF/CRLF提示。正常npm run dev已恢复启动，未加调试端口或触发模型调用。
未将截图或响应正文写入诊断文件；没有读取真实Key、密文文件、Authorization或完整服务端响应。
纯文字、默认局部、本地预览不联网由自动化保持；实际双图、真实复制/停止/重试仍需另行授权验收。
现有DNS预解析不等于连接地址固定、其他DPI/多屏和macOS/Linux视觉未新增实机证据，限制继续保留。
