# 服务端

使用 Node.js 22+。在项目根目录执行 `npm --prefix server install`，然后执行
`npm --prefix server start`。服务默认监听 `0.0.0.0:3210`，可用 `PORT` 改端口；
所有路径均基于项目目录，不依赖启动命令的当前工作目录。生产构建放在
`client/dist`，服务端会同时提供网页和 API。隔离验证可设置 `QZZ_CLIENT_DIST`
指定其他网页构建目录，绝对路径或相对项目根目录的路径均可，默认仍是 `client/dist`。

第一次启动会创建管理员 `admin`，生成随机密码并写入
`data/initial-admin.txt`。在本机读取它并登录后，该文件会自动删除。
也可在首次启动前设置 `ADMIN_USERNAME` 和 6-200 位的 `ADMIN_PASSWORD`，
则不会生成密码文件。登录校验使用 scrypt 哈希；为支持管理员查看用户密码，
新注册和新修改的密码另存 AES-256-GCM 加密副本，本地密钥是 `data/password-key`。
旧版只有哈希的密码无法查看，需修改或重置后才能查看。密钥缺失时服务会明确报错，
不会生成新密钥冒充可恢复。备份必须包含数据库和原密钥。
请勿将 `data/`、环境变量文件、密钥或备份加入 Git。

运行数据默认位于项目根目录的 `data/`，包括 SQLite 数据库、WAL 文件、
`password-key`、`uploads/`、项目图标 `project-icons/` 及需求/知识库原件目录 `workspace-documents/`。可用 `QZZ_DATA_DIR` 改位置。建议定期备份整个数据目录，
备份数据库时应先停服务，或使用 SQLite 在线备份工具。

账号及密码 API：

- `POST /api/register`：公开注册，`{username,password,confirmPassword?}`，成功后直接登录；注册只能创建普通成员。
- `GET /api/session`：返回 `{user,registrationEnabled:true}`；`POST /api/session` 接收 `{username,password,remember?}`；`DELETE /api/session` 退出。
- `remember:true` 设置 30 天 HttpOnly 会话；未勾选时使用浏览器会话 Cookie，服务端最多保留 1 天。
- `GET /api/account`：当前账号；`POST /api/account/password` 接收 `{currentPassword,newPassword}`，修改自身密码并撤销其他会话。
- `PATCH /api/account` 当前只接受空对象读取账号；不允许普通成员修改角色、权限或其他用户。
- `GET /api/users`、`POST /api/users`：仅管理员可列出和创建用户，创建请求为 `{username,password}`。
- `PUT /api/users/:id`：仅管理员可修改 `{role?,disabled?,permissions?,password?}`，修改后撤销目标用户其他会话。
- `DELETE /api/users/:id`：仅管理员可删除普通成员，撤销会话并清除凭据；保留历史记录外键，释放原账号名，管理员不可删除。
- `POST /api/users/:id/reveal-password`：仅管理员，必须传 `{currentPassword}` 再次验证管理员密码，返回 `{available,password}`；旧密码副本不存在时返回 `available:false,password:null`。

账号名为 2-32 位文字、数字或 `._-`，密码为 6-200 位。`admin` 是保留管理员，
不可停用、降级或公开注册，其他管理员也不能移除最后一名启用管理员。
`permissions` 按 `cases`、`defects`、`ai`、`files`、`requirements`、`knowledge` 分模块，例如
`{"cases":{"view":true,"write":false}}`；缺省模块保留原有可读写行为，
`view:false` 会同时关闭写权限。管理员始终具有全部模块权限。
旧账号缺少新增的 `requirements`、`knowledge` 字段时，仍按缺省可读写处理；
不会覆盖原有模块权限。管理员可在账号管理中显式关闭新模块权限。
所有业务 API 都在服务端校验权限，WebSocket 广播按模块查看权限过滤。
密码查看、修改和注册有次数限制；敏感操作仅记录操作者、目标、操作和时间，
不记录密码。普通接口、用户列表和广播不返回密码、加密副本或密钥。

