# QZZ 飞书浏览器导入

此扩展安装在 **QZZ 平台服务器这台电脑的 Chrome** 中。使用此 Chrome 已登录、且有阅读和复制权限的飞书账号导入文档，不需要飞书 App ID 或 App Secret。公司其他电脑通过平台网页发起导入即可。

## 首次安装与配对

1. 下载 `QZZ-Feishu-Browser.zip` 并解压，保留里面的 `browser-extension` 文件夹。
2. 在服务器电脑的 Chrome 地址栏输入 `chrome://extensions`，打开「开发者模式」，点击「加载已解压的扩展程序」，选择含 `manifest.json` 的 `browser-extension` 文件夹。
3. 在同一个 Chrome 中打开飞书并登录，确认能正常阅读目标文档。
4. 在 QZZ 平台的飞书连接窗口生成一次性配对码。点击 Chrome 工具栏的「QZZ 飞书文档导入」，填平台端口（默认 `3210`）和 12 位配对码，点击「配对并连接」。
5. 扩展显示「已连接」后，在平台中粘贴飞书 `docx`、`docs` 或 `wiki` 地址即可导入。配对码有效期 5 分钟、仅使用一次；登录失效或权限不足时需先在 Chrome 中处理后重新导入。

服务器电脑和 Chrome 均需运行。配对凭据只保存在此 Chrome 的本地扩展存储中；关闭并重新打开 Chrome 后会自动尝试连接本机平台。更换平台端口或浏览器后请重新配对。点击「断开连接」可暂停自动连接，点击「重新连接」恢复。

## 读取范围和限制

扩展会打开后台标签页，只读取可见正文区域的段落、标题、列表、表格及正常加载的图片，并逐步滚动收集虚拟加载内容；结束后关闭自己创建的标签页，不切换用户当前标签页。正文读取最多约 2 分钟，整个任务最多约 3 分钟。加载不完整、折叠内容、缺失图片、画板/图表和不支持的嵌入对象会明确标记「部分读取」，需要补充原始文件或截图，不能当作已完整分析。

单份导入正文最多 10 万字，图片最多 64 张、合计 64 MiB、单图 4000 万像素。这是导入/模型输入范围；超过时明确提示部分读取或拆分。动图只导入首帧并提示补充原件。文档图片引用 `[file#N]` 对应图片附件 `file-N.png/jpeg/webp`，缺失图片保留提醒。

支持的文档域为 `*.feishu.cn`、`*.larksuite.com`；图片只允许这些域和 `*.feishucdn.com`、`*.larksuitecdn.com`，拒绝跳转和其他域。正常图片请求可利用 Chrome 已有登录会话，扩展不会读取或导出 Cookie、请求头、浏览器配置或其他标签页内容，也不会尝试解除访问、复制限制或抓取网页内部私有状态。平台只收到正文、实际读取的图片及完整性说明。

## 开发与打包

```powershell
npm --prefix browser-extension ci
npm --prefix browser-extension test
./browser-extension/package.ps1
```

ZIP 输出在 `browser-extension/dist/QZZ-Feishu-Browser.zip`，包含顶层 `browser-extension/`。打包只包含脚本、界面、manifest 和本文档，排除依赖、测试、缓存和本地配对凭据。安装需 Chrome 120 或更新版本；使用 Manifest V3、`tabs/scripting/storage/alarms` 和限定域权限，没有全站、Cookie 或调试器权限。

协议为本机 `ws://127.0.0.1:<端口>/api/feishu-browser/events`，pair→paired/token，auth→ready，import→result，cancel，ping/pong；20 秒心跳和重连用于维持连接。实现使用 [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting) 和 [扩展限定域网络请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)。自动化测试使用 DOM fixture 和模拟 WS，不代表已完成真实飞书页面或 Chrome 安装验收。
