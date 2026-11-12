# NodeLoc 阅读时长后台助手

目标：把 NodeLoc 的「阅读时长」按正常阅读节奏累计到 600 分钟（默认目标，可改）。

## 推荐：Tampermonkey 用户脚本

文件：`nodeloc-readtime.user.js`

### 方式 A：最快启动（不装脚本）

1. 打开 NodeLoc 任意页面并确认已登录。
2. 按 `F12` 打开开发者工具，切到 Console。
3. 把 `nodeloc-readtime.user.js` 的全部内容粘贴进去，按 Enter。
4. Console 可以关闭，脚本会继续在当前标签页里运行；页面右下角有进度面板。

如果你习惯书签：把 `nodeloc-readtime.bookmarklet.txt` 里的整行内容保存成一个书签，在 NodeLoc 页面点这个书签即可启动。

这种方式刷新页面后要重新启动。需要长期运行就用下面的方式 B。

### 方式 B：Tampermonkey（刷新后仍自动运行）

1. 打开 Edge 的 Tampermonkey 管理面板。
2. 新建脚本，把 `nodeloc-readtime.user.js` 的内容完整粘进去并保存。
3. 打开/刷新 `https://www.nodeloc.com/latest`，脚本会自动开始；页面右下角显示当前进度。
4. 可以正常切到其他标签页或最小化窗口，**不要关闭这个 NodeLoc 标签页**；电脑不要睡眠。

这个脚本使用当前浏览器已有的登录态，不需要复制 Cookie。它只做三件事：

- 每次随机等 58–76 秒；
- 从真实话题列表里选一个帖子，提交一次正常的 `/topics/timings` 计时；
- 每 3–5 分钟换一个话题，并在触发 429 时按 `Retry-After` 自动退避。

## 后台 CLI（不依赖浏览器标签页）

文件：`nodeloc-readtime.mjs`

适合想完全脱离浏览器运行的情况。先在 NodeLoc 页面打开 Cookie-Editor，点 **Export → JSON**，把导出文件保存到本目录并命名为 `cookies.json`，然后：

```powershell
cd nodeloc-readtime
node .\nodeloc-readtime.mjs --cookie-file .\cookies.json
```

或者双击：

```text
start-background.cmd
```

启动后是隐藏的 Node 进程，**可以关掉 NodeLoc 页面、切去用别的软件**；它不占用鼠标键盘。

停止后台进程：

```powershell
.\stop-background.ps1
```

它会用隐藏窗口启动 Node 进程，日志写到 `nodeloc-readtime.log`，进度写到 `nodeloc-readtime-state.json`。

## 说明

- NodeLoc 的阅读时长按服务端实际经过时间累计，单账号一分钟只能累计约一分钟；脚本不会用并发请求硬刷，避免触发风控。
- 默认目标 600 分钟。当前进度会自动读取，达到后停止。
- 只运行一个实例/一个标签页；多个实例同时跑容易被限速。
- 如果页面提示未登录，先在浏览器正常登录 NodeLoc，再刷新页面。
