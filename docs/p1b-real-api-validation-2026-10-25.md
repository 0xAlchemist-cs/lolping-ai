# P1B 真实 API 与 P2A-1 回归验收

日期：2026-10-25（Asia/Shanghai）。最新结论：连接及真实文字回答已通过，SSE 细分事件、停止、复制和重试仍有 **NOT TESTED** 项。

智谱配置和密钥已通过应用设置界面保存，完全退出并重启后配置仍可用。最初两次自动验收请求均返回 HTTP 429；第二次取得业务码 **1314**，官方定义为企业套餐失效，该结果保留为历史记录。用户随后报告连接恢复，本次通过 Windows UI Automation 直接读到设置页「服务已应答。」。用户又提供了实际 AI 卡片中的模型回答，因此真实文字回答已通过；没有将 Mock、合成触发或最终文字内容冒充 SSE 事件验收。

## 配置与安全

- 服务商域名：`open.bigmodel.cn`。
- Base URL：`https://open.bigmodel.cn/api/paas/v4`。
- 模型 ID：`glm-4-flash-250414`，官方文档列出的免费文本模型，支持流式输出。
- 请求路径由现有客户端追加 `/chat/completions`。
- 设置界面状态：`encryptionAvailable=true`、`hasKey=true`、`configured=true`。
- Base URL、Model 通过实际设置控件填写；用户随后明确授权使用测试密钥，由临时本机控制器键入应用密码框并点击保存。输入未回显，未使用剪贴板，密钥未写入源码、测试、环境配置、日志或本报告。
- 没有读取或展示加密密钥文件；仅通过应用公开的状态接口检查存在和配置布尔值。
- 保存后密码框清空，除 AI Base URL 和模型外的设置比较保持一致。密钥保存继续使用已有 safeStorage/Windows DPAPI 路径。
- 开始验收前进程检查未发现 Electron 或 hook-helper 在运行。验收启动的是 P2A，未修改旧工作区，也未同时启动 P1B。

官方依据：[OpenAI 兼容接口](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)、[模型说明](https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414)。

## 实际请求与费用控制

| 次数 | 来源 | 模型 | 参数摘要 | HTTP | 脱敏结果 |
|---|---|---|---|---|---|
| 1 | 设置页点击现有测试连接按钮 | glm-4-flash-250414 | stream=true，max_tokens=1，1 条纯文本消息 | 429 | 现有客户端归类 rate；首个响应未保留业务错误码 |
| 2 | 实际 Explain 卡片发送指定短问题 | glm-4-flash-250414 | stream=true，max_tokens=1024，1 条纯文本消息 | 429 | 业务码 1314；企业套餐失效；回答长度及 delta 事件数均为 0 |

第 2 次发送的问题为「请只回复：lolPing AI 测试成功」。该卡片由明确标记的合成 reportPing 打开；这是实际应用、真实请求与真实服务端响应，但不是物理 Alt + 拖动的证据。

最初自动控制的 API 请求为 **2 次**。本次重测在读取成功状态后，用户又提供了实际模型回答，因此自动新增请求为 **0 次**，没有重复发送短问题。用户后续自行成功测试连接及问答的调用数未全程观测，全程总数不再宣称精确为 2。没有执行自动连接循环、高并发、压力测试、模型切换或其他服务商调用。最初两次观察到的 messages.content 都是字符串；本地截图没有进入 API 请求。

