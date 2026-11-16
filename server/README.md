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
`password-key`、`uploads/` 及项目图标 `project-icons/`。可用 `QZZ_DATA_DIR` 改位置。建议定期备份整个数据目录，
备份数据库时应先停服务，或使用 SQLite 在线备份工具。

账号及密码 API：

- `POST /api/register`：公开注册，`{username,password,confirmPassword?}`，成功后直接登录；注册只能创建普通成员。
- `GET /api/session`：返回 `{user,registrationEnabled:true}`；`POST /api/session` 接收 `{username,password,remember?}`；`DELETE /api/session` 退出。
- `remember:true` 设置 30 天 HttpOnly 会话；未勾选时使用浏览器会话 Cookie，服务端最多保留 1 天。
- `GET /api/account`：当前账号；`POST /api/account/password` 接收 `{currentPassword,newPassword}`，修改自身密码并撤销其他会话。
- `PATCH /api/account` 当前只接受空对象读取账号；不允许普通成员修改角色、权限或其他用户。
- `GET /api/users`、`POST /api/users`：仅管理员可列出和创建用户，创建请求为 `{username,password}`。
- `PUT /api/users/:id`：仅管理员可修改 `{role?,disabled?,permissions?,password?}`，修改后撤销目标用户其他会话。
- `POST /api/users/:id/reveal-password`：仅管理员，必须传 `{currentPassword}` 再次验证管理员密码，返回 `{available,password}`；旧密码副本不存在时返回 `available:false,password:null`。

账号名为 2-32 位文字、数字或 `._-`，密码为 6-200 位。`admin` 是保留管理员，
不可停用、降级或公开注册，其他管理员也不能移除最后一名启用管理员。
`permissions` 按 `cases`、`defects`、`ai`、`files` 分模块，例如
`{"cases":{"view":true,"write":false}}`；缺省模块保留原有可读写行为，
`view:false` 会同时关闭写权限。管理员始终具有全部模块权限。
所有业务 API 都在服务端校验权限，WebSocket 广播按模块查看权限过滤。
密码查看、修改和注册有次数限制；敏感操作仅记录操作者、目标、操作和时间，
不记录密码。普通接口、用户列表和广播不返回密码、加密副本或密钥。

本机维护重置可在停止服务并备份数据后执行 `node server/reset-admin-password.js`，
通过标准输入传入新密码并结束输入；命令只输出成功提示，撤销 admin 会话。
须先使用新版服务完成数据库迁移。不要将密码写进命令行参数、脚本或 Git。
健康检查为无需登录的 `GET /api/health`；业务接口均需登录，使用 HttpOnly 会话 Cookie。

项目组及用例、缺陷 API：

- `GET /api/projects`：有用例库或缺陷查看权限时返回 `{projects}`；项目包含 `id`、`name`、`iconUrl`、`revision`、`caseCount`、`defectCount` 和创建、更新时间。无对应模块查看权限的计数为 `null`。
- `POST /api/projects`：管理员添加共享项目组，请求 `{name}`；`PUT /api/projects/:id` 接收 `{name,revision}` 重命名。
- `DELETE /api/projects/:id`：管理员传 `{revision,confirmationName}`，名称必须完全匹配。采用软删除，记录和图标保留，已删除项目无法继续访问用例、缺陷或图标。`GET /api/projects?archived=1` 仅管理员可查看已删除项目，`POST /api/projects/:id/restore` 传 `{revision}` 恢复；所有项目均删除后重启不会新建默认组。项目返回 `deletedAt`，删除及恢复都会增加修订号。
- 名称去掉两端空格后为 1-60 位，不接受控制字符；名称重复（忽略大小写）返回 409。项目 ID 不随名称变化。
- `POST /api/projects/:id/icon`：管理员上传 multipart 字段 `file`、`revision`。只接受有效 PNG、JPG、WebP、GIF，最大 2 MB、1600 万像素；服务端解码并转为最大 256×256 WebP。SVG、伪造或损坏图片返回 400，超限返回 413。替换后清理旧图标。
- `GET /api/projects/:id/icon`：登录且有用例库或缺陷查看权限后才能访问，返回图像及 `nosniff` 头。`iconUrl` 自带修订版本参数。
- 重命名和图标更新均检查 `revision`，过期修改返回 409 及最新 `{project}`。普通成员按模块权限选择和浏览项目组，不能管理项目组。
- `GET /api/cases?projectId=...`、`GET /api/defects?projectId=...` 必须传有效项目 ID，仅返回该组记录；对应 `POST`、`PUT /:id`、`DELETE /:id` 的 JSON 也必须包含 `projectId`。缺少或无效项目返回 400，以其他项目 ID 操作既有记录返回 404。
- 用例和缺陷返回 `projectId`，更新不会跨组移动记录；修改、删除仍须提供记录自身的 `revision`，并遵循原模块写权限。

首次迁移会将原有用例和缺陷归入“默认项目组”，保留原有内容、记录 ID、
修订号及时间。默认组可以重命名，后续启动保留同一个项目 ID。新数据库也会
创建一个默认组，但网页不会代替用户自动选择；进入用例或缺陷模块前需手动选组。
AI 生成草稿无需项目，保存进用例库时必须选择所属项目。

用例集、思维导图及批量 API：

