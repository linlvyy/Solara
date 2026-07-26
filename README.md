# Solara Open

基于 [akudamatata/Solara](https://github.com/akudamatata/Solara) 改造的多账号开放音乐播放器。

本项目继续遵守原项目的 CC BY-NC-SA 协议，仅限非商业使用，衍生项目必须保留原项目署名并以相同协议开源。

## 与原版的区别

- Cloudflare Access 邮箱验证码登录，不保存用户密码
- Cloudflare D1 按登录邮箱隔离数据
- 每个账号拥有独立收藏、播放记录和多个命名歌单
- 可新建、切换、重命名、删除歌单
- Audius：默认主音源，无密钥即可搜索和播放
- Jamendo：配置免费 Client ID 后启用，严格按 `audiodownload_allowed` 展示下载
- Internet Archive：仅检索 Netlabels 集合中带 Creative Commons 或公共领域标记的音频
- GD 音乐台：默认可用的实验性备用搜索，只显示元数据，不在本站播放或下载
- 支持安装为 PWA，手机和电脑均可使用

音频直接从各开放平台传输，Cloudflare Worker 不代理或缓存音频文件。

## Cloudflare Pages 部署

### 1. 创建 D1

在 Cloudflare 控制台创建 D1 数据库，例如 `solara-open-db`，然后在 Pages 项目中添加绑定：

```text
Binding name: DB
```

在 D1 控制台执行 [migrations/0001_user_store.sql](migrations/0001_user_store.sql)。

### 2. 配置邮箱验证码登录

在 Cloudflare Zero Trust → Access → Applications 中给站点域名创建 Self-hosted Application：

- 登录方式启用 One-time PIN
- Allow Policy 可选择允许指定邮箱或指定邮箱域名
- 如要邀请新用户，把其邮箱加入 Allow Policy

Pages Functions 会读取 Cloudflare Access 注入的 `cf-access-authenticated-user-email`，并以该邮箱作为 D1 数据所有者。没有身份请求头时，云同步 API 会返回 401，不会把不同访客的数据混在一起。

### 3. 环境变量

Pages 项目可配置：

```dotenv
# 可选。到 https://developer.jamendo.com/ 免费申请。
JAMENDO_CLIENT_ID=

# 默认开启备用搜索；设为 false 可完全关闭。
GD_EXPERIMENTAL_ENABLED=true

# 可选，仅在 GD_EXPERIMENTAL_ENABLED=true 时使用。
API_BASE_URL=https://music-api.gdstudio.xyz/api.php
```

不要在正式环境设置 `ALLOW_LOCAL_GUEST=true`，该选项只用于本地预览。

### 4. Pages 设置

这是静态网站加 Pages Functions：

```text
Build command: 留空
Build output directory: /
```

也可以直接连接 GitHub 仓库，每次推送自动部署。

## 音乐与下载规则

- Audius：提供完整在线播放；本站不提供下载。
- Jamendo：只有 API 明确返回 `audiodownload_allowed=true` 的曲目才出现下载按钮。
- Internet Archive：只接入带开放许可标记的 Netlabels 音频，可播放和下载。
- GD：只用于检查搜索覆盖率；不解析播放地址，不提供下载。

Spotify、网易云、QQ 音乐等商业平台内容应使用其官方客户端、网页组件或正式授权 API。本项目不提供 stream ripping、无损解析或平台限制绕过。

## 本地开发

安装 Wrangler 后运行 Pages 本地开发服务器，并将 `ALLOW_LOCAL_GUEST` 设为 `true`。本地访客会使用固定的预览身份；正式环境必须由 Cloudflare Access 提供邮箱身份。

## 数据结构

所有云端数据都存入 `user_store`：

```text
(owner email, key) → JSON/string value
```

复合主键确保两个账号即使使用相同歌单名和存储键，也不会读取或覆盖对方数据。
