# P2A-3：真实 API、设置与 Windows 窗口稳定性验收

> 下文至“先前轮次交付结论（历史）”保留本专项开始前的记录。1285项/19文件及NEEDS FIX为历史状态；最新结果见末尾“AI Streaming 与 Windows Clipboard 最终稳定性审计”。历史失败不删除。

日期：2026-10-25（Asia/Shanghai）。报告只保存测试结论、固定错误码和非敏感元数据，不保存真实截图或回答正文。

## 基线与权限

- 工作区：`D:\lolping\lolPing-p2a3`；分支：`feat/p2a3-stability`。
- 原 main / 当前 HEAD：`f2e1dbef34603e3ac47b8baa3cda4ce929e06b9c`。本轮创建独立工作区，初始干净。
- P1B、P2A-1、P2A-2工作区及原报告未改；无reset、clean、分支/目录删除。
- 原有真实文字、单图、145 delta / 1 done证据引用历史，不冒充本轮重测。
- 本轮新增设置修复、输出上限提示、部分答案保留及快拖白边修复。Hook、密钥存储、同意上传、DNS/TLS安全规则、preload、依赖和请求token预算未变。
- 没有启用主进程调试端口；没有读取实际Key、密钥文件、Authorization或实际HTTP请求体。
- 未commit、暂存、push、创建PR、merge或Release；开发实例保留供用户使用。

## 缺陷与最小修复

| 级别 | 原因与位置 | 修复 | 验证与当前结论 |
|---|---|---|---|
| P2 | 模型/Base URL输入绑定异步设置值；IPC回包前React回滚DOM，光标移到末尾。AiConfigSection.tsx:23 | 焦点内同步draft，仍用原设置API逐键保存；旧回包不覆盖正在编辑的draft，失焦后同步规范值；密码框不改 | 实际Fluent/useAppState合成输入修复前RED，修复后中间插入/删除、快速输入、旧回包、Unicode替换和Base URL通过；用户确认“两处都正常”。已解决 |
| P3 | settingsIpc.ts:14的GitHub主页写死原仓库 | 改到0xAlchemist-cs/lolping-ai；上游release说明回退URL单独保留，未更换更新源 | 新主页处理器测试RED→GREEN；用户确认。已解决 |
| P2 | aiClient.ts:276、289未区分finish_reason=length与完整回答 | 收到length标记后仍要求[DONE]，然后输出固定outputLimit；渲染层保留部分正文、明确提示可能不完整、结束生成并允许复制。空连接探针仍合法；无[DONE]仍badResponse | 4项客户端、2项渲染回归RED→GREEN，覆盖早到事件；Windows冒烟验证提示和按钮状态。已解决确定的处理缺口；未证明它就是上次真实截断的原因 |
| P2 | explainWindow.ts:217只在done后认为已有回答，部分答案在Stop/错误后失焦会关闭卡片 | 收到非空可见delta即保留卡片 | Stop/outputLimit后blur的2项回归RED→GREEN。已解决；未冒充真实Stop验收 |
| P3 | AI网页深色，但系统浅色主题下原生窗口未启用暗色DWM，快速原生缩放露出浅色gutter；CSS/idle accent无法覆盖该绘制层 | 新windowsFrame.ts:21仅对该HWND启用DWM attribute 20；固定隐藏PowerShell命令只接收数字HWND/PID并校验所属进程。explainWindow.ts:302等待网页与有界原生准备完成再显示，关闭后忽略迟到结果。失败/不支持时降级到可用卡片；不改全局主题、原生resize样式或Hook | 快拖A/B复现，生产修复函数通过；6项原生调用边界/失败/跨平台测试及2项显示/关闭竞态测试通过。用户最终确认“白边已消失”。已解决 |

输出上限修复保持原maxTokens=1024，不自动续写、扩大预算或重试。
真实回答中途结束没有实际finish_reason、HTTP或终止事件证据，不能据此宣称服务商、token上限或SSE解析是已证实原因。

## 快速缩放复现

1. 旧配置正常打开深色、可原生缩放窗口，在当前浅色系统主题下快速往返拖动边缘。
2. 初次仅统一网页/窗口背景与accent边框颜色，用户反馈“仍有明显白边”；该尝试不算成功。
3. 排除Electron mouse forwarding问题：生产overlay未启用forward:true。
4. 最初边移动边采样拖慢了轨迹；按用户反馈改为独立鼠标线程，以高分辨率时钟驱动6次往返，采样线程不控制拖动速度。
5. `node tools/window-resize-smoke.cjs`在隔离Electron进程、当前system主题下测试实际生产样式函数；原生鼠标注入，不是物理手势证据。纯色桌面覆盖、采样仅驻留内存，不保存图像。

| 配置 | 原生will-resize事件 | 实测水平速度 | 有效采样像素 | 白色像素 | 原生暗色属性 |
|---|---:|---:|---:|---:|---:|
| 旧配置baseline | 154 | 5944 px/s | 320740 | 47569 | 0 |
| 生产单窗口修复fixed | 145 | 5926 px/s | 300440 | 0 | 1 |

两组实际尺寸变更帧为78/73，均无遮挡跳过，外部请求0。脚本断言速度至少5000px/s且确实发生原生缩放，避免程序setSize或慢拖冒充。
另两次约5900px/s诊断中旧配置白像素46023/38276，修复后均0。
早期强制fixture为light（生产使用system）时曾采到修复组1230个白像素/1帧；保留这一诊断失败，当前结论限定生产system主题配置，不推广到所有强制主题/硬件组合。
最终启动修复版后，用户按原来会复现的速度快速拖动四边/角并确认“白边已消失”；这是独立的真实物理操作证据。

原生准备最多等待5秒，异步执行不阻塞输入线程；不支持DWM或PowerShell受限时仍打开卡片，样式可能降级。macOS/Linux不启动该子进程。
Microsoft定义该属性作用于单个窗口：[DWMWINDOWATTRIBUTE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)、[DwmSetWindowAttribute](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmsetwindowattribute)。

## 自动化门禁

基线产品未改时：TypeScript、build、78文件1268项Vitest、542项helper和两项原冒烟均退出0。
以下是接入最终生产修复后在本工作区重新执行的结果：

| 命令 | 退出码 | 实际结果 |
|---|---|---|
| npm run typecheck | 0 | PASS |
| npm run build | 0 | PASS；五个独立preload，无共享preload chunk |
| npx vitest run | 0 | PASS；79文件1285项，较基线新增17项 |
| 指定CL的npm run test:helper | 0 | PASS；542 passed / 0 failed，finally恢复原CL |
| node tools/vision-smoke.cjs | 0 | PASS；2560×1600、125%；局部640×480、整屏1728×1080；轮盘/Ping、原始目标、窗口排除/恢复、释放、布局、合成SSE/Stop/复制和outputLimit提示 |
| node tools/vision-ai-smoke.cjs | 0 | PASS；本次6个Mock请求，单/双图批准字节一致、默认局部、文字不带图、reasoning隐藏、DONE、Stop和迟到事件 |
| node tools/settings-input-smoke.cjs | 0 | PASS；实际Fluent输入、5次合成设置保存；externalRequests=0、aiCalls=0 |
| node tools/window-resize-smoke.cjs | 0 | PASS；上表原生快拖A/B；externalRequests=0 |

helper测试前通过本项目唯一托盘正常退出真实应用，未强杀其他应用；仅清理了本轮拥有且已核对PID/脚本路径的遗留合成探针。
测试后npm run dev重新启动成功，无调试端口。开发构建重写out属于正常行为，不等于生产构建未执行。

本轮较早的一次完整门禁中vision-smoke以answerCopyMismatch退出1，其余相关门禁通过；随后独立复跑及增强诊断后的复跑通过，接入最终边框修复后的上述正式复跑也通过。
没有删掉失败记录、跳过断言或加入sleep；不能仅凭复跑成功判定偶发问题已修复。
自动化与真实收费请求严格分开；上表Mock的6次仅指该次脚本，单元测试和此前基线/诊断执行另计，不汇总成真实请求。

