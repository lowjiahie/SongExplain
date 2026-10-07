# 部署与多人使用 / Deploy & multi-user

现在每个人有自己的账号，**歌曲、歌词、解读、笔记全部按账号隔离**（数据库里每一条都带 `user_id`，所有查询都按当前用户过滤）。AI 的 key 由每个人自己填，有两种用法：**默认「不保存」**，key 只留在当前标签页的内存里，每次请求时带给服务器用一次就忘，不写数据库、不写浏览器存储，刷新或关掉页面就没了；也可以勾选 **Remember**，让服务器**加密保存**（AES-256-GCM），页面只显示末 4 位。浏览器里从不保存 key。每个模型必须先通过「测试连接」才能使用。

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

# 3. 设置加密主密钥（必填！用来加密用户保存的 API key）和邀请码
fly secrets set APP_SECRET="$(openssl rand -base64 48)"
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
| `APP_SECRET` | **公开部署必填**，至少 32 个字符。用来加密用户的 API key；丢失它，所有已保存的 key 都无法解密（用户需要重新填写）。本机使用时会自动生成到 `data/.app-secret` |
| `INVITE_CODE` | 设置后，只有填对邀请码才能注册 |
| `REGISTRATION=closed` | 关闭注册（已有账号仍可登录） |
| `DB_FILE` | SQLite 文件位置（Docker 里是 `/data/songexplain.db`） |
| `HOST=0.0.0.0` | 监听所有网卡（公开部署需要）。**同时会禁用 `.env` 里的服务器 key** |
| `TRUST_PROXY=1` | 在 Fly / Render / Cloudflare 之后运行时需要（正确识别 IP 和 https） |
| `COOKIE_SECURE=1` | 登录 cookie 只通过 https 发送 |
| `ALLOW_SERVER_KEY=1` | 公开部署时仍允许用服务器上的 key（**会花你自己的钱，不建议**） |
| `ALLOW_LOCAL_LLM=1` | 允许自定义 AI 地址指向 localhost（比如 Ollama），只建议本机使用 |

## 让朋友试用（社区：分享自己的想法）

每首歌的 **Community** 标签会显示这个应用里其他人**主动分享**的想法。默认全部私有，要在 “My feelings” 里勾选 *Share* 才会公开，并且只显示昵称，不显示邮箱。

建议的试用方式（**每人一个一次性邀请码**）：

```bash
fly secrets set REGISTRATION=invite
fly secrets set ADMIN_EMAILS=<你自己的邮箱>      # 可以填多个，用逗号分隔
```

1. 用 `ADMIN_EMAILS` 里的邮箱**直接注册**（管理员不需要邀请码，这样你才能创建第一个账号）。
2. 登录后点右上角 **Account → Invite codes**，写上这个码是给谁的（只是你自己的备注），选有效期（1 / 7 / 30 天），点 **Create code**。
3. 页面会显示一个像 `K7M2-9QXF` 的码，**只显示这一次**，点 Copy 后私下发给那一个人。数据库里只保存它的哈希，所以连你之后也看不到完整的码。
4. 朋友在注册页的 **Invite code** 一栏填上就能注册。**这个码用一次就失效**，传给别人也没用；没用过的码可以随时 **Revoke** 撤销，列表里能看到谁用了哪个码。

- **谁有权限创建邀请码：** 只有 `ADMIN_EMAILS` 里的账号。普通用户做不到。
- **安全默认值：** 公开部署（`HOST=0.0.0.0`）又没有任何设置时，注册默认是“需要邀请码”，不会变成人人可注册。想完全关闭注册用 `REGISTRATION=closed`（管理员仍可注册）。
- `INVITE_CODE`（所有人共用一个码）仍然可用，但不推荐：知道它的人都能注册。
- 只有登录的人能看到社区内容，所以只要控制好邀请码，外人就看不到。
- **规则：** 公开的想法最多 1,500 字，不能带链接，不能贴整段歌词（一次引用 1–2 句可以），每人每天最多公开 10 条。
- **举报：** 每条别人的想法都有 report 按钮；**3 个不同的人**举报，会自动隐藏，等你处理。
- **管理：** `ADMIN_EMAILS` 里的账号，在 Account 窗口里会多出 **Moderation** 按钮，可以隐藏、恢复，或忽略举报；在社区里也能直接对任意一条点 hide。作者自己仍然看得到被隐藏的帖子。
- 删除账号会同时删除这个人公开过的所有想法和他提交的举报。

## 使用条款、隐私说明与人数上限（邀请别人之前必做）

应用自带两个页面：`/legal/terms`（使用条款，英文 + 中文）和 `/legal/privacy`（隐私通知，**英文 + 马来文 + 中文**，因为马来西亚 PDPA 要求通知要有英文和国语版本）。每个页面底部、注册页都有链接。

**这是按马来西亚小型邀请制测试起草的草稿，不是法律意见。正式公开前请让律师审阅。**

部署时设置：

```bash
fly secrets set OPERATOR_NAME="你的名字" CONTACT_EMAIL="你的联系邮箱" HOSTING_NOTE="Fly.io（服务器在新加坡）" MAX_USERS=50
# 登录页的使用指南链接（Google Drive 的 PDF 分享链接，须为 https）：
fly secrets set GUIDE_URL="https://drive.google.com/file/d/xxxx/view?usp=sharing"
```

- `CONTACT_EMAIL` 没设置时，条款里会显示一个红色占位符，启动时终端也会提醒你。版权下架的联系方式就是这个邮箱。
- 注册时必须勾选 “我已满 18 岁并同意条款和隐私通知”，服务器会记录同意的版本和时间。以后修改了条文（改 `legal.js` 里的 `LEGAL_VERSION`），所有人下次登录会被要求重新同意。已有账号第一次登录也会弹出确认窗口。
- **最低年龄是 18 岁。** 如果想改成别的年龄，同时改 `legal.js` 和注册页的文字。
- 隐私通知里写了备份保留最多 30 天，请确认你的备份做法与此一致，不一致就修改文字。
- `MAX_USERS=50` 是账号总数上限（管理员不受限）。额满后注册页会提示 “beta is full”，创建邀请码也不能超过剩余名额。
- Account → Invite codes 里可以一次生成多个码（`How many codes?`，最多 50），会自动加编号备注，例如 “XHS #1 … #50”，有 **Copy all** 一键复制；窗口里会显示 “Places: 12 of 50 taken · 5 unused codes out · 33 left to invite”。

## 备份

所有数据只有一个文件：`/data/songexplain.db`（API key 在里面是加密的）。**请另外安全地保存好 `APP_SECRET`**，没有它，备份里的 key 无法解密。定期下载一份：

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