本机维护重置可在停止服务并备份数据后执行 `node server/reset-admin-password.js`，
通过标准输入传入新密码并结束输入；命令只输出成功提示，撤销 admin 会话。
须先使用新版服务完成数据库迁移。不要将密码写进命令行参数、脚本或 Git。
健康检查为无需登录的 `GET /api/health`；业务接口均需登录，使用 HttpOnly 会话 Cookie。

项目组及用例、缺陷 API：

- `GET /api/projects`：有用例库、缺陷、AI、需求管理或知识库任一查看权限时返回 `{projects}`；项目包含 `id`、`name`、`iconUrl`、`revision`、`caseCount`、`defectCount` 和创建、更新时间。无对应模块查看权限的计数为 `null`。
- `POST /api/projects`：管理员添加共享项目组，请求 `{name}`；`PUT /api/projects/:id` 接收 `{name,revision}` 重命名。
- `DELETE /api/projects/:id`：管理员传 `{revision,confirmationName}`，名称必须完全匹配。采用软删除，记录和图标保留，已删除项目无法继续访问用例、缺陷或图标。`GET /api/projects?archived=1` 仅管理员可查看已删除项目，`POST /api/projects/:id/restore` 传 `{revision}` 恢复；所有项目均删除后重启不会新建默认组。项目返回 `deletedAt`，删除及恢复都会增加修订号。
- 名称去掉两端空格后为 1-60 位，不接受控制字符；名称重复（忽略大小写）返回 409。项目 ID 不随名称变化。
- `POST /api/projects/:id/icon`：管理员上传 multipart 字段 `file`、`revision`。只接受有效 PNG、JPG、WebP、GIF，最大 2 MB、1600 万像素；服务端解码并转为最大 256×256 WebP。SVG、伪造或损坏图片返回 400，超限返回 413。替换后清理旧图标。
- `GET /api/projects/:id/icon`：登录且有任一项目模块查看权限后才能访问，返回图像及 `nosniff` 头。`iconUrl` 自带修订版本参数。
- 重命名和图标更新均检查 `revision`，过期修改返回 409 及最新 `{project}`。普通成员按模块权限选择和浏览项目组，不能管理项目组。
- `GET /api/cases?projectId=...`、`GET /api/defects?projectId=...` 必须传有效项目 ID，仅返回该组记录；对应 `POST`、`PUT /:id`、`DELETE /:id` 的 JSON 也必须包含 `projectId`。缺少或无效项目返回 400，以其他项目 ID 操作既有记录返回 404。
- 缺陷含独立的 `issueType` 字段，仅接受 `版本问题` 或 `线上问题`；创建省略时默认 `版本问题`，修改省略时保留原值。旧缺陷升级后默认归为版本问题，响应及实时事件都会返回该字段。
- 用例和缺陷返回 `projectId`，更新不会跨组移动记录；修改、删除仍须提供记录自身的 `revision`，并遵循原模块写权限。
- 用例集新增可空 `requirementId`。创建/编辑显式关联时校验需求查看权限、项目归属及未删除状态；编辑时省略字段保留原关联，`null` 解除关联。`GET /api/cases?projectId=...&requirementId=...` 按需求筛选，跨项目需求被拒绝。删除需求解除用例关联，保留导图和测试计划历史。

首次迁移会将原有用例和缺陷归入“默认项目组”，保留原有内容、记录 ID、
修订号及时间。默认组可以重命名，后续启动保留同一个项目 ID。新数据库也会
创建一个默认组，但网页不会代替用户自动选择；进入用例或缺陷模块前需手动选组。
AI 生成草稿无需项目，保存进用例库时必须选择所属项目。

用例集、思维导图及批量 API：