## 验收矩阵

| 测试 | 状态 | 证据类型 | 说明 |
|---|---|---|---|
| 设置中间编辑/主页 | PASS | 真实人工操作、单元测试、Windows Electron合成输入 | 用户“两处都正常” |
| Windows物理问号卡片流程 | PASS | 真实物理操作 | 用户本轮打开卡片、手动预览/发送并快拖复核；不将注入wheel事件计作物理证据 |
| 本地局部截图 | PASS | Windows受控合成桌面、用户操作 | 截图冒烟及本轮手动双图流程 |
| 本地整屏预览 | PASS | Windows受控合成桌面、用户操作 | 手动选择整屏；Mock准确核对批准图片 |
| 本地预览不发AI请求 | PASS | Windows受控合成桌面、静态代码审查 | 捕获作用域externalRequests/fetchCalls/clipboardWrites/fileWrites均0 |
| 单图真实视觉 | PASS | 真实第三方API（历史） | 引用P2A-2，本轮未重发单图 |
| 双图真实视觉返回 | PASS | 真实第三方API、用户操作 | 用户重新点击后成功；答案体现局部与整屏，来自UI/人工推断，未抓包证明两个image_url出网 |
| 本轮真实回答完整性（修复前） | FAIL | 真实第三方API、人工反馈 | 用户称输出到一半卡住并直接结束；终止原因未采集，不能写成完整成功 |
| 新版输出上限提示的真实验收 | NOT TESTED | 真实第三方API | 只做Mock回归，未为复核追加收费请求 |
| 本轮真实SSE正常结束 | NOT TESTED | 真实第三方API | 未取得本次delta/done/finish_reason；用户看到退出生成不等于协议完整 |
| 历史真实SSE正常结束 | PASS | 真实第三方API（历史） | P2A-2的145 delta / 1 done |
| 真实复制可见正文 | PASS | 真实人工操作 | 用户选择“1”确认核对，但指出答案只有一部分；PASS仅限当时可见部分，不能推为完整答案复制 |
| 真实停止 | NOT TESTED | 真实第三方API | 无新增授权；Mock取消/保留部分正文通过 |
| 真实重试 | NOT TESTED | 真实第三方API | 手动第二次发送不冒充应用“重试”按钮；Mock通过 |
| 120秒快照过期 | PASS | 单元测试、Mock | 假时钟到期禁用/拒绝上传 |
| 过期重新截图 | PASS | 单元测试、Mock | 主动重拍、新版本、默认局部、重新选择与确认，不静默上传 |
| 取消后迟到事件 | PASS | 单元测试、Mock | 关闭、换会话、准备期失效不发旧图；旧SSE丢弃 |
| 剪贴板稳定性 | FAIL | Windows Electron合成回答 | 本轮发生过一次answerCopyMismatch；最终复跑PASS但偶发根因未定位 |
| 窗口尺寸和快拖白边 | PASS | 真实物理操作、Windows原生输入注入、单元测试 | 修复前人工FAIL；最终用户“白边已消失”；A/B像素证据如上 |
| TypeScript | PASS | 自动化门禁 | 退出0 |
| Vitest | PASS | 单元测试、Mock | 1285项 |
| Helper | PASS | C++单元测试 | 542项 |
| 生产构建 | PASS | 自动化门禁 | 退出0 |
| Preload安全 | PASS | 单元测试、实际Windows Electron | 五桥独立，无共享chunk；sandbox/contextIsolation保留 |
| 两项原冒烟 | PASS | Mock、Windows受控合成桌面 | 最终退出0，保留此前剪贴板偶发失败 |
| 其他DPI/多显示器 | NOT TESTED | 实机 | 本轮仅单显示器125%，不外推 |
| macOS/Linux视觉实机 | NOT TESTED | 实机 | 保留历史范围，跨平台单测不等于视觉实机 |

## 真实API计数与隐私边界

- 本轮明确授权：最多1次真实双图，由用户检查安全画面后手动发送。
- 用户确认手动点击发送2次：“重新点击发送才成功”；不把第二次操作伪记为同一次延迟返回。
- 已确认有真实模型返回的请求至少1次。第一次未返回，无法确认是否已出客户端或产生账单；实际计费请求总数未知，不填虚构精确值。
- 代理自动真实API请求：0。其后未再请求停止、重试、连接测试或续写。
- 服务商域名：`open.bigmodel.cn`；模型ID：`glm-5.3-flash`。
- HTTP状态：未观察；第一次脱敏分类为“人工反馈无返回，阶段未知”，不可擅归为网络错误或服务端拒绝。
- 没有捕获真实请求体/认证头、保存屏幕图片/回答全文、访问密钥文件或更改Key；测试输入与夹具设置均合成。

## 剪贴板调查与剩余限制

产品复制仍等待navigator.clipboard.writeText完成后提示复制成功，复制对象只有latestAnswer。此次未修改产品复制逻辑。
增强vision-smoke仅在不一致时读取合成结果的长度/布尔匹配元数据，检查renderer读取和主进程第二次读取，不输出剪贴板正文。
增强后失败尚未复现，因此诊断分支没有取得根因证据；不能证明跨进程竞争、权限、失焦或同步时序中的哪项导致失败。
历史和本轮独立复跑成功不抹去偶发失败，也不能仅归因于并行运行。继续保留未定位问题，不用任意等待掩盖。

本轮真实回答完整性FAIL保留；新版仅对已知length终止提供准确提示，不保证所有服务端中断都等价于该情况。
DNS预解析不等于连接地址固定；Electron/DWM截图同步、瞬时多屏缩略图、全屏/受保护内容及系统内存回收边界继续保留。
未验证的DPI/多屏、macOS/Linux视觉实机及真实Stop/Retry保持NOT TESTED。

## 专项开始前Git清单（历史）

当前19文件：14修改、5新增、0删除、0暂存。无out、截图、密钥、依赖锁文件或构建产物进入清单。

```text
M docs/design.md
M src/main/aiClient.ts
M src/main/explainWindow.ts
M src/main/settingsIpc.ts
M src/renderer/explain/explain.css
M src/renderer/explain/main.ts
M src/renderer/settings/components/AiConfigSection.tsx
M src/shared/aiConfig.ts
M src/shared/i18n.ts
M tests/main/aiClient.test.ts
M tests/main/explainWindow.test.ts
M tests/main/settingsIpc.test.ts
M tests/renderer/explainMain.test.ts
M tools/vision-smoke.cjs
A docs/p2a-3-validation.md
A src/main/windowsFrame.ts
A tests/main/windowsFrame.test.ts
A tools/settings-input-smoke.cjs
A tools/window-resize-smoke.cjs
```

拟提交信息：`fix(ai): stabilize settings input and Windows answer cards`。此处A表示新增未跟踪文件，并非已暂存。
差异安全扫描退出0：19文件、敏感模式命中0、超过1MB文件0、暂存0、git diff --check通过。
扫描覆盖服务商Key形态、长token、私钥、实际Bearer字面量和内嵌大段图片数据，仅输出路径/行号/规则，不输出匹配内容。
旧报告、Hook、KeyStore、preload、依赖及lock保持不变。模式扫描不等于对所有可能秘密格式的形式证明，已结合人工差异审查。

## 先前轮次交付结论（历史）

- CODE GATE: PASS（最终所有自动化命令退出0，保留历史失败）。
- WINDOWS ACCEPTANCE: PASS（本次设置和快拖修复已获用户实机确认；范围仅上述已测配置）。
- REAL API ACCEPTANCE: FAIL（修复前真实回答完整性未通过；真实双图有返回与可见部分复制通过；修复后真实终止语义未重测）。
- SECURITY REVIEW: PASS（限本轮审查范围；无已确认未解决的P0/P1问题，上传/存储/输入安全边界保留）。

