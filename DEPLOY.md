# 部署与多人使用 / Deploy & multi-user

现在每个人有自己的账号，**歌曲、歌词、解读、笔记全部按账号隔离**（数据库里每一条都带 `user_id`，所有查询都按当前用户过滤）。AI 的 key 仍由每个人自己填，存在各自的浏览器里，服务器不保存。

## 先在本机用（和以前一样）

```bash
npm start      # http://localhost:3456
```

打开后会看到注册页。**第一个注册的账号会自动继承你之前保存的所有歌曲**（旧数据不会丢）。之后注册的账号是空的。

> 注意：本机模式下，`.env` 里的 `ANTHROPIC_API_KEY` 仍可当作方便的默认 key；一旦用 `HOST=0.0.0.0` 公开部署，它会被自动忽略，别人不能用你的 key。

## 方案一：只有你自己，手机也能用（最简单）

电脑和手机都装 [Tailscale](https://tailscale.com)（免费），登录同一个账号。让电脑上的网站监听所有网卡：

```bash
HOST=0.0.0.0 npm start
```

手机浏览器打开 `http://<电脑的Tailscale名字或IP>:3456`。电脑需要开机。

## 方案二：放到网上，随时随地 + 别人也能注册（Fly.io，约 US$2–5/月）

价格会变，请以 Fly.io 官网为准。SQLite 数据放在一块持久硬盘（volume）上，所以只能跑 **一台** 机器。

```bash
# 1. 安装 flyctl 并登录: https://fly.io/docs/flyctl/install/
fly auth login

# 2. 改 fly.toml 里的 app 名字（要全球唯一），然后创建应用和硬盘
fly apps create <你的app名字>
fly volumes create songdata --size 1 --region sin

# 3. 设置谁可以注册（强烈建议先用邀请码）
fly secrets set INVITE_CODE=<自己想一个邀请码>

# 4. 部署
fly deploy
```

完成后访问 `https://<你的app名字>.fly.dev`，用邀请码注册。想让朋友加入，把网址和邀请码发给他们即可；之后想停止注册，设置 `REGISTRATION=closed`：

```bash
fly secrets set REGISTRATION=closed
```

其他平台（任何能跑 Docker 且有持久硬盘的）也可以：用仓库里的 `Dockerfile`，把硬盘挂到 `/data`。

### 环境变量

| 变量 | 作用 |
|---|---|
| `INVITE_CODE` | 设置后，只有填对邀请码才能注册 |
| `REGISTRATION=closed` | 关闭注册（已有账号仍可登录） |
| `DB_FILE` | SQLite 文件位置（Docker 里是 `/data/songexplain.db`） |
| `HOST=0.0.0.0` | 监听所有网卡（公开部署需要）。**同时会禁用 `.env` 里的服务器 key** |
| `TRUST_PROXY=1` | 在 Fly / Render / Cloudflare 之后运行时需要（正确识别 IP 和 https） |
| `COOKIE_SECURE=1` | 登录 cookie 只通过 https 发送 |
| `ALLOW_SERVER_KEY=1` | 公开部署时仍允许用服务器上的 key（**会花你自己的钱，不建议**） |
| `ALLOW_LOCAL_LLM=1` | 允许自定义 AI 地址指向 localhost（比如 Ollama），只建议本机使用 |

## 备份

所有数据只有一个文件：`/data/songexplain.db`。定期下载一份：

```bash
fly ssh sftp get /data/songexplain.db ./backup-songexplain.db
```

之后想自动备份可以加 [Litestream](https://litestream.io)。每个用户也可以在 **Account → Export my data** 导出自己的数据（JSON），并能自己删除账号和全部数据。

## 对外开放前要注意

- **歌词版权：** 用户的歌词只存在自己的账号里，API 只允许本人读取，不会展示给别人。仍建议写使用条款和版权下架联系方式，并请懂法律的人看一眼。
- **网易云 / YouTube：** 网易云接口是非官方的，从云服务器访问可能被拦；YouTube 评论需要用户自己的 YouTube API key。
- **防滥用：** 已有登录限流（防暴力破解）、搜索 / AI 请求限流、同源写入检查。公开给陌生人前，建议保持邀请码模式。
- **AI 费用：** 每个人用自己的 key，费用不会算到你头上。
- **密码：** 用 scrypt 加盐哈希保存；没有邮件找回密码功能（忘记密码需要你手动处理），这是目前的限制。