1314 的官方分类见：[智谱错误码](https://docs.bigmodel.cn/cn/api/api-code)。HTTP 429 本身不能证明只是短时速率限制，需结合业务码。该码是历史失败证据，不再用于描述用户后续已成功的连接和文字回答；后续成功请求的具体 HTTP 状态码未采集。

## 验收矩阵

| 项目 | 状态 | 证据 |
|---|---|---|
| API Key 安全保存 | PASS | 实际密码框保存；系统加密可用；密码框随后清空；重启后 hasKey=true；未读取密钥内容 |
| API 配置完成 | PASS | 实际状态 configured=true，Base URL 和模型与上述配置一致，其他设置未改变 |
| 测试连接 | PASS | 后续直接通过 Windows UI Automation 读到实际设置页「服务已应答。」；未重复点击产生请求；具体成功 HTTP 码未采集 |
| 真实模型文字回答 | PASS | 用户在实际卡片提问「这边显示了什么」，并提供模型返回的文字：未收到图片或附件，建议上传图片或提供文本；本项为用户实机确认 |
| SSE 流式输出 | NOT TESTED | 用户提供的是最终界面文字，尚未独立记录正常响应的 delta 事件或逐步输出；Mock 不作为真实事件证据 |
| 停止生成 | NOT TESTED | 尚未对正常真实回答执行停止并观察迟到事件；未追加模型请求 |
| 复制回答 | NOT TESTED | 用户提供了回答内容，但尚未明确确认应用的复制按钮及剪贴板一致性；未操作密钥剪贴板 |
| 重试 | NOT TESTED | 重试按钮此前可用，未追加请求验证正常服务恢复后的重试 |
| 关闭后重新打开 | PASS | 关闭实际卡片，再用明确标记的合成问号打开：输入为空、回答为空、错误区域隐藏、配置仍有效；未发送新请求 |
| 重启后保存配置 | PASS | 完全退出并确认 helper 退出后重启：encryptionAvailable/hasKey/configured 均为 true，Base URL 和模型保留，helper=running |
| P2A-1 截图回归 | PASS | 本轮实际应用预览得到局部 640×480、完整屏幕预览 1728×1080；关闭后两图 src 释放 |
| 图片未上传 | PASS | 最初自动验收的截图阶段，预览前后模型请求数保持 2，两次请求均为纯文本；后续用户确认本地图片未上传；独立截图路径回归通过 |
| 原有轮盘正常 | PASS | 用户随后确认通过真实 Alt + 左键拖动选择 Enemy Missing 问号并打开 AI 卡片；此项为用户实机确认，未追加 API 请求 |

用户在本任务开始时声明 P2A-1 已通过 Windows 实机测试。随后用户回答物理操作验收问题「AI 卡片已打开」，确认真实 Alt + 左键拖动 → Enemy Missing → AI 卡片的触发链路正常。这一用户实机确认与此前合成触发证据分开保留。之后用户另行提供了实际模型文字回答，作为文字回答成功的证据；没有据此推断 SSE 事件、停止或复制按钮也已通过。

用户指出「本地的图片没有上传」。这是当前 P2A-1 的预期边界：点击本地截图预览只在内存中展示图片，文字提问只发送输入文字。用户询问「这边显示了什么」时，模型没有截图上下文，因此其返回与当前实现一致。本次没有启用图片上传、切换视觉模型或开发 P2A-2。

## 自动化与实现审查

本轮运行：

```text
npx vitest run tests/main/aiClient.test.ts tests/main/aiKeyStore.test.ts tests/main/explainWindow.test.ts tests/shared/aiConfig.test.ts tests/main/visionCapture.test.ts tests/main/captureWindows.test.ts tests/renderer/visionPreview.test.ts tests/main/preloadBundle.test.ts
```

结果：**8 个测试文件、105 项测试全部通过**，使用测试中的假密钥和 Mock，不计入上述真实请求数量。`npm run dev` 重建主进程及 5 个独立 preload，未生成共享 sibling chunk。

已审查 AiConfigSection、aiKeyStore、aiClient、index、settingsIpc、explainWindow、Explain renderer、aiConfig 及现有客户端/密钥测试。现有实现具备配置 UI、safeStorage 保存、连接按钮、chat/completions 请求、SSE、停止、复制、重试及关闭路径。

现有错误提示的限制：连接测试 UI 只显示通用失败；客户端将所有 HTTP 429 映射为 rate，因此提问卡片显示速率限制文案，无法直接区分业务码 1314 的套餐问题。本轮通过只保留 HTTP 和数字业务码的临时观察器补足诊断，没有改变产品错误映射、API 安全规则或请求逻辑。

用户粘贴的成功回答仍包含「思考中…」提示，不能据此判断请求还在生成，也不能将最终文字当作流式正常结束的事件证据；该提示状态尚未在本次重测中修复或验收。

没有修改产品源码、Windows Hook、沙箱、安全存储或截图上传路径，没有开发 P2A-2。

## 收尾前 Git 快照与提交条件

- 工作区：`D:\lolping\lolPing-p2a`。
- 分支：`feat/p2a-vision-capture`。
- 收尾审查基线：`8372815b49d72b8cf12baf28b8908a4de409587e`。
- API 验收阶段唯一新增的可提交文件是本脱敏报告；原有 20 个 P2A-1 变更已存在，该阶段未改动产品源码。收尾时更新两份报告以记录用户实机确认，共 21 个提交文件。
- 本机临时控制器位于忽略的 `out/p1b-real-api`，其源码不包含密钥；观察器不保存请求头、密钥或原始错误响应。测试进程退出即清除临时内存状态。
- 以上为提交前快照，后续提交、推送及合并状态以 Git 和 PR 记录为准；不发布安装包，不清理用户配置。

P2A-1 截图范围本轮未发现新的阻止提交的代码问题，已有实机声明及本轮截图/preload 回归证据。若提交仅限 P2A-1，可按该范围准备审查。P1B 的连接及真实文字回答已成功，物理手势触发已由用户确认；SSE 正常结束、停止、复制及重试仍有 NOT TESTED 项，不能将整体操作验收全部标记 PASS。
