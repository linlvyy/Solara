# Solara

基于 [akudamatata/Solara](https://github.com/akudamatata/Solara) 增加多账号隔离与多歌单功能。

本项目继续遵守原项目的 CC BY-NC-SA 协议，仅限非商业使用，衍生项目必须保留原项目署名并以相同协议开源。

## 与原版的区别

- 免费的用户名/密码注册登录，不依赖 Cloudflare Zero Trust 付费授权
- 密码使用 PBKDF2-SHA-256 与独立随机盐处理后存储
- HttpOnly、Secure、SameSite 会话 Cookie，30 天自动失效
- Cloudflare D1 按内部用户 ID 隔离数据
- 每个账号拥有独立收藏、播放记录和多个命名歌单
- 可新建、切换、重命名、删除歌单
- 保留原版 Solara 的网易云、酷我、JOOX、哔哩哔哩搜索入口
- 保留原版的播放、歌词、音质选择与下载流程
- 支持安装为 PWA，手机和电脑均可使用

音频直接从各开放平台传输，Cloudflare Worker 不代理或缓存音频文件。

## Cloudflare Pages 部署

### 1. 创建 D1

在 Cloudflare 控制台创建 D1 数据库，例如 `solara-open-db`，然后在 Pages 项目中添加绑定：

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

音乐搜索、播放与下载行为与原版 Solara 保持一致，实际可用性取决于 GD 音乐台接口及对应平台。

## 本地开发

安装 Wrangler 后运行 Pages 本地开发服务器，并绑定本地 D1。通过登录页注册测试账号即可验证完整流程。

## 数据结构

账号和会话分别存入 `users`、`sessions`，播放器数据存入 `user_store`：

```text
(internal user id, key) → JSON/string value
```

`user_store` 的复合主键确保两个账号即使使用相同歌单名和存储键，也不会读取或覆盖对方数据。