最终决策：NEEDS FIX。已修复白边及确定的代码缺口，但整体稳定性验收仍保留真实回答中断和剪贴板偶发不一致的未定位项，不能宣称全部闭环。
下一步优先继续无费用复现剪贴板问题；若要重新验证模型完整终止，须新取得一次明确授权并由用户手动发送，当前不自动请求。

## AI Streaming 与 Windows Clipboard 最终稳定性审计

日期：2026-10-25（Asia/Shanghai）。工作区、分支及HEAD未变。专项开始时19文件全部保留；本专项未修改windowsFrame.ts、其既有测试、设置输入修复或窗口缩放实现。以下是最新结论，历史记录中的失败继续保留。

### A. AI回答中途结束

原始现象：真实GLM双图回答中途停止。该次没有finish_reason、HTTP状态或DONE记录；本专项真实模型调用0次，因此不能追溯认定它由1024 token、服务端、解析器或取消中的哪项导致。

审查的数据流为：

```text
明确上传确认 → Renderer askVision → 主进程身份/会话/快照检查
→ AiRequests准备Key/DNS/配置并复查快照 → 固定1024 token的chat/completions
→ HTTP响应 → UTF-8解码 → SSE事件 → JSON/业务错误检查
→ 可见content delta → finish_reason分类 → [DONE]
→ AiRequests结果 → 主进程单次done/error → Renderer退出generating
```

确认并修复的代码问题：

| 级别 | 确认的根因 | 修复位置 | 证据 |
|---|---|---|---|
| P2 | JSON损坏的数据帧被continue跳过；已有正文后仍可收到DONE并报告完整成功，造成静默缺文 | src/main/aiClient.ts:324 | 新用例修复前得到success，预期badResponse；改为明确失败并保留此前已显示正文，RED→GREEN |
| P2 | 显式未知finish_reason加DONE也可成功，不能证明正常完成 | src/main/aiClient.ts:316 | 独立RED→GREEN；未知值归为固定other，不输出任意服务端字符串，以badResponse终止；缺省/null原因仍兼容仅DONE的服务 |
| P2 | 主进程同ID终止后仍转发重复终止和迟到delta | src/main/explainWindow.ts:212 | done/error两条RED→GREEN；sink只接收仍在generating的当前请求，首个终止封闭后续事件 |

已有length提示和部分正文失焦保留均未撤回。停止、新请求、关闭继续使旧ID失效；主/渲染层都检查归属。
HTTP头只能在正文开始前确定；“已有正文后的服务端错误”以HTTP 200中的SSE error帧注入，不伪造一个后来变化的HTTP状态。

新增StreamDiagnostic注入观察接口仅返回一次冻结的内存元数据：模式、HTTP状态（已观察到时）、可见delta数/UTF-16字符数、stop/length/other/null类别、已处理DONE、取消/看门狗标记、固定错误码、输出上限标记和相对耗时。
既有ExplainEvent.id用于测试/主进程的请求关联。摘要不含URL、Key、请求头、图片、问题、正文、原始服务端错误或任意模型字符串。
真实app未安装观察器；未增加日志文件、调试端口、Renderer API或诊断IPC。观察器抛错不改变请求结果，例行finally清理abort不冒充用户Stop。

自动化覆盖：stop+DONE、length+DONE、length无DONE、正文后EOF、正文后网络异常、空正文、只有reasoning、无字节超时、本地字符上限、固定1024预算下服务端length、逐字节UTF-8/JSON/DONE、CRLF、多行data、坏JSON、未知finish、流式业务错误、重复终止、同chunk Stop后继续返回、早到done及旧请求晚于新请求结束。
实际Renderer→授权IPC→快照→AiRequests→客户端链路也覆盖length、坏JSON、断网和EOF，断言正文保留、提示正确、结束生成、只fetch一次且没有假done。

本专项没有扩大预算、自动续写、自动重试或新增模型服务。真实截断根因仍未获证实；真实终止完整性尚未重测。继续回答/可配置预算属于另行讨论的功能，不在本次实现。

### B. Windows Clipboard

审查结论：原复制确实在writeText Promise resolve后才提示成功，但存在跨操作/跨回答反馈竞态；窗口也可能在异步平台提交完成前销毁。

| 项目 | 失败条件与归因 | 修复/结果 |
|---|---|---|
| 旧成功提示残留 | 上次Copied不清空，下一次write尚未完成时仍显示成功，测试可能把旧提示当本次完成 | 新复制立即清提示、单次在途；序号/Promise结算/当前UI作为测试同步条件，未加固定sleep |
| 多次点击/回答替换 | 同时发起写入、旧回调可标记新回答，写入完成顺序不可控 | src/renderer/explain/main.ts:224捕获正文与epoch；跨新回答仍保持单次在途，旧回调不更新新回答，结算后才允许下一次手动复制 |
| 立即关闭 | 扩展原生矩阵3次立即关窗中1次仍读到20字符种子而非29字符目标，证明存在生命周期竞态 | src/renderer/explain/main.ts:195首次关闭立即停止生成、拒绝新提问，等待当前写入结算再关闭；再次关闭可取消等待。新增成功/拒绝/卡住三条回归；最终3次原生立即关闭均严格一致 |
| 同步异常/Promise拒绝/失焦 | 异常不能留下成功提示或永久禁用；真实无焦点写入返回NotAllowedError | 固定copyFailed、允许用户手动再次复制，无自动重写；真实无焦点用例保留种子并正确失败，不提升权限 |
| Windows换行格式 | 原生初测中多行/Markdown/长文本9个严格比对失败；全部差异是LF→CRLF，源文本没有改变 | 修正测试契约：精确校验传给浏览器的正文，再精确校验Windows原生CRLF字符串；不规范化实际读数、不放宽成模糊相等、不改产品正文 |
| 外部进程竞争 | 合成PowerShell写入发生于本程序提交之后，系统值自然是竞争者；先于本程序提交则最后是本程序值 | 两种顺序均受控验证。外部覆盖不是产品错复制；产品不循环抢回剪贴板 |

