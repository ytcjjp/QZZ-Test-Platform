# Windows 服务控制器

打开 `desktop/publish/QZZ.ServerControl.exe`。首次使用前，需要在项目根目录安装
Node.js 22+ 依赖并构建网页：`npm install`、`npm run build`。控制器必须留在
`D:\子弦\QZZ公共测试平台` 项目目录内，不能单独复制 EXE 到其他目录运行。

- “启动服务”会运行 `node server/index.js`；“停止服务”仅终止该控制器启动的服务，
  不会结束其他 Node 进程。关闭窗口会隐藏到系统托盘；托盘菜单“退出”会停止服务。
- 命令行运行 `desktop/publish/QZZ.ServerControl.exe --start` 会打开控制器并启动服务；
  控制器已运行时，会通知已有窗口启动服务。此参数不修改自动启动配置或注册表。
  `--autostart` 用于 Windows 登录启动，仅在已勾选自动启动时启动服务并隐藏到托盘。
- “登录 Windows 后自动开启服务”默认关闭。勾选并保存后，当前账号下次**登录**
  Windows 时会从托盘自动启动；电脑仅开机而未登录、睡眠或断网时无法访问。
- 端口、上传上限、AI 接口地址、模型和密钥在“配置”页保存，已运行的服务需要
  停止后重新启动才会使用新配置。密钥使用当前 Windows 账号的 DPAPI 加密，
  不能从另一个 Windows 账号或另一台电脑解密。
- 配置保存在忽略 Git 的 `data/controller.json`。首次启动生成的管理员密码保存在
  `data/initial-admin.txt`，可在控制器中打开；管理员首次登录后文件会删除。
  数据库和上传文件也保存在 `data/`，均不会提交到 Git。
- 控制器显示本机和内网网址。其他电脑访问前，需确认在同一可互访网络、
  Windows 防火墙允许该 TCP 端口，以及公司网络策略允许设备间通信。

EXE 是独立的 Windows x64 .NET 发布包，无需另装 .NET 运行时，仍然需要
Node.js 22+。用于重新构建时，在项目根目录执行：

```powershell
dotnet publish desktop/QZZ.ServerControl.csproj -c Release -r win-x64 -p:PublishSingleFile=true -p:SelfContained=true -p:EnableCompressionInSingleFile=true -o desktop/publish
```