- `/api/cases` 的一条记录现在代表一个用例集，保留原有字段，并新增 `tree`：`{id,title,children:[...]}`。`POST` 仅传 `{projectId,title}` 即创建只有中心主题的空白导图；`PUT /api/cases/:id` 传 `{projectId,revision,title?,tree?}` 保存，修订冲突返回 409。旧用例在迁移中转成包含模块、优先级、状态、前置条件、步骤、预期、标签和备注的导图，原字段、ID、修订和时间均保留。
- 节点 ID 只接受 1-100 位字母、数字、下划线或连字符，单图不允许重复。导图上限为 5000 节点、64 层、50 万字符，单节点 3 万字符；JSON 请求上限 4 MB。
- 节点可带 `style`，支持 `fontSize`（12-48 的整数加 `px`）、`color`/`background`（六位十六进制色）、`fontWeight`（`normal`/`bold`）、`fontStyle`（`normal`/`italic`）、`textDecoration`（`none`/`underline`）。保存、版本检查和现代 XMind 显式节点样式往返均保留这些字段；空对象或省略 `style` 恢复默认。拒绝其他 CSS 属性和值。Markdown 仍只保留主题文字与层级。
- `POST /api/cases/import`：multipart 字段 `projectId`、`file`，可选 `requirementId`，支持 UTF-8 `.md/.markdown` 和 `.xmind`，返回 `{cases}`。传需求 ID 时校验需求查看权限、项目归属和未删除状态，并为本批导入记录建立关联；不传则不关联。多个一级标题或 XMind 多画布导入为多个用例集；导入一次最多 100 个用例集。XMind 支持现代 `content.json` 和旧版 `content.xml`，读取主题文本和层级，不导入原应用的主题样式、画布坐标、图片附件等。文件上限 10 MB；Markdown 文字上限 2 MB，归档目录和解压内容另有上限。
- `POST /api/cases/export`：JSON `{projectId,items:[{id,revision}],format:"md"|"xmind"}`，有用例查看权限即可导出。单个 Markdown 返回 `.md`，多个返回包含独立 `.md` 的 ZIP；XMind 返回真实的多画布 `.xmind` ZIP。一次导出最多 1000 个用例集、8 MB UTF-8 导图内容；XMind 另限 100 个画布，含格式结构的 `content.json` 也不能超过 8 MB，以保证可重新导入。超限返回 413 并提示分批；单个 Markdown 转义后的文字也须符合 2 MB 限制。失效修订拒绝导出。
- `POST /api/cases/batch`：`{projectId,items:[{id,revision}],action:"delete"}`。
- `POST /api/defects/batch`：同上，支持 `action:"delete"` 或 `action:"status",status:"待处理"|"处理中"|"待验证"|"搁置"|"已解决"|"已关闭"`。单条列表状态修改同样使用此接口，`items` 只有一条。
- 批量操作须有相应模块写权限，最多 1000 条，不接受重复 ID。先校验全部项目归属和修订，再在事务内整体提交；任一条过期返回 409、跨项目或不存在返回 404，不会部分成功。成功返回 `{ok:true,count}`，逐记录发送原有实时事件。记录删除不可恢复，网页需要用户确认；项目组删除则可从已删除项目恢复。

需求管理、测试计划及知识库 API：

这些接口均需登录并验证有效 `projectId`。读取由查询参数传项目 ID，写入由 JSON 或
multipart 字段传项目 ID；修改和删除必须传目标记录自己的 `revision`，过期返回 409。
需求和测试计划使用 `requirements.view/write`，知识库使用 `knowledge.view/write`，
不依赖 URL 前缀恰好等于权限名称。删除采用 `deleted_at`，原件和历史计划保留。

