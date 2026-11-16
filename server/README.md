# 服务端

使用 Node.js 22+。在项目根目录执行 `npm --prefix server install`，然后执行
`npm --prefix server start`。服务默认监听 `0.0.0.0:3210`，可用 `PORT` 改端口；
所有路径均基于项目目录，不依赖启动命令的当前工作目录。生产构建放在
`client/dist`，服务端会同时提供网页和 API。

第一次启动会创建管理员 `admin`，生成随机密码并写入
`data/initial-admin.txt`。在本机读取它并登录后，该文件会自动删除。
也可在首次启动前设置 `ADMIN_USERNAME` 和 6-200 位的 `ADMIN_PASSWORD`，
则不会生成密码文件。登录校验使用 scrypt 哈希；为支持管理员查看用户密码，
新注册和新修改的密码另存 AES-256-GCM 加密副本，本地密钥是 `data/password-key`。
旧版只有哈希的密码无法查看，需修改或重置后才能查看。密钥缺失时服务会明确报错，
不会生成新密钥冒充可恢复。备份必须包含数据库和原密钥。
请勿将 `data/`、环境变量文件、密钥或备份加入 Git。

运行数据默认位于项目根目录的 `data/`，包括 SQLite 数据库、WAL 文件、
`password-key` 及 `uploads/`。可用 `QZZ_DATA_DIR` 改位置。建议定期备份整个数据目录，
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

AI 用例生成默认关闭。配置 `AI_API_KEY`、`AI_MODEL`，以及可选的
`AI_BASE_URL`（默认为 `https://api.openai.com/v1`）后，
`POST /api/ai/generate` 才会请求兼容 Chat Completions 的服务。
请求体为 `{"requirements":"需求描述","count":5,"module":"模块"}`。
未配置时返回 503，不会伪装生成结果。上传上限默认 100 MB，
可用 `MAX_UPLOAD_MB` 调整。

WebSocket 地址是同源 `/api/events`，会在用例、缺陷和文件变更时
广播相应的 `case.*`、`defect.*`、`file.*` 事件。
个人电脑关机、休眠或网络断开后服务不可用；开机并不等于服务自动启动，
还需另行配置 Windows 登录任务或服务，并放行 Windows 防火墙的端口。
内网 HTTP 会话不加密，若网络环境不可信，应在前面部署 HTTPS 反向代理。
代理位于本机回环地址且能可靠设置 `X-Forwarded-Proto` 时，可设置
`TRUST_PROXY=1`，并限制客户端无法直接访问后端端口。
