# 服务端

使用 Node.js 22+。在项目根目录执行 `npm --prefix server install`，然后执行
`npm --prefix server start`。服务默认监听 `0.0.0.0:3210`，可用 `PORT` 改端口；
所有路径均基于项目目录，不依赖启动命令的当前工作目录。生产构建放在
`client/dist`，服务端会同时提供网页和 API。

第一次启动会创建管理员 `admin`，生成随机密码并写入
`data/initial-admin.txt`。在本机读取它并登录后，该文件会自动删除。
也可在首次启动前设置 `ADMIN_USERNAME` 和至少 12 位的 `ADMIN_PASSWORD`，
则不会生成密码文件。密码仅以 scrypt 哈希形式存入数据库。
请勿将 `data/`、环境变量文件、密钥或备份加入 Git。

运行数据默认位于项目根目录的 `data/`，包括 SQLite 数据库、WAL 文件
及 `uploads/`。可用 `QZZ_DATA_DIR` 改位置。建议定期备份整个数据目录，
备份数据库时应先停服务，或使用 SQLite 在线备份工具。

登录后管理员可通过 `POST /api/users` 创建独立成员账号，请求体为
`{"username":"tester","password":"至少12位"}`，可用 `GET /api/users`
查看账号。登录 API 为 `POST /api/session`，退出为 `DELETE /api/session`。
健康检查为无需登录的 `GET /api/health`；业务接口均需登录，使用 HttpOnly 会话 Cookie。
首版暂不提供密码重置、账号停用或细分权限；请妥善保存管理员密码。

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