- `GET /api/requirements?projectId=...&q=...&status=...` 返回 `{requirements}`；`GET /api/requirements/:id?projectId=...` 返回 `{requirement}`。
- `POST /api/requirements` 接收 `{projectId,title,body,status?,priority?,sourceUrl?}`，也可用 multipart 同名字段和重复的 `file` 字段上传多份原件。正文或附件至少一项；状态为草稿、已确认、已归档，优先级为 P0-P3。无正文和附件而提供飞书 `sourceUrl` 时读取已授权文字来源。
- `PUT /api/requirements/:id` 接收 `{projectId,revision,title?,body?,analysis?,status?,priority?,sourceUrl?}`；`analysis` 是独立的 Markdown 分析结果，不覆盖需求原文。`DELETE /api/requirements/:id` 接收 `{projectId,revision}`，解除用例关联并保留计划。
- `POST /api/requirements/:id/attachments` 用 multipart `{projectId,revision,file...}` 追加附件；`DELETE /api/requirements/:id/attachments/:attachmentId` 用 `{projectId,revision}` 移除。无正文时不允许移除最后一个来源附件。
- `GET /api/requirements/:id/attachments/:attachmentId/download?projectId=...` 下载原件；加 `inline=1` 可预览有效图片和 PDF。原始附件及 DOCX 嵌图含 `downloadUrl/previewUrl`，不向网页暴露磁盘路径；图片返回 `nosniff`。Word 预览为提取正文与嵌图，不声称还原全部原始分页布局。
- `GET /api/test-plans?projectId=...&requirementId=...` 返回 `{plans}`；单条 `GET /api/test-plans/:id?projectId=...` 返回 `{plan}`。`POST /api/test-plans` 接收 `{projectId,requirementId,title,version?,iteration?,content?}`，`PUT /:id` 补 `revision`；`DELETE /:id` 使用 `{projectId,revision}`。计划是 Markdown 规划文档，不自动执行测试。
- `GET /api/knowledge-bases?projectId=...&q=...` 返回 `{knowledgeBases}`；单条 `GET /:id` 返回 `{knowledgeBase}`。`POST /api/knowledge-bases` 接收 `{projectId,name,description?,category?,preset?,chunkMode?,chunkSize?,chunkOverlap?}`；`PUT /:id` 增加 `revision`，`DELETE /:id` 使用 `{projectId,revision}`。
- 分块默认 `chunkMode:"window",chunkSize:400,chunkOverlap:80`。预设 `fine` 为窗口 250/50，`standard` 为窗口 400/80，`heading` 为标题 800/100；可覆盖具体值。块长 100-4000、重叠 0 至块长减一，单文档最多 10000 块；标题模式先按 Markdown 标题切段，再应用窗口。配置更新后 `indexPending/indexOutdated` 提示需重建。
- `GET /api/knowledge-bases/:id/documents?projectId=...&q=...&category=...` 返回 `{documents}`；`POST` 支持 JSON `{projectId,title,body,category?,sourceUrl?}` 或同名 multipart 和 `file` 原件。单文档 `GET/PUT/DELETE /api/knowledge-bases/:id/documents/:docId` 支持读取、编辑与删除，写入使用文档自身 `revision`。正文编辑后立即重建该文档分块，以当前正文为准。
- 文档原件路径为 `GET /api/knowledge-bases/:id/documents/:docId/attachments/:attachmentId/download?projectId=...`，图片/PDF 支持 `inline=1`；`GET /api/knowledge-bases/:id/documents/:docId/chunks?projectId=...` 返回实际 `{chunks,indexOutdated}`。
- `POST /api/knowledge-bases/:id/reindex` 接收 `{projectId,revision}` 重建整库；返回 `{knowledgeBase,indexedDocuments,indexedChunks}`。`POST /api/knowledge-bases/:id/documents/:docId/reindex` 使用文档 `revision`，返回 `{document,indexedChunks}`。
- `POST /api/knowledge-bases/:id/search` 接收 `{projectId,query,limit?}`，只需查看权限；返回实际匹配的文本块、文档来源、分数、提示和 `retrieval:"local-keyword"`。这是本地词法 RAG，不是外部向量服务，也不会伪造检索命中。

新增来源原件上传没有固定 20 MB 上限，每次 multipart 最多 24 个 `file`，可追加。
文本自动提取上限 10 万字符、PDF 300 页、Word 展开预算 64 MiB；失败时保留
需求/知识库原件及明确错误，允许补正文。图片原件保留、实际解码并生成 PNG 供视觉输入，
DOCX 嵌图会提取并明确提示；扫描 PDF 当前无 OCR，需补截图或正文。飞书接口只读文字。
单轮模型图片输入最多 64 张、合计 64 MiB、单图安全解码 4000 万像素，超限不截断。
这些是读取和推理预算，不是原件上传的 20 MB 限制。

工作区 AI API：