Windows原生格式CF_UNICODETEXT规定CRLF换行：[Microsoft规范](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats)。[W3C Clipboard算法](https://www.w3.org/TR/clipboard-apis/#write-content-to-the-clipboard)要求按平台约定处理换行。Electron当前readText/writeText都返回Promise：[官方API](https://www.electronjs.org/docs/latest/api/clipboard)。

新增tools/clipboard-smoke.cjs使用生产沙箱preload、真实renderer、隔离配置和合成回答。先写种子再读，不读取/备份原有用户剪贴板；输出只有序号、长度、时间、焦点、Promise/UI状态和匹配布尔值。
默认不读真实回答，也不存剪贴板历史。未采用主进程Clipboard作为产品备选，未增加IPC写权限或禁用sandbox。
仅合成夹具会暂停Promise以确定性构造交错；生产逻辑无sleep、轮询写入、自动重试或固定复制延迟。
应用退出、强制销毁、用户再次关闭取消等待时不保证未提交写入完成；测试没有把这些情况写成永久成功保证。

最终矩阵共33场景、30个合成回答、外部网络请求0：ASCII、中文/Emoji、LF多行、既有CRLF、Markdown、14000 UTF-16单元长文各串行3轮；Stop/Copy交替3次；快速点击；同回答串行复制3次；有/无焦点；两种外部进程交错；回答替换；立即关闭3次。
长文原生读数16000单元精确对应2000个LF增加的CR，源正文14000单元一致。10次同任务快速点击仅发起1次写入。

本专项可靠复现了复制/关闭的产品竞态、旧提示/回调竞态、换行比对的测试问题及可控外部覆盖。此前vision-smoke那次无换行Synthetic answer失败没有足够原始诊断，不能归因于换行，也不能声称新发现必然解释该次历史失败。
vision-smoke现在先写合成种子，核对复制源，再等本次成功且按钮恢复；不一致时只输出读取阶段、长度、焦点、序号、PID、耗时及二次匹配元数据，严格断言保留。

### C. 本专项最终矩阵与门禁

| 项目 | 状态 | 证据类型及范围 |
|---|---|---|
| AI正常结束 | PASS | 单元测试/Mock；正文、stop、DONE，单次终止 |
| AI length结束 | PASS | 单元测试/Mock；outputLimit且正文保留，不续写 |
| AI无DONE | PASS | 单元测试/集成Mock；badResponse，不能假成功 |
| AI网络中断 | PASS | 单元测试/集成Mock；network/timeout分类和部分正文保留 |
| Stop保留部分正文 | PASS | 真实客户端取消单测、Windows合成卡片；无收费Stop调用 |
| 复制短文本 | PASS | 实际WindowsClipboard，合成文本，3轮 |
| 复制中文和Emoji | PASS | 实际WindowsClipboard，合成文本，3轮 |
| 复制长文本 | PASS | 实际WindowsClipboard；14000→16000单元，仅规范CRLF变化 |
| 复制后关闭窗口 | PASS | 故障复现后修复；最终3次实际Windows立即关闭及Promise拒绝/取消等待回归 |
| 复制后的并发竞争 | PASS | 可控外部进程，两种顺序符合最后提交者语义；不抢占 |
| 真实回答完整性 | NOT TESTED | 本专项0真实API；前轮真实回答完整性FAIL继续保留 |
| 真实剪贴板一致性 | NOT TESTED | 本专项未复测真实模型正文；上述真实Windows合成矩阵PASS，前轮人工可见部分PASS保留 |
| Windows白边 | PASS | 本专项未改原修复；5932/5920px/s快拖，旧配置43732白像素→修复0；历史人工确认保留 |
| 设置输入 | PASS | 实际Fluent组件合成输入；中间编辑、旧回包、5次保存，前轮人工确认保留 |
| Vitest | PASS | 80文件1322项，比专项开始1285新增37，无删除测试 |
| Helper | PASS | 542 passed / 0 failed；恢复CL |
| TypeScript | PASS | npm run typecheck，退出0 |
| Build | PASS | npm run build，退出0，五个preload独立且无共享chunk |
| 全部冒烟 | PASS | 四项原冒烟与新增clipboard-smoke最终均退出0；33场景 |
| 安全扫描 | PASS | 见最终Git安全复核；仅任务文件、零暂存、无敏感模式命中 |

最终实跑退出码：typecheck=0、build=0、vitest=0、helper=0、vision-smoke=0、vision-ai-smoke=0、settings-input-smoke=0、window-resize-smoke=0、clipboard-smoke=0。
本专项早期失败记录保留：6项缺陷回归RED、未知结束原因RED、15项诊断接口缺失RED；剪贴板原生LF契约矩阵失败，以及扩展立即关闭矩阵1/3失败。修复后对应测试GREEN，最终未跳过断言。
15项诊断用例最初RED表示缺少所请求观察接口，不声称当时15种正常行为都存在产品故障。
Vitest新增37项分布：aiClient +1、aiRequest +1、aiTermination新16、explainWindow +6、explain renderer +13。
全量门禁后已再次npm run dev正常启动真实Windows应用，不启用调试端口、不调用模型。没有为了等待剪贴板而增加固定sleep。

### D. 当前Git交付清单

分支feat/p2a3-stability，HEAD仍为f2e1dbef34603e3ac47b8baa3cda4ce929e06b9c。
合计22文件：15修改、7新增、0删除、0暂存。包含此前19文件，本专项增加aiRequest测试修改、aiTermination测试和Clipboard冒烟这3个文件项。

```text
docs/design.md
docs/p2a-3-validation.md
src/main/aiClient.ts
src/main/explainWindow.ts
src/main/settingsIpc.ts
src/main/windowsFrame.ts
src/renderer/explain/explain.css
src/renderer/explain/main.ts
src/renderer/settings/components/AiConfigSection.tsx
src/shared/aiConfig.ts
src/shared/i18n.ts
tests/main/aiClient.test.ts
tests/main/aiRequest.test.ts
tests/main/aiTermination.test.ts
tests/main/explainWindow.test.ts
tests/main/settingsIpc.test.ts
tests/main/windowsFrame.test.ts
tests/renderer/explainMain.test.ts
tools/clipboard-smoke.cjs
tools/settings-input-smoke.cjs
tools/vision-smoke.cjs
tools/window-resize-smoke.cjs
```

精确暂存白名单：out/p2a3-final-audit/staging-allowlist.txt（22行）；仅准备，不执行git add。
最终安全复核命令node out/p2a3-final-audit/check.cjs退出0：22文件/15修改/7新增/0删除/0暂存，敏感模式命中0，git diff --check通过，受保护路径未变。
扫描涵盖服务商Key形态、长token、私钥、实际Bearer字面量与内嵌大段图片，并结合源码/新文件审查；不把合法authorization字段名视为秘密，也不把模式扫描当成所有秘密格式的形式证明。
建议提交标题：`fix(ai): stabilize streaming completion and clipboard behavior`。
out仅存夹具与交付准备资料，未列入暂存；无真实截图、模型回答或秘密。旧工作区、Hook、KeyStore、preload、依赖/lock、上传同意和HTTPS/DNS/TLS校验保持原样。
未commit、push、创建PR、merge、打包Release或删除工作区。

### E. 最终决策

INCONCLUSIVE。所有本专项确认的可复现产品缺陷均已修复，自动化及Windows合成矩阵通过，没有已确认未解决的P0/P1；但不能追溯认定那次真实GLM截断和无换行的历史answerCopyMismatch根因，也不能把缺失的真实终止证据补写成PASS。

代码门禁和已知缺陷修复达到可供提交审查的质量，22文件白名单已备妥；这是代码质量结论。
完整真实模型验收尚未闭环，是独立的验收范围。真实API调用授权在本专项为0；如后续确需验证，只能取得新的单次明确授权后手动发送。
当前无需用付费调用来重复证明Mock覆盖，也不把未定位历史偶发问题伪造为已解决。下一次若自然复现，应先保留本次已有的安全阶段/终止/复制元数据，再作归因。

## Git交付状态（最终提交前核查，2026-10-25）

本章为本次授权交付的提交前快照；上文1322项与INCONCLUSIVE是专项历史记录，未删除或重写为真实API成功。

- 仓库：0xAlchemist-cs/lolping-ai；分支feat/p2a3-stability，目标main。
- 提交前HEAD：f2e1dbef34603e3ac47b8baa3cda4ce929e06b9c。重新fetch确认origin/main相同，分叉计数0/0；同名远程功能分支尚不存在。
- 唯一范围仍为22文件：15修改、7新增、0删除；提交前0暂存。白名单out/p2a3-final-audit/staging-allowlist.txt，不包含out或真实屏幕/模型数据。
- 本轮明确授权Commit、Push、创建PR及检查CI；不授权合并、Release、删除分支/工作区或真实付费API调用。

### 最后差异审查

Standards：读取22文件及7个新增文件全文，按AGENTS.md、docs/design.md检查跨平台、双语、输入、安全与范围约束；无必须行动的硬规范违规，无P0/P1发现。
Spec：独立需求审查复现一条P2边界：正文→未知finish_reason→stop→DONE会用后续stop覆盖other，并误报成功。
在原白名单内最小修改aiClient.ts，使other保持到请求结束；aiTermination.test.ts新增同序列回归，实际RED（得到成功而预期badResponse）→GREEN（17项）。审查者再次以内存合成流独立重放，结果badResponse、finishReason=other。
完成复审后无仍未解决的确定性可行动发现。早先两个子审查任务曾因额度中断，恢复后均完成；不把中断状态当审查通过。
复制关闭等待、第二次关闭取消等待、失败后手动复制、旧回调隔离均保留。DWM固定数字参数/PID检查与跨平台跳过、5秒有界失败降级、销毁后的显示归属检查均保留；这不证明所有原生窗口/硬件组合。

### 本轮实际重新执行

| 门禁 | 退出码 | 本轮结果与证据范围 |
|---|---|---|
| npm run typecheck | 0 | PASS |
| npm run build | 0 | PASS；五个独立preload，无共享preload chunk |
| npx vitest run | 0 | PASS；80文件1323项，较前轮新增1项回归，未减少 |
| npm run test:helper | 0 | PASS；542 passed / 0 failed；finally恢复CL；执行前本项目无开发实例占用 |
| node tools/vision-smoke.cjs | 0 | PASS；Windows受控合成截图、轮盘、排除/恢复、部分回答/Stop/复制与沙箱preload；捕获作用域外部请求/文件写入0 |
| node tools/vision-ai-smoke.cjs | 0 | PASS；6次Mock，精确单/双图与文字隔离、终止/取消；外部请求0 |
| node tools/settings-input-smoke.cjs | 0 | PASS；实际Fluent组件的合成输入与5次保存，AI调用0 |
| node tools/window-resize-smoke.cjs | 0 | PASS；旧配置5956px/s、45046白像素；单窗口修复5920px/s、0白像素，nativeDarkFrame=1 |
| node tools/clipboard-smoke.cjs | 0 | PASS；33场景、30个合成回答、外部请求0；三次立即关闭均严格一致 |

五项smoke串行运行，避免焦点/剪贴板互相干扰。它们是Mock或Windows合成场景，不能替代新一轮物理手势/真实模型验收。
白边适用范围保持当前Windows 11、单显示器125%、system主题；先前用户真实快拖确认仍有效，但不外推到其他DPI/多屏或macOS/Linux视觉实机。
真实模型历史截断和此前无换行answerCopyMismatch均没有足够原始证据追溯归因；复制/关窗竞态、旧提示/回调和Windows CRLF契约等已确认缺陷已有修复与回归证据，两类结论分开。
本轮真实API请求0，不沿用历史授权，不扩大1024 token预算，不自动续写/重试。真实模型结束与复制复验、真实Stop/Retry仍NOT TESTED。
DNS预解析不等于固定连接地址，Electron/DWM截图同步、受保护/全屏内容与多显示器边界继续保留。

### 安全、暂存与交付边界

提交前及暂存后分别扫描22文件全文，包括7个新增文件；仅报告命中规则/位置，不输出匹配内容。合法authorization字段名与实际凭据区分。
无新增网络目的地、Key存储、任意Clipboard IPC、依赖或Hook修改；sandbox/contextIsolation、原有TLS/DNS/HTTPS校验及明确确认截图上传保持不变。
白名单、英文PR草稿和提交后SHA/PR/CI记录位于忽略的out/p2a3-final-audit，不随代码暂存。报告内不写自身提交SHA，避免为自引用再追加提交；最终SHA、PR链接及CI以实际提交后Git/GitHub核查和交付答复为准。

CODE GATE: PASS

KNOWN REPRODUCIBLE BUGS: FIXED

HISTORICAL INCIDENT ROOT CAUSE: INCONCLUSIVE

REAL MODEL TERMINATION RECHECK: NOT TESTED

REAL MODEL COPY RECHECK: NOT TESTED

## 真实 AI 终止与 Clipboard 遗留问题追踪

本节为2026-10-25的PR #5合并前增量调查。起始分支feat/p2a3-stability，HEAD
fed5cb483b6d7b08d8dbbc861ce2633b20d6fa8a，起始工作区干净。上文交付和历史验收仍为各自阶段记录。
本轮不合并、不提交、不推送，不调用真实AI；没有沿用历史付费授权。

### A. 已确认问题与修复

1. 观测接线缺失：aiClient已有StreamDiagnostic，但AiRequests和index真实入口未传入观察器。
   tests/main/aiRequest.test.ts:30实际RED为请求成功但摘要0条；修复后同一路径收到唯一摘要。
   src/main/aiRequest.ts:26透传观察器并覆盖准备阶段失败；:72的createExplainAsk供index.ts:402和集成检查共同使用，
   固定1024预算不变。摘要总耗时包含准备；HTTP尚未发生时保持status=null、stage=prepare。
2. 原有摘要不能区分两种timeout及取消来源。aiClient.ts:27补齐stage、sseEvents、timeoutKind和cancelSource，
   保留原有完成/异常判定；reason只允许user/window/replaced/other，不序列化任意AbortSignal.reason。
   aiTermination.test.ts先复现缺字段，再通过定向矩阵；idle和total分别使用假时钟验证。
3. Close到原生closed存在取消空隙：让窗口close延迟，正文后点击Close再让服务端返回DONE，旧代码仍得到ok=true。
   tests/main/explainWindow.test.ts:246已实测RED。explainWindow.ts:152在授权Close IPC立即隔离旧ID并cancel(window)，
   无需等待原生销毁；同一用例GREEN。未改变等待在途复制完成再销毁Renderer的既有行为。
4. 之前没有实际UI终态证据。新增仅开发环境的可选状态回报，main.ts:68报告已应用的state/正文长度/按钮状态，
   explainWindow.ts:145校验owner主frame、当前接受的ID、字段/枚举/长度及重复phase；不接收文本、图片或任意日志。

日志基础设施先行检查：现有main使用console，未发现electron-log、AI文件日志或自动持久化AI日志的接线。
复用StreamDiagnostic；没有独立追踪服务或正文缓存。aiDiagnostics.ts:19默认关闭，只有非packaged进程显式设置
LOLPING_AI_DIAGNOSTICS=1才输出[ai-diagnostic]选定元数据；生产打包忽略开关，设置探测不装观察器。
没有增加端口、主机或文件日志。终端/宿主可能留存console，因此摘要仍严格排除问题、答案、URL、Key、请求头、
图片/Base64、服务端原始错误；不要求重输Key。原生合成夹具主动启用该开关逻辑，真实应用本轮保持默认关闭。

### B. 调用链和状态表

| 阶段/输入 | 成功/失败与转换 | 重复、正文保留和观测边界 |
|---|---|---|
| Renderer问题有效且非generating | 清空本次正文，进入generating；输入空白或忙时不发起 | epoch隔离旧结果；获得接受ID后报告started，不记录输入 |
| Explain IPC | 主frame授权、问题校验；视觉还需用户确认及当前可信快照 | 拒绝未授权/失效请求不调用客户端，也不伪造流摘要 |
| AiRequests准备 | 配置/Key/DNS准备后再次检查取消、快照、目的地 | 准备失败一条stage=prepare固定错误；未开始HTTP时status=null |
| HTTP发起 | 等待一次POST，无自动重试；200后读取body | status记录已知整数；取流前异常stage=http；不记录响应体/请求头 |
| HTTP 200后读失败/正文后断网 | network，stage=sse，DONE=false | 已发正文保留，Renderer error且可复制；不会冒充正常完成 |
| 正文后损坏JSON | badResponse，计入已处理SSE事件 | 不跳过损坏帧；部分正文保留；不输出原始帧 |
| stop + DONE + 正文 | 成功done | finishReason=stop/DONE=true；协议完成不能证明语义完整 |
| length + DONE | outputLimit，保留正文并显示上限提示 | UI done但有明确warning；诊断outputLimited=true/errorCode=outputLimit |
| 正文 + DONE但无finish_reason | 有意保留的兼容成功 | finishReason=null明确可见；不能推断模型结束原因，不新增严格拒绝 |
| 正文EOF/只有finish但没有DONE | badResponse | DONE=false，不把读到EOF当作健康结束；不丢已显示正文 |
| 未知finish_reason | other + badResponse | 后续stop不能覆盖other；不打印服务端任意reason字符串 |
| idle/total等待超时 | timeout，区分timeoutKind | 原默认30s/180s未变；取消底层等待；假时钟验证，无固定sleep掩盖 |
| Stop/Close/替换请求 | aborted + allowlisted cancelSource | 本地ID隔离迟到事件；Close IPC即取消，不等原生closed |
| Result → IPC | 一个done或固定code error，sink结束generating | main只转发当前活跃ID，第一个终止封口，后续事件丢弃 |
| IPC → Renderer | 先缓存invoke前早到事件，再按ID应用；进入done/error | 回报实际state、正文UTF-16长度、sendDisabled/stopVisible；测试验证退出generating |
| Renderer无终态回报/提前销毁 | 终态未知，不能补写done | stream摘要与UI回报按id关联；缺失回报是观测缺口/销毁边界，不能猜服务商行为 |
| 模型自行短答或提前自然结束 | 可能仍为stop+DONE | 仅凭协议元数据不能判断是否满足用户问题；语义需用户检查 |

### C. 输出预算与官方协议核查

本轮阅读[官方Chat Completions文档](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)、
其官方Markdown/OpenAPI展开版（同路径加.md）、[核心参数](https://docs.bigmodel.cn/cn/guide/start/concept-param#max_tokens)
和[流式消息](https://docs.bigmodel.cn/cn/guide/capabilities/streaming)，仅文档GET，无认证、无模型API。
max_tokens限制生成输出而不包含输入；官方参数表列出glm-5.3-flash支持此参数，视觉schema亦列出该模型。
流式文档区分delta.content和reasoning_content，finish_reason位于末chunk，并以data: [DONE]结束。
官方展开schema解释stop为自然结束/停止词，length为token长度限制；还列出工具、安全、模型推理异常等原因。
客户端继续将不支持的reason归other/badResponse，不把服务端network_error冒充本地传输network。

应用文字/视觉回答都显式使用1024，设置连接测试为1；模型文档默认值不会覆盖显式预算。
Mock已验证1024随请求发出以及length+DONE、stop+DONE、无reason+DONE、正文无DONE的不同UI结果。
length+DONE可证明服务报告达到token长度限制；没有真实usage不能声称历史正文恰好用了1024 token，
也不能推断本次思考/可见正文预算分配。未提高预算、改变思考参数、自动续写或重试。

### D. 本轮实际自动化与原生证据

| 命令 | 退出码 | 本轮结果 |
|---|---|---|
| npm run typecheck | 0 | PASS；最终生产修复后执行 |
| npm run build | 0 | PASS；五个独立preload，无shared preload chunk |
| npx vitest run | 0 | PASS；81文件1341项，原有测试未删除 |
| npm run test:helper | 0 | PASS；542 passed/0 failed；finally恢复CL，helper源码未改 |
| node tools/vision-smoke.cjs | 0 | PASS；Windows合成桌面，沙箱preload、轮盘、预览、Stop/复制、outputLimit；捕获作用域外部请求/文件写入0 |
| node tools/vision-ai-smoke.cjs | 0 | PASS；6次Mock，单/双图精确批准字节、纯文字无图、取消/迟到隔离；外部请求0 |
| node tools/settings-input-smoke.cjs | 0 | PASS；实际Fluent合成输入，5次保存，AI调用0 |
| node tools/window-resize-smoke.cjs | 0 | PASS；5956px/s，旧配置45283白像素，修复配置0；单窗口DWM仍有效 |
| node tools/clipboard-smoke.cjs（第1轮） | 0 | PASS；33场景、30合成回答、0失败、外部请求0 |
| node tools/clipboard-smoke.cjs（第2轮） | 0 | PASS；33场景、30合成回答、0失败、外部请求0 |
| node tools/ai-diagnostics-smoke.cjs | 0 | PASS；实际sandbox卡片/preload/IPC/createExplainAsk/AiRequests/runChat；8次Mock、外部请求0 |

原生诊断8场景：stop+DONE、length+DONE、正文+DONE无reason、正文EOF、正文后network、正文后损坏JSON、Stop、Close。
全部得到唯一stream摘要和对应ID的已应用UI回报；Stop/Close的迟到DONE不复活请求。文字路径使用实际生产入口；
双图集成测试同样复用createExplainAsk，逐字节核对可信图片并核对SSE→UI摘要。开关关闭、packaged强制关闭、
观察器抛错不影响请求、外部/旧ID/重复/额外字段报告拒绝均有定向验证。
这证明本地真实调用链可观测，不冒充真实智谱HTTP响应或实际请求抓包。

新增原生脚本初期有夹具错误：漏传页面服务参数、连续重开窗口未等销毁；随后使用同一实际卡片串行运行并保留
有界等待/固定阶段失败信息。中途失败不计PASS；最终退出0。Close取消空隙则另有独立RED→GREEN产品回归，二者分开。
本轮也按仓库要求以诊断默认关闭启动npm run dev，main/preload和本机renderer服务启动成功；不输入/发送AI问题。
随后经本项目托盘正常退出，开发进程退出0；未强杀、切换分支或更改用户配置。

Clipboard：用户明确同意测试期间不使用剪贴板后，保留原33场景，有限串行运行2轮，共66场景、60个合成回答、0失败。
Windows 11 build26100、当前显示器125%、Electron44.5.1、生产sandbox renderer；每次读取前写入已知种子，未读旧剪贴板。
验证正文快照、await写入完成再读取、清空旧提示、CRLF/Unicode/长文、焦点丢失、两种外部写入顺序、重复点击、
回答替换时的在途复制与立即关闭。外部写入在本应用提交后可以合法覆盖；不是本应用能永久占有剪贴板。
没有无限循环、自动复制重试或后台占用，未记录真实剪贴板历史。测试结束后可正常使用剪贴板。
合成检查仍不能证明历史无换行answerCopyMismatch的唯一根因。当前未复现，不标记历史事件已修复。

### E. Git与边界

相对fed5cb4的本轮完整修改清单（13修改、3新增、0删除；未暂存）：

```text
M docs/design.md
M docs/p2a-3-validation.md
M src/main/aiClient.ts
M src/main/aiRequest.ts
M src/main/explainWindow.ts
M src/main/index.ts
M src/preload/explain.ts
M src/renderer/explain/main.ts
M src/shared/ipc.ts
M tests/main/aiRequest.test.ts
M tests/main/aiTermination.test.ts
M tests/main/explainWindow.test.ts
M tests/renderer/explainMain.test.ts
A src/main/aiDiagnostics.ts
A tests/main/aiDiagnostics.test.ts
A tools/ai-diagnostics-smoke.cjs
```

out/p2a3-stream-audit只保留本轮合成smoke元数据，不加入提交；无真实图片/回答/秘密。Hook、windowsFrame白边修复、
KeyStore、Quick Actions、lock/依赖、HTTPS/DNS/TLS和截图确认策略未改。未关闭sandbox/contextIsolation。
本轮仅新增受主frame/ID/shape约束的开发诊断IPC，无任意clipboard写入能力。建议下一次获得交付授权后，以
fix(ai): wire safe stream diagnostics and cancel on close追加到PR #5，不覆盖既有提交；本轮不执行Git写操作。
最终安全扫描覆盖16个修改/新增文件全文：服务商Key形态、长sk-token、私钥、实际Bearer字面量、内嵌长图片匹配0，
无大于512KiB的意外文件、受保护路径改动0；git diff --check退出0。模式扫描不代替源码审查，也不保证识别所有秘密格式。
最终HEAD仍为fed5cb483b6d7b08d8dbbc861ce2633b20d6fa8a，13修改/3新增/0删除/0暂存；本轮增量均留在该工作区。

### F. 零 API 阶段决策与单次真实验收准备

CODE GATE: PASS

SSE DIAGNOSTIC READINESS: PASS（本地真实入口+合成流；真实服务验证尚未执行）

CLIPBOARD STABILITY: PASS（本轮66个合成场景；历史根因仍INCONCLUSIVE）

REAL GLM ACCEPTANCE: NOT TESTED（本轮真实请求0）

PR #5 MERGE READINESS: PENDING INVESTIGATION ACCEPTANCE（保留OPEN，不合并；本轮增量尚未提交/推送）

历史GLM中途结束和answerCopyMismatch不可追溯；没有发现尚未修复的确定性P0/P1。新一轮真实终止和复制仍NOT TESTED，
真实Stop/Retry、非Windows视觉实机、多屏/其他DPI仍NOT TESTED。DNS预解析不固定实际连接地址、截图同步/受保护全屏
内容和外部剪贴板软件限制继续保留。

下一步先申请新的单次明确授权（可能计费），获准后才能启用本地开发诊断并沿用现有GLM配置，不读取Key文件。
由用户打开无隐私的人工测试画面，Alt拖动问号→本地预览，保持默认局部图；只点击一次发送，问题为：
“请描述局部截图，列出8条简短观察，最后写‘检查结束’。看不清就说明，不要猜测。”
不点测试连接、不重试、不自动续写；采集上述固定摘要，不抓包、不保存真实图片/答案。结束后用户点击复制，
在记事本核对可见回答，仅报告一致与否。按同一id核对HTTP/SSE/reason/DONE/outputLimit/timeout/cancel/UI，
缺记录则继续查本地链路，不推断服务商。一次未覆盖目标时不追加第二次请求。

LOCAL DIAGNOSTICS READY — REAL API VERIFICATION REQUIRES USER APPROVAL

### G. 单次授权后的真实终止验收（2026-10-25）

本节更新F节之后的进展，不回写零API阶段及更早历史结论。用户新近明确授权最多1次，由用户本人手动发送。
以LOLPING_AI_DIAGNOSTICS=1启动当前开发工作区，沿用现有GLM配置；未读取或打印Key，未开启调试端口。
测试方案为默认局部截图，用户经应用界面手动发送；没有由代理调用模型API、测试连接、自动重试或续写。
本次观测到1个真实vision请求（本地id=2），请求预算已用完。未抓取请求体，不将诊断摘要当成抓包证据。
域名/模型核对在用户界面操作步骤中要求；摘要设计不包含目的地身份，本节不声称独立抓包核验了服务商/模型。

同一本地id的实际脱敏证据：

| 观测点 | 实际记录 |
|---|---|
| Renderer开始 | phase=started，state=generating，characters=0，sendDisabled=true，stopVisible=true |
| 客户端阶段/HTTP | mode=vision，stage=sse，httpStatus=200 |
| 已处理事件 | sseEvents=1009，deltaCount=248，characters=393（可见正文UTF-16单位） |
| 服务终止 | finishReason=length，doneSeen=true，outputLimited=true |
| 错误/取消/超时 | errorCode=outputLimit，aborted=false，cancelSource=null，timeoutKind=null |
| 总耗时 | elapsedMs=22364（含准备） |
| Renderer最终 | phase=terminal，state=done，characters=393，sendDisabled=false，stopVisible=false |
| 用户界面 | 用户报告看到输出token上限警告，部分回答保留；未完成所要求的完整观察列表/结尾 |
| 真实复制 | PASS（用户点击应用复制并在记事本核对，明确报告“复制一致”；不是代理读取真实剪贴板后的自动断言） |

结论：本次服务明确报告token长度限制，并以DONE终止；客户端显示上限警告，保留部分正文且退出generating。
已观察到的终止不属于本地network/idle timeout/total timeout/用户取消，UI没有一直停在生成状态。
客户端和Renderer的393单位长度一致，是已显示长度的证据，不是逐字抓包核对或独立语义完整性证明。
事件总数包括非可见内容及终止事件；未逐帧记录内容，不能将1009与248的差额全部归因于思考事件或正文丢失。
仍保持请求max_tokens=1024；没有采集usage，不能声称精确输出token计数或思考与可见正文的预算占比。
本次已定位的输出上限不能推断为更早不可追溯截断事件的原因。

本节仅保存固定状态、计数和用户核对结论。用户回复中附带的真实正文未复制进仓库、诊断文件或测试夹具；
不保存截图、答案、Key、请求头或完整服务端响应。真实API总数1，不增加第二次请求。
本次诊断进程在证据读取完毕后通过本项目托盘正常退出，开发开关仅设于该子进程，不写入用户配置。
正文复制核对之后没有再进行系统剪贴板测试或写入，合成66场景结果仍引用D节，未伪称本轮重新跑过。
本阶段没有改生产代码或测试代码；1341项Vitest、542项helper、构建及各smoke引用前一阶段实际执行结果。

CODE GATE: PASS（前一阶段结果，代码未再改动）

SSE DIAGNOSTIC READINESS: PASS（本地链路与本次真实请求都收到同id的终止及已应用UI回报）

CLIPBOARD STABILITY: PASS（66个合成场景；另有本次真实复制用户核对PASS；历史根因仍INCONCLUSIVE）

REAL GLM ACCEPTANCE: PASS（单图返回、length+DONE分类、退出生成和用户复制核对；不表示回答完整）

PR #5 MERGE READINESS: READY FOR INCREMENTAL REVIEW（本轮修复仍未提交/推送；不授权或执行合并）

REAL DUAL IMAGE: NOT TESTED（本次未补测）

REAL COPY: PASS（本次用户核对）

REAL STOP: NOT TESTED

REAL RETRY: NOT TESTED

非Windows视觉实机、多显示器/其他DPI仍NOT TESTED；历史事件根因和既有DNS/截图同步/外部剪贴板竞争限制保留。
如需要更长回答，应另行审议输出预算设置；本轮不擅自提高1024或自动续写。

### H. 用户后续授权：可调8192预算与回车提交（2026-10-25）

G节验收后，用户提出输出上限及问题框无法回车提交，并明确选择“设置中可调，默认8192 token”。
这是新的产品调整授权，取代前一排障阶段保持1024的约束；不授权额外付费调用或Git提交/合并。
G节真实length+DONE及393正文单位是在旧1024预算下取得，不能拿来证明8192预算的真实服务效果。

实现：

- Settings → Features → AI新增“输出token上限”，可选1024/2048/4096/8192/16384，默认8192。
  src/shared/aiConfig.ts:24集中定义选项和归一化；settings.ts对旧配置补默认值，对非法/不支持值回退8192。
  不改变已有地址、模型、Key存储或其他设置。中英文说明提示较高预算可能增加费用，服务商及本地限制仍适用。
- createExplainAsk从主进程设置读取当前预算，提交时冻结，文字/视觉共用；设置变化影响下一次提交。
  连接探测仍为1 token，无自动续写/重试，原20,000正文单位、idle/total等保护未放宽。
- src/renderer/explain/submitKey.ts统一单行问题框的Enter行为；main.ts和visionPreview.ts均接入。
  输入法确认（isComposing/Windows229）、repeat及组合键不发送。预览Enter调用原submit，保留图片加载、
  过期、scope、可信快照及confirmed检查；不会因键盘操作静默重拍或扩大上传范围。不修改全局Hook。

RED→GREEN：四条断言先失败，分别观察到默认预算仍1024、设置缺预算字段、文字Enter和视觉Enter均未调用发送。
修复后回归通过；视觉用例同时验证未加载/输入法/repeat/过期不发送，重复Enter只消费一次已确认快照。

| 本次重新执行 | 退出码 | 证据 |
|---|---|---|
| npm run typecheck | 0 | PASS |
| npm run build | 0 | PASS；五个独立preload，未生成共享preload chunk |
| npx vitest run | 0 | PASS；81文件1344项 |
| npm run test:helper | 0 | PASS；542 passed/0 failed；finally恢复CL |
| node tools/settings-input-smoke.cjs | 0 | PASS；实际Fluent组件、6次合成保存；默认8192→选择4096→页面重新加载后仍为4096；AI调用0 |
| node tools/ai-diagnostics-smoke.cjs | 0 | PASS；9次Mock均实际检查max_tokens=8192；真实sandbox卡片+原生Enter事件覆盖文字和局部图发送 |
| node tools/vision-ai-smoke.cjs | 0 | PASS；6次Mock，精确单/双图、文字无图片、取消与迟到隔离，外部请求0 |

原生Enter视觉检查只使用预置可信合成JPEG，不捕获/写入真实屏幕；请求中精确核对仅有批准的1张图片。
设置与客户端Mock证明配置保存/传递，不冒充8192预算真实模型验收。未额外运行会覆盖系统剪贴板的smoke，
不覆盖用户刚核对的真实复制内容；66场景和白边实测仍引用前一阶段结果。更新版随后以诊断关闭方式npm run dev启动，
供用户使用设置和键盘操作；代理没有发送问题。本次额外真实API请求0，整个受控真实阶段累计仍1。

相对fed5cb4完整工作区清单更新为21修改、4新增、0删除、0暂存（25文件）：

```text
M docs/design.md
M docs/p2a-3-validation.md
M src/main/aiClient.ts
M src/main/aiRequest.ts
M src/main/explainWindow.ts
M src/main/index.ts
M src/preload/explain.ts
M src/renderer/explain/main.ts
M src/renderer/explain/visionPreview.ts
M src/renderer/settings/components/AiConfigSection.tsx
M src/shared/aiConfig.ts
M src/shared/i18n.ts
M src/shared/ipc.ts
M src/shared/settings.ts
M tests/main/aiRequest.test.ts
M tests/main/aiTermination.test.ts
M tests/main/explainWindow.test.ts
M tests/renderer/explainMain.test.ts
M tests/renderer/visionPreview.test.ts
M tests/shared/settings.test.ts
M tools/settings-input-smoke.cjs
A src/main/aiDiagnostics.ts
A src/renderer/explain/submitKey.ts
A tests/main/aiDiagnostics.test.ts
A tools/ai-diagnostics-smoke.cjs
```

CODE GATE: PASS（本节列出的本轮门禁）

REAL 8192 BUDGET: NOT TESTED

原有1次真实终止与用户复制证据保留，真实Stop/Retry、真实双图复验及多平台/多屏范围不扩张。
本轮增量仅供审查与本机使用，未commit/push/merge，不把旧22文件暂存白名单套用于当前25文件改动。
最终安全复核覆盖25文件，敏感模式命中0；Hook、KeyStore、windowsFrame、visionSnapshot、依赖与lock改动0，
git diff --check退出0，HEAD仍为fed5cb483b6d7b08d8dbbc861ce2633b20d6fa8a。

### I. 最终提交前复核与增量交付准备（2026-10-26）

按用户最新授权，先完成8192配置与Enter回归、最终差异审查，再提交同一功能分支、推送并更新PR #5，检查三平台CI。
本节是提交前快照；新提交SHA、推送和CI结果由忽略的out/p2a3-increment-delivery交付记录及最终答复记录，不为自引用追加提交。
提交前HEAD仍为fed5cb483b6d7b08d8dbbc861ce2633b20d6fa8a；PR #5核实为OPEN、非合并、源分支相同且指向该旧SHA。

独立Standards/Spec初审识别两项证据缺口（磁盘重启恢复、IME原生表单旁路）及当前设计文档的两处旧表述。
设置恢复测试现使用独立合成目录：旧配置缺字段→load得到8192→flush落盘→新建SettingsStore再次load恢复8192；
随后保存4096/16384并分别重建存储，实际createExplainAsk→AiRequests→Mock HTTP请求的max_tokens依次8192/4096/16384，
连接探测仍为1。原地址、模型和其他设置字段保持，非法值及允许边界继续由归一化回归覆盖。

IME原生复现确认了新的确定性缺陷：compositionstart=1、compositionend=0、可信Enter的isComposing=true，
keydown快捷处理已跳过，但普通问题框原生form仍触发submit=1并发起1次Mock请求。
定向单元测试同样RED；修复main.ts的composition生命周期和隐式submit锁存，直到新的明确按键/按钮操作才解锁。
隐式候选click（detail=0、焦点仍在问题框）不解除阻止；实际指针点击或按钮焦点下的键盘激活可以恢复。
预览问题框也跟踪composition生命周期，仍经原有sendState/submit授权检查发送。没有修改Hook或增加全局快捷键。

修复后实际Chromium合成composition及可信Enter序列GREEN：普通框仍观测到form默认事件，但不产生请求；
截图框候选确认无请求；compositionend后Enter或明确鼠标点击可以提交。长按Enter及模型生成中重复Enter不追加请求。
该工具仅在隔离的合成卡片上使用Electron进程内调试协议输入通道，不开放调试端口，不附加实际应用或启用Network域。
它验证Chromium输入事件及默认表单行为，不冒充用户物理操作系统输入法候选窗口验收。截图路径精确核对1张可信合成JPEG，
不读真实屏幕、Key或剪贴板，未扩大上传scope；主进程独立同意/会话/快照校验保留。

修正文档中的“只能点击发送”及“没有新增设置”表述。第一次修复后子代理复审曾因额度中断，不计作通过；恢复后重新完成
两项独立只读终审：Standards 0项可行动发现；Spec 0项可行动发现。主代理另行检查全部差异与新增文件。

本轮最终实际执行（不是重复引用H节）：

| 门禁 | 退出码 | 结果 |
|---|---|---|
| npm run typecheck | 0 | PASS |
| npm run build | 0 | PASS；五个独立preload，无共享chunk |
| npx vitest run | 0 | PASS；81文件1345项，新增IME form旁路RED→GREEN |
| npm run test:helper | 0 | PASS；542 passed/0 failed，finally恢复CL |
| node tools/settings-input-smoke.cjs | 0 | PASS；6次合成保存，实际Fluent设置控件与重新加载恢复 |
| node tools/ai-diagnostics-smoke.cjs | 0 | PASS；10次Mock、外部请求0；composition、长按、生成中Enter、明确按钮、批准局部图、length提示与UI终态 |
| node tools/vision-ai-smoke.cjs | 0 | PASS；6次Mock、外部请求0；单/双图批准字节、文字无图、取消与迟到隔离 |
| npm run dev | 0（正常托盘退出） | PASS；Windows启动main/preload/renderer，诊断关闭，没有提交模型问题 |

本轮不重新占用系统剪贴板；Clipboard 66场景及白边/本地capture实机合成结果仍为此前阶段证据，未假称重新执行。
本轮真实模型请求0；G节旧1024预算下单次真实length+DONE及用户复制核对PASS保留。真实8192、双图复验、真实Stop/Retry、
非Windows视觉实机及其他DPI/多屏继续NOT TESTED；不将它们自动等同于代码阻塞，也不把历史不可追溯根因改为已确认。

本次仍恰好H节列出的25个文件（21修改/4新增/0删除），未加入其他工作区、out、Key、截图、日志或构建产物。
新增白名单out/p2a3-increment-delivery/staging-allowlist.txt只用于这25个文件，取代旧22文件交付白名单；
该25是相对fed5cb4的增量数量，不是声称整个PR只包含25个文件。暂存前/后分别核对精确路径、敏感模式、大小和diff --check。
native Hook、KeyStore、windowsFrame、visionSnapshot、依赖/lock保持未改；保留sandbox、TLS/DNS/HTTPS、上传确认及已有稳定性修复。

CODE GATE: PASS

FINAL DIFF REVIEW: PASS

GO FOR INCREMENTAL COMMIT（推送和PR新head CI仍以实际执行后的记录为准；不合并）