- `/api/cases` 的一条记录现在代表一个用例集，保留原有字段，并新增 `tree`：`{id,title,children:[...]}`。`POST` 仅传 `{projectId,title}` 即创建只有中心主题的空白导图；`PUT /api/cases/:id` 传 `{projectId,revision,title?,tree?}` 保存，修订冲突返回 409。旧用例在迁移中转成包含模块、优先级、状态、前置条件、步骤、预期、标签和备注的导图，原字段、ID、修订和时间均保留。
- 节点 ID 只接受 1-100 位字母、数字、下划线或连字符，单图不允许重复。导图上限为 5000 节点、64 层、50 万字符，单节点 3 万字符；JSON 请求上限 4 MB。
- `POST /api/cases/import`：multipart 字段 `projectId`、`file`，支持 UTF-8 `.md/.markdown` 和 `.xmind`，返回 `{cases}`。多个一级标题或 XMind 多画布导入为多个用例集；导入一次最多 100 个用例集。XMind 支持现代 `content.json` 和旧版 `content.xml`，读取主题文本和层级，不导入原应用的主题样式、画布坐标、图片附件等。文件上限 10 MB；Markdown 文字上限 2 MB，归档目录和解压内容另有上限。
- `POST /api/cases/export`：JSON `{projectId,items:[{id,revision}],format:"md"|"xmind"}`，有用例查看权限即可导出。单个 Markdown 返回 `.md`，多个返回包含独立 `.md` 的 ZIP；XMind 返回真实的多画布 `.xmind` ZIP。一次导出最多 1000 个用例集、8 MB UTF-8 导图内容；XMind 另限 100 个画布，含格式结构的 `content.json` 也不能超过 8 MB，以保证可重新导入。超限返回 413 并提示分批；单个 Markdown 转义后的文字也须符合 2 MB 限制。失效修订拒绝导出。
- `POST /api/cases/batch`：`{projectId,items:[{id,revision}],action:"delete"}`。
- `POST /api/defects/batch`：同上，支持 `action:"delete"` 或 `action:"status",status:"待处理"|"处理中"|"待验证"|"已解决"|"已关闭"`。单条列表状态修改同样使用此接口，`items` 只有一条。
- 批量操作须有相应模块写权限，最多 1000 条，不接受重复 ID。先校验全部项目归属和修订，再在事务内整体提交；任一条过期返回 409、跨项目或不存在返回 404，不会部分成功。成功返回 `{ok:true,count}`，逐记录发送原有实时事件。记录删除不可恢复，网页需要用户确认；项目组删除则可从已删除项目恢复。

AI 用例生成默认关闭。配置 `AI_API_KEY`、`AI_MODEL`，以及可选的
`AI_BASE_URL`（默认为 `https://api.openai.com/v1`）后，
`POST /api/ai/generate` 才会请求兼容 Chat Completions 的服务。
入口仅接收策划文档，不再接受手写 `requirements`。`POST /api/ai/documents`
上传 multipart `file`（Word `.doc/.docx`、PDF、Markdown、TXT），或 JSON `{url}`
导入飞书 / Lark 的 `docx/docs/wiki` 地址，返回 `{document:{id,name,text,chars}}`。
每份文档最多 20 MB、10 万字符，PDF 最多 300 页；扫描版 PDF 无 OCR，
无可读文字时明确拒绝，不会用空文档生成。暂存文档按账号隔离、24 小时过期，
可用 `DELETE /api/ai/documents/:id` 移除。文件只用于提取，原二进制不持久保存。

`POST /api/ai/generate` 的请求体为 `{documentIds:[...],title?,clarifications?,confirmed?}`，
返回 `{title,tree,questions}`。服务加载版本化的 `server/skills/game-prd-testcases.md`，
按主流程、UI、异常与边界、受影响模块组织导图，每条用例需有前置条件、执行步骤、
预期结果。规则不清时先返回待确认问题，补充回答后重新生成；也可选择仅覆盖已确认规则。
文档正文作为待分析资料发送，不作为系统指令；生成结果不会自动入库，需要选择项目组并保存。
未配置 AI 时返回 503，不会伪装生成结果。

飞书须由管理员在网页配置 `appId`、`appSecret`，或设置环境变量
`FEISHU_APP_ID`、`FEISHU_APP_SECRET`，并在飞书为应用开通相应文档读取权限、
授权访问文档。网页 API 为 `GET/PUT /api/ai/feishu-config`，`appSecret` 不返回；
本地配置 `data/feishu-config.json` 中的密钥使用原有 `password-key` 加密。
服务仅请求固定的飞书 / Lark 官方 API 域名，不直接抓取任意传入地址。
缺少授权会提示下载 Word/PDF 后导入。

工具云盘上传上限默认 100 MB，可用 `MAX_UPLOAD_MB` 调整；此设置不改变上述导入限制。

WebSocket 地址是同源 `/api/events`，会在项目组、用例、缺陷和文件变更时
广播相应的 `project.*`、`case.*`、`defect.*`、`file.*` 事件。用例和缺陷事件包含
顶层 `projectId`；项目组事件及计数也按当前会话的模块查看权限过滤。
个人电脑关机、休眠或网络断开后服务不可用；开机并不等于服务自动启动，
还需另行配置 Windows 登录任务或服务，并放行 Windows 防火墙的端口。
内网 HTTP 会话不加密，若网络环境不可信，应在前面部署 HTTPS 反向代理。
代理位于本机回环地址且能可靠设置 `X-Forwarded-Proto` 时，可设置
`TRUST_PROXY=1`，并限制客户端无法直接访问后端端口。