`POST /api/workspace/ai` 接收 `{projectId,requirementId,task,model?,reasoningEffort?,knowledgeBaseIds?,instructions?,clarifications?,confirmedRulesOnly?,points?,review?,history?,draft?,outputType?}`。模型及推理档位根据 `/api/ai/models` 的本机与网关列表选择，切换时由服务端再次校验，不修改默认配置。
`task` 为 `analysis/plan/points/cases/revise`；修订须传完整 `draft` 和原 `outputType`。
一次最多引用 10 个本项目知识库，检索注入最多 8 个文本块、12000 字符；
需求正文单轮最多 10 万字符。补充说明和回答各最多 12000 字符，对话最多 40 条、
合计 60000 字符，完整草稿最多 250000 字符。模型未配置返回 503，不返回示例草稿冒充生成。

分析返回三段 Markdown：功能清单、界面描述、待澄清项；计划返回八章：目标与范围、
策略与优先级、环境与数据、人力与人天、进度与里程碑、进入标准/退出标准、风险与应对、
交付物。测试点可以编辑后作为 `points` 传入生成详细用例，用户删除的测试点不能悄悄回填。
用例按现有四分支组织，包含条件、步骤、预期、优先级及可验证 `sourceIds`。
结果另含 `sources/warnings/retrieval/vision`；未提供的资料不冒充已读证据。

`review` 为 `[{dimension,weight}]`，权重 1-5，最多八个维度：覆盖完整性、正确性、
冗余去重、边界与异常、步骤清晰度、优先级合理性、前置/数据完整性、需求追溯。
`reviewReport.method="ai-self-review"`，报告含问题、修改建议及加权分，不代表实际执行结果。
AI 任务需 `ai.write` 和 `requirements.view`；引用知识库另需 `knowledge.view`，
生成/修订用例另需 `cases.write`。写入分析、计划和正式用例仍分别走对应 CRUD 并需写权限。
`analysis`、`plan` 及对应 `revise` 仅依据本次需求、实际图片及所选知识库，不采集游戏源码；
测试点和用例任务才按需提供主机只读采集的相关源码片段。
生成完成会再次检查会话、权限、项目和需求修订；期间需求修改返回 409，避免写入过期理解。
网页取消或断开会释放任务锁，并取消请求或终止本次 Codex 子进程树。

本轮功能对照、使用流程和备份说明见 `docs/workspace-upgrade.md`。备份必须同时包含
数据库、原密码密钥、`workspace-documents/` 的原件及视觉派生图，以及原有数据和本机配置。

AI 优先读取 `data/ai-provider.json` 中的固定本机配置，密钥以原有 `password-key`
进行 AES-GCM 加密，不返回给网页。当前配置通过本机 Codex 使用公司 Responses 网关，
默认模型 `gpt-6.1-sol`、档位 `ultra`。AI 用例生成可选择本机支持的 `xhigh`（页面显示“极高”）或 `ultra`；
已核对真实请求的 `store:false`。CLI 使用独立运行目录和临时输出 schema。
平台只读采集点点消项目白名单中的相关源码片段，作为材料交给 Codex 分析；
分析和计划任务除外，不采集源码。生成进程禁用系统命令及插件初始化，保持只读沙箱。
网关请求配置 `request_max_retries=2`、流恢复配置 `stream_max_retries=1`，
不做无限重试；不设固定总时长，仍受长时间无输出看门狗与手动取消约束。临时提示及结果文件在完成或取消后清理。
网页取消或断开会终止本次子进程树并释放生成锁。

Codex 非正常退出按终端模型错误提供受控分类：认证、模型、接口、结构化协议、上下文容量、
限流、连接/流中断、超时、本机运行环境，未知错误保留通用退出提示。启动警告中的 HTTP
状态不作为模型失败依据。诊断记录位于 `data/codex-diagnostics/`（随 `QZZ_DATA_DIR` 改变），
最多保留 50 条；每条仅含时间、模型、错误分类、HTTP/退出状态、耗时、提示字符数、图片数
及通过白名单验证的请求编号。不记录提示词、文档/图片内容、密钥、网关地址、环境变量或
stdout/stderr 原文。页面错误可附诊断编号；记录写入失败不会掩盖原始受控错误。

