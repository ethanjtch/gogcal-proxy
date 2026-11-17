# gogcal-proxy

**借助 Cloudflare 加速 Google 日历同步** — 面向 Apple 原生日历的 CalDAV + OAuth2 网关，跑在 Cloudflare Workers 上。

> ⚠️ 仅供个人学习与自用研究，不隶属于 Google 或 Cloudflare；请遵守当地法律法规及两家平台的服务条款。

## 原理

Google CalDAV 对来自云服务器 IP 的 Basic 认证风控严格。本项目将认证换成 OAuth2（Bearer + 令牌自动续期），让自建服务器稳定同步：

```
Apple 日历 ──CalDAV(Basic 门禁)──► Cloudflare Worker ──OAuth2 Bearer──► Google CalDAV
                                        │ 令牌存 KV，过期自动刷新
```

- 苹果设备无需装 App，原生「日历」直接配置
- 令牌存你自己的 KV，门禁口令与 Google 账号完全解耦
- 只同步日历事件（VEVENT）：**不支持 Google Tasks / Apple「提醒事项」**，账户设置里该项请保持关闭

## 快速开始

**方式 A：一键部署** — [![Deploy with Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ethanjtch/gogcal-proxy)

点击按钮授权 GitHub 与 Cloudflare，一路确认即可（KV 已自动创建绑定、构建连接也已建好）。之后 clone 你自己的 fork 改代码，push 到 `main` 即自动重新部署。

**这一段用不上就不用管。** Deploy 按钮会自己创建并绑定 KV，只有在你**手动**重建 Git 连接、或构建日志报「找不到 KV 命名空间」时才需要：加一个构建变量 `KV_ID`（值 = 面板 → 存储和数据库 → KV 里那个命名空间的 ID），构建命令填 `sed -i "s/REPLACE_WITH_YOUR_KV_NAMESPACE_ID/$KV_ID/g" wrangler.toml`，在构建时把占位符替换成真实 ID（真实 ID 因此不进代码）。

**方式 B：CLI**

```bash
git clone https://github.com/ethanjtch/gogcal-proxy.git && cd gogcal-proxy
npm install && npm test      # 离线单元测试
# 完成下方配置后：npm run deploy
```

## 配置（两种方式都需要）

1. **KV 绑定**（绑定名 `TOKENS`）：方式 A 已自动创建并绑定；方式 B 把 Namespace ID 填入 `wrangler.toml` 两处占位符（`id` 与 `preview_id`）。
2. **四个 Secrets**：部署后必须手动添加，见下方详解。
3. **绑定自定义域名**（推荐）：`*.workers.dev` 子域在部分网络环境可能无法访问。
4. **一次性授权**：在可访问 Google 的网络下打开 `https://<你的域名>/__auth` → 允许。

### 四个 Secrets 是什么、怎么填

**Deploy 按钮不会代填 Secrets**——它只负责创建 Worker 和 KV。这四个必须你自己加，**缺任何一个站点都会返回 500**（页面会直接告诉你缺哪几个，这是刻意的失败关闭设计：宁可不服务，也不无认证裸奔）。

| 变量名（大小写敏感） | 来源 | 取值 |
|---|---|---|
| `CLIENT_ID` | Google Cloud Console | 凭据 → OAuth 客户端（Web 应用）→「客户端 ID」，形如 `1234567890-abcd.apps.googleusercontent.com` |
| `CLIENT_SECRET` | Google Cloud Console | 同一页「客户端密钥」，形如 `GOCSPX-xxxx`；**只显示一次**，丢了点「重置密钥」 |
| `GATE_USER` | 你自己定 | 相当于 Apple 账户里的**用户名**，任意字符串（如 `cal`），不必是邮箱 |
| `GATE_PASS` | 你自己定 | 相当于**密码**，建议 `openssl rand -base64 24` 生成，别用你常用密码 |

前两个来自 [Google Cloud 前置](#google-cloud-前置一次性)那一步创建的 OAuth 客户端；后两个与 Google 完全无关，只是苹果设备连接你这台代理时要输的账密，改它们不影响 Google 授权。

**填写步骤**

1. Worker → **设置** → **变量与 Secrets** → **添加**
2. 类型选 **Secret**（不是 Text / 明文变量）
3. 名称照上表逐字填（大小写不能变），值粘贴或生成
4. 四个都加完后保存；面板会提示需要重新部署，点一次部署（或再 push 一次）生效
5. 验证：`curl -i https://<你的域名>/__status` 返回 **401** 说明门禁已生效；带凭据再访问应返回 200 且 `hasRefreshToken: false`

可选两个，不填不影响同步：`NOTIFY_URL`（Token 失效时推送警报，支持 Bark / Server酱 / Telegram / 通用 Webhook，可含 `{title}` `{msg}` 占位符）、`REDIRECT`（覆盖回调地址，默认按访问域名自动推断）。

## Google Cloud 前置（一次性）

1. [Google Cloud Console](https://console.cloud.google.com) 启用 **Google Calendar API** 与 **CalDAV API**（无需 Tasks API）。
2. OAuth 同意屏选 External，scope 仅 `.../auth/calendar`。
3. 创建 OAuth 客户端（Web application），回调 URI 填 `https://<你的域名>/__callback`，记下 ID 与 Secret。

## 苹果设备添加账户

设置 → 日历 → 账户 → 其他 → CalDAV：服务器 `<你的域名>`，用户名 / 密码填 `GATE_USER` / `GATE_PASS` 对应的值，路径 `/caldav/v2/`，SSL 开启；只勾「日历」。

## 重新授权

正常同步无需操作；改密码 / 撤销授权 / 约 6 个月未用导致 token 失效时，用电脑浏览器打开 `https://<你的域名>/__auth`，弹窗输入门禁凭据即可（或 `curl -u 'user:pass' -L`）。iPhone/iPad Safari 对登录框支持不稳定，请用电脑。

> `/__auth` 在完成授权后默认上锁：无凭据访问返回 401 且零 KV 写入，无需额外防护配置。

## 订阅日历转发（可选）

Google 网页端「按 URL 添加」的订阅日历不会出现在 CalDAV 同步里；苹果端直接订阅官方 ICS 又可能受本地网络限制。本服务提供 `/subscribe` 边缘转发，零配置：

```
https://<你的域名>/subscribe?url=<Google 托管域名的公开 ICS 地址>
```

仅放行 `google.com` / `googleusercontent.com` 域名，防止被当开放代理滥用。

## 已知行为

Apple 端会把每本日历显示成「共享者：<日历名>」，自建的日历也一样。原因是 Google 把每本日历当作独立 principal（`/caldav/v2/<日历ID>/user`），代理原样透传上游 XML，Apple 便按"owner ≠ 当前用户"渲染。**不影响读写，无需处理**——改它反而要跟着 Google 的数据结构走。

## 文件结构

```
worker.js    全部逻辑（门禁 / OAuth / CalDAV 转发 / 订阅转发 / 定时巡检）
tests/       离线单测，不依赖网络
scripts/     部署前预检与部署后冒烟
```

## 排查

```bash
# 链路自检：207 + multistatus 即整链正常
curl -i -X PROPFIND 'https://<你的域名>/caldav/v2/' -H 'Depth: 0' -u 'GATE_USER:GATE_PASS'
# 一键冒烟（门禁/状态/PROPFIND/301/订阅白名单）
GATE_USER=<u> GATE_PASS=<p> npm run smoke -- https://<你的域名>
```

| 症状 | 处理 |
|---|---|
| 苹果端提示密码错误 / 401 | 核对门禁凭据与 Secrets 是否一致 |
| 提醒事项同步报错 | 本项目不支持 Tasks，关闭该开关 |
| `/__status` 显示无 refresh token | 访问 `/__auth` 重新授权 |
| 一键部署后提示未绑定 KV | 官方会自动创建并绑定；若没有，手动建一个命名空间，把 ID 填进 `wrangler.toml` 两处占位符后重新部署 |
| `*.workers.dev` 打不开 | 绑定自定义域名 |

> 💰 个人用量远低于 Cloudflare 免费额度（KV 读写 / Workers 请求），长期零成本；唯一费用风险是被公开滥用——所以务必设置强门禁口令。

## 许可证

[MIT](./LICENSE) © 2026 Ethan Chen
