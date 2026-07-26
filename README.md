# Solara

> 本仓库是基于 [akudamatata/Solara](https://github.com/akudamatata/Solara) 修改的非官方衍生版本，并非上游官方仓库。

本项目保留原作者署名，并继续采用上游声明的 CC BY-NC-SA 协议：仅限非商业使用，修改版本也须以相同协议公开。

## 与上游版本的主要区别

- 增加用户名/密码注册登录；密码以 PBKDF2-SHA-256 和独立随机盐派生后保存，会话使用 HttpOnly Cookie
- 使用 Cloudflare D1 按内部用户 ID 隔离账号、收藏、播放记录和歌单数据
- 每个账号可创建多个命名歌单，并可切换、重命名、删除以及在歌单间复制或移动歌曲
- 搜索结果可直接选择目标歌单；试听使用独立的临时播放队列，不会自动写入用户歌单，也不会强制跳回播放器
- 保留并整合 JOOX、酷我、网易云和哔哩哔哩搜索，增加分页去重、跨源补充和 GD 接口故障回退
- 下载文件按“歌曲名 - 歌手”命名；支持时会向 MP3/FLAC 写入歌曲信息和封面
- 增加手机端账号、退出登录、歌单管理和搜索结果布局
- 注册账号总数默认限制为 60，可通过 Cloudflare 环境变量调整
- 保留上游播放器、歌词、音质选择、主题和 PWA 等主要能力

音乐搜索和播放地址依赖 GD 音乐台及相应平台，第三方接口失效、限流或曲目版权限制都可能影响可用性。播放通常由浏览器直接请求音频；酷我兼容请求和下载打包会经过 Cloudflare Functions，但本站不建立永久音乐文件库。

## Cloudflare Pages 部署

### 1. 创建 D1

在 Cloudflare 控制台创建 D1 数据库，例如 `solara-db`，然后在 Pages 项目中添加绑定：

```text
Binding name: DB
```

在 D1 控制台执行 [migrations/0001_user_store.sql](migrations/0001_user_store.sql)。

### 2. 账号系统

无需配置 Cloudflare Access。首次访问站点会跳转到 `/login`，用户可以自行注册：

- 用户名：3–24 位字母、数字或下划线，不区分大小写
- 密码：4–128 个字符
- 连续登录失败 5 次后，该用户名与来源 IP 的组合会暂时锁定 10 分钟
- 当前版本不提供邮箱验证或密码找回，请用户自行妥善保管密码

服务端只保存加盐后的密码派生值，不保存明文密码。会话令牌仅通过 HttpOnly Cookie 传输，D1 中只保存令牌的 SHA-256 摘要。

### 3. 音乐接口

默认使用原版 Solara 的 GD 音乐台接口。账号注册上限默认是 60；需要调整时在 Cloudflare Pages 的环境变量中修改：

```dotenv
API_BASE_URL=https://music-api.gdstudio.xyz/api.php
MAX_USERS=60
```

修改 `MAX_USERS` 后重新部署一次即可生效。达到上限只会停止新注册，已有账号不受影响。

### 4. Pages 设置

这是静态网站加 Pages Functions：

```text
Build command: 留空
Build output directory: /
```

也可以直接连接 GitHub 仓库，每次推送自动部署。

## 音乐与下载

搜索元数据和媒体地址来自 GD 音乐台及相应平台。搜索会合并、分页并去除明显重复项；播放前会重新解析媒体地址，以降低保存一段时间后链接失效的影响，但无法保证第三方资源始终可用。

下载接口会尽量使用界面显示的歌曲名和歌手生成文件名，并在格式允许时写入标题、歌手、专辑和封面。请仅下载你有权使用的内容，并遵守音乐平台条款及所在地版权法律。

## 本地开发

安装 Wrangler 后运行 Pages 本地开发服务器，并绑定本地 D1。通过登录页注册测试账号即可验证完整流程。

## 数据结构

账号和会话分别存入 `users`、`sessions`，播放器数据存入 `user_store`：

```text
(internal user id, key) → JSON/string value
```

`user_store` 的复合主键确保两个账号即使使用相同歌单名和存储键，也不会读取或覆盖对方数据。