不存在本机配置时，保留 `AI_API_KEY`、`AI_MODEL`、`AI_BASE_URL` 环境变量兼容方式。
`AI_WIRE_API=responses` 使用 Responses，`chat` 使用 Chat Completions；
`AI_REASONING_EFFORT` 传入对应服务支持的推理强度。环境变量方式不会覆盖固定本机配置。
`GET /api/config` 只返回已配置标记、模型、档位和模式，不返回密钥。
入口仅接收策划文档，不再接受手写 `requirements`。`POST /api/ai/documents`
上传 multipart `file`（Word `.doc/.docx`、PDF、Markdown、TXT），或 JSON `{url}`
导入飞书 / Lark 的 `docx/docs/wiki` 地址，返回 `{document:{id,name,text,chars,warnings}}`。
策划文档上传不设置固定文件大小上限；解析后的正文最多 10 万字符，PDF 最多 300 页；扫描版 PDF 无 OCR，
无可读文字时明确拒绝，不会用空文档生成。暂存文档按账号隔离、24 小时过期，
可用 `DELETE /api/ai/documents/:id` 移除。文件只用于提取，原二进制不持久保存。

`POST /api/ai/generate` 的请求体为 `{documentIds:[...],title?,clarifications?,confirmed?}`，
返回 `{title,tree,questions}`。服务加载版本化的 `server/skills/game-prd-testcases.md`，
按主流程、UI、异常与边界、受影响模块组织导图，每条用例需有前置条件、执行步骤、
预期结果。规则不清时先返回待确认问题，补充回答后重新生成；也可选择仅覆盖已确认规则。
文档正文作为待分析资料发送，不作为系统指令；生成结果不会自动入库，需要选择项目组并保存。
未配置 AI 时返回 503，不会伪装生成结果。

飞书读取由服务器电脑上的 Chrome 扩展执行，使用该浏览器已登录账号的实际权限，不需要
App ID / App Secret。管理员可以在“飞书文档连接”中下载扩展 ZIP、生成一次性配对码或断开连接。
`GET /api/feishu-browser/status` 供登录用户查看状态；`POST /api/feishu-browser/pair`、
`DELETE /api/feishu-browser/disconnect` 和 `GET /api/feishu-browser/extension.zip` 仅管理员可用。
扩展仅从本机 `127.0.0.1` 连接 `/api/feishu-browser/events`，配对令牌在平台仅存哈希。
旧 `/api/ai/feishu-config` 已下线；旧配置文件如有保留在本地但不再读取。
导入需求/知识来源时保存正文、实际取得的图片附件及完整性警告，部分读取不能宣称已分析所有内容；
AI 临时来源仅保存正文，图片应导入项目需求或知识库后参与图文分析。错误返回受控信息，
超过 180 秒自动取消。安装及边界见 [浏览器导入说明](../docs/browser-import.md)。
本轮仅用模拟扩展与 DOM 测试，尚未验证真实飞书页面及企业账号权限。

工具云盘支持多级文件夹、文件移动、空文件夹删除。`GET /api/files?folderId=...` 返回当前目录的
`files`、`folders`、`path` 和 `allFolders`；旧文件仍在根目录。`POST /api/files/folders` 传
`{name,parentId?}`，`PUT /api/files/folders/:id` 传 `{name}`，`DELETE` 只允许空文件夹；
`PATCH /api/files/:id` 传 `{folderId:null|id}` 移动文件。上传至指定目录用
`POST /api/files?folderId=...`，不传时上传到根目录；同一请求最多 24 个 `file` 字段，网页自动分批，返回 `files` 数组并保留单文件兼容字段 `file`。文件夹拖入会先建立对应目录层级。应用不再设置单文件大小上限，
`MAX_UPLOAD_MB` 已停用；上传允许持续超过 Node 默认的五分钟整请求时间，但连接空闲
两分钟会断开。实际可上传大小仍取决于剩余磁盘空间、浏览器和网络代理限制。
新上传文件名统一修复 multipart UTF-8 被按 Latin-1 解码的问题，保留原生 Unicode 文件名，
下载仍返回原始内容；不自动重写历史文件记录。

本轮修复与验证边界见 [2026-11-17 复查记录](../docs/qa-review-20261117.md)。

WebSocket 地址是同源 `/api/events`，会在项目组、用例、缺陷、文件、需求、计划和知识库变更时
广播相应的 `project.*`、`case.*`、`defect.*`、`file.*`、`requirement.*`、`plan.*`、`knowledge.*` 事件。用例和缺陷事件包含
顶层 `projectId`；项目组事件及计数也按当前会话的模块查看权限过滤。
个人电脑关机、休眠或网络断开后服务不可用；开机并不等于服务自动启动，
还需另行配置 Windows 登录任务或服务，并放行 Windows 防火墙的端口。
内网 HTTP 会话不加密，若网络环境不可信，应在前面部署 HTTPS 反向代理。
代理位于本机回环地址且能可靠设置 `X-Forwarded-Proto` 时，可设置
`TRUST_PROXY=1`，并限制客户端无法直接访问后端端口。

## 飞书 QA 助手

飞书聊天助手与上述 Chrome 云文档导入是两条独立通道。复用已发布的企业自建应用时，
需开启机器人能力、`im.message.receive_v1` 长连接事件及应用身份的
`im:message:send_as_bot`、`im:message.p2p_msg:readonly`、
`im:message.group_at_msg:readonly` 权限；本机不需要公网入站端口。
机器人随 QZZ 服务启动和停止，不需要运行第二个常驻程序。只有配置凭据后才启用；
凭据缺失或机器人连接失败不影响平台网页与 API。

在服务电脑的项目根目录运行 `node server/configure-feishu-bot.js <App ID>`，
按提示输入 App Secret（输入时不显示）。仅在本机 `data/feishu-bot.json` 保存使用
`data/password-key` 加密的密钥；不要把它、明文密钥、整个 `data/` 或命令行输出
提交到 Git。可选用进程环境变量 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 覆盖本地文件，
但必须同时设置两者。配置后通过控制器停止再启动 QZZ 服务，以加载新凭据。
日志出现“飞书助手长连接已就绪”才代表真正连通，不要把网站启动成功误当机器人连通。

机器人只回应单聊文字、群聊中明确 @ 它的文字；忽略机器人自身消息、图片及其他类型。
对话按会话与用户隔离，最近八轮上下文只保存在内存，服务重启后清空。模型使用平台
已配置的本机 Codex 网关，但这是独立对话，**不是本桌面 Codex 聊天的同步副本**。
模型进程禁用工具、插件和网页搜索，不能访问平台数据库、公司文件或代替用户操作系统。
飞书对话文字会发送到已配置的公司 AI 网关，启用前需确认企业信息处理要求。
若另有服务使用同一飞书应用的长连接收消息，不要同时启动：飞书事件以集群模式
分配给连接实例，可能导致部分消息进入另一服务。

## 缺陷群通知

缺陷群通知复用飞书聊天助手的应用凭据，但使用独立的消息发送通道，无需 AI 模型参与。
在本机被 Git 忽略的 `data/feishu-defect-notifications.json` 中设置目标项目组 ID 和群 ID：

```json
{"projectId":"项目组 UUID","chatId":"oc_ 开头的群 ID"}
```

机器人必须已加入目标群，且应用身份拥有 `im:message:send_as_bot` 权限；要发送图片还需
`im:resource:upload` 或 `im:resource` 权限。缺少或错误的
配置不会向任何群发送。配置更新后需重启
平台服务。仅创建缺陷、状态转入“已解决”或“已关闭”时发送，不因其他编辑重复发送；批量状态
修改也按每条缺陷处理。文字只发送定位所需的简要元数据，不包含复现步骤和备注；若缺陷
有图片，则在文字消息后逐张发送压缩图片。入队时在 `data/defect-images/notification-snapshots/`
保留待发图片；即使用户随后删除缺陷或原图，已入队的图片仍会发送，成功投递后清理快照。
文字及图片的发送进度分别持久化，瞬时失败自动重试。升级前已入队的旧通知若原图已删除，
无法补回图片，此时跳过并记录警告，文字通知不受影响。
消息进入本机待发队列，飞书网络故障不会阻止缺陷保存，服务恢复后继续投递。迁移或备份时保留
整个 `data/`，不要把配置或数据库提交到 Git。修改目标群后，已入队消息仍投递到原群；
修改目标项目后，旧项目的待发消息会被跳过。通知不会同步当前 Codex 桌面会话。
