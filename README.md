# gogcal-proxy

**借助 Cloudflare 加速 Google 日历同步** — 面向 Apple 原生日历（iOS / macOS / iPadOS）的 CalDAV + OAuth2 网关。

*Cloudflare-powered Google Calendar sync for Apple Calendar — a CalDAV + OAuth2 gateway running on Cloudflare Workers.*

> ⚠️ **免责声明**：本项目仅供个人学习与自用研究，不隶属于 Google 或 Cloudflare。使用本项目即表示你自行承担全部风险；请遵守当地法律法规及 Google、Cloudflare 的服务条款，勿用于任何违规或商业化滥用场景。

---

## 它解决什么问题

苹果设备原生日历支持通过 CalDAV 协议同步 Google 日历。Google 的 CalDAV 服务对来自云服务器 / 数据中心 IP 的 **Basic 认证**请求有更严格的风控，常常直接拒绝。本项目把认证方式换成 Google 官方支持的 **OAuth2 授权码 + 令牌自动续期**（Bearer Token），从而让自建服务器也能稳定同步。

- ✅ 苹果设备**无需安装任何 App**，原生「日历」App 直接配置
- ✅ 令牌全部保存在**你自己的 Cloudflare KV** 中，不出现在任何日志
- ✅ 自动续期：access token 过期后由 Worker 用 refresh token 静默换新
- ✅ 门禁口令（GATE_USER / GATE_PASS）与 Google 账号**完全解耦**，随意更换互不影响

## 工作原理

```
┌─────────────┐   CalDAV (Basic 门禁)   ┌──────────────────────┐   OAuth2 Bearer   ┌──────────────┐
│ Apple 日历   │ ──────────────────────► │  gogcal-proxy Worker │ ────────────────► │ Google CalDAV │
│ (你的设备)   │                         │  (Cloudflare Worker) │                   │  apidata.*   │
└─────────────┘                         └──────────────────────┘                   └──────────────┘
                                            │ 令牌存 KV，过期自动刷新
                                            ▼
                                      ┌──────────────┐
                                      │  KV namespace │
                                      └──────────────┘
```

1. 你在苹果设备把 CalDAV 账户指向自己的域名，用户名 / 密码填你设置的 `GATE_USER` / `GATE_PASS`（仅用于给代理上锁）。
2. Worker 校验门禁通过后，用 KV 中缓存的 access token 以 `Bearer` 方式请求 Google CalDAV。
3. token 过期后 Worker 自动用 refresh token 换取新的，客户端无感知。
4. 一次性授权：访问 `https://<你的域名>/__auth`，完成 Google OAuth 授权，令牌写入 KV。

## 文件结构

```
gogcal-proxy/
├── worker.js           # Worker 代码（唯一需要部署的代码）
├── wrangler.toml       # 部署配置（需填入你的 KV 命名空间 ID）
├── package.json        # npm scripts：deploy / dev / check
├── scripts/check.mjs   # 部署前预检脚本
└── README.md
```

## 快速开始

有两条路径，任选其一：

### 方式 A：Deploy with Workers 一键部署（推荐体验）

[![Deploy with Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ethanjtch/gogcal-proxy)

点击上面的按钮 → 授权你的 GitHub 与 Cloudflare 账号 → 在 Cloudflare 面板中一路确认到部署完成（将部署到 `gogcal-proxy.<你的用户名>.workers.dev`）。

> 一键部署只完成「代码上线」。KV 命名空间与 Secrets 仍需按下方「后续配置」补齐（约 3 分钟）。

### 方式 B：本地 CLI（可控性更强）

```bash
git clone https://github.com/ethanjtch/gogcal-proxy.git
cd gogcal-proxy
npm install        # 安装 wrangler
npm run check      # 预检：KV 占位符、登录状态一键排查
# 按下方「后续配置」完成 1-2 步后：
npm run deploy
```

## 后续配置（无论哪种方式都要做，都是面板「确认」操作）

1. **创建并绑定 KV 命名空间**：
   - Cloudflare 面板 → Workers & Pages → KV → 创建命名空间（如 `gogcal-tokens`）。
   - **方式 B（CLI）用户**：把 **Namespace ID** 粘贴到 `wrangler.toml` 的两处 `id`，然后 `npm run deploy`。
   - **方式 A（按钮）用户**：打开 Worker → 设置 → 绑定 → 添加 KV 命名空间绑定：绑定名 `TOKENS`，选择刚创建的命名空间 → 保存并重新部署（面板上点「保存并部署」）。
2. **配置 4 个 Secrets**：Cloudflare 面板 → Workers & Pages → `gogcal-proxy` → 设置 → 变量与 Secrets：

   | 变量名 | 值 |
   |---|---|
   | `CLIENT_ID` | 你的 Google OAuth 客户端 ID（见下方「Google Cloud 前置」） |
   | `CLIENT_SECRET` | 对应的客户端密钥（加密存储，不会显示） |
   | `GATE_USER` | 你自己设置的门禁用户名（可为任意字符串，不必是邮箱） |
   | `GATE_PASS` | 你自己设置的门禁密码（建议 20+ 位随机密码，与 Google 账号无关） |

   可选：`REDIRECT`——默认回调地址按你的域名自动推断，一般无需设置；仅当你想让回调指向别的域名时才需要。
3. **部署 / 重新部署**：方式 A 用户无需重复；方式 B 用户 `npm run deploy`。
4. **绑定自有域名**（强烈推荐）：在 Worker 设置 → 域名与路由 → 添加自定义域名。*提示：`*.workers.dev` 子域在部分网络环境可能无法访问，绑定自有域名可规避。*
5. **一次性授权**：在可访问 Google 的网络环境下打开 `https://<你的域名>/__auth` → 允许 → 看到「✅ 授权成功」。
6. **苹果设备添加账户**：设置 → 日历 → 账户 → 添加账户 → 其他 → 添加 CalDAV 账户：
   - 服务器：`<你的域名>`
   - 用户名：你的 `GATE_USER`
   - 密码：你的 `GATE_PASS`
   - 路径：留空或 `/caldav/v2/`；端口 443；SSL 开启

## Google Cloud 前置（一次性，约 5 分钟）

1. 在 [Google Cloud Console](https://console.cloud.google.com) 新建/选择项目，启用 **Google Calendar API** 与 **CalDAV API**。
2. **OAuth 同意屏**：External 类型；scope 建议仅申请 `.../auth/calendar`（最小权限）。
3. **OAuth 客户端 ID**：类型选 **Web application**；授权回调 URI 填 `https://<你的域名>/__callback`。
4. 记下生成的 **Client ID** 与 **Client Secret**，用于上文 Secrets。

## 配置参数一览

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `CLIENT_ID` | Secret | 是 | Google OAuth 客户端 ID |
| `CLIENT_SECRET` | Secret | 是 | Google OAuth 客户端密钥 |
| `GATE_USER` | Secret | 是 | 代理门禁用户名（任意字符串） |
| `GATE_PASS` | Secret | 是 | 代理门禁密码（与 Google 无关） |
| `REDIRECT` | 变量 | 否 | 覆盖回调地址（默认自动推断） |
| `TOKENS` | KV 绑定 | 是 | 令牌存储（KV 命名空间） |

## 安全说明

- 敏感配置**全部**走 Cloudflare Secrets，仓库内不存任何真实凭据。
- 门禁口令独立于你的 Google 账号：想换就换，换完在苹果设备更新密码即可，不影响 OAuth 授权。支持任意字符（含中文/符号），建议用密码管理器生成 **20+ 位随机密码**。
- KV 中只保存 OAuth 令牌，不保存任何日历内容；`/__status`、授权失败提示均不泄露令牌。
- Google OAuth 客户端请使用最小 scope，并妥善保管 Client Secret（泄漏后在 Google Cloud 重置即可，无需改动本仓库）。
- 长期未使用（约 6 个月）后 refresh token 可能失效，重新访问 `/__auth` 即可恢复。

## 排查命令

```bash
# 链路自检：HTTP 207 + multistatus 即代表整条链路正常
curl -i -X PROPFIND 'https://<你的域名>/caldav/v2/' -H 'Depth: 0' -u 'GATE_USER:GATE_PASS'

# 授权状态：检查 refresh token 是否存在、access token 过期时间
curl -s 'https://<你的域名>/__status' -u 'GATE_USER:GATE_PASS'
```

| 症状 | 原因 | 处理 |
|---|---|---|
| 苹果端一直提示密码错误 / 401 | 门禁口令不符 | 核对 GATE_USER / GATE_PASS 是否与 Secrets 一致 |
| `/__status` 返回 `hasRefreshToken: false` | 未完成授权或令牌过期 | 访问 `/__auth` 重新授权 |
| PROPFIND 返回 401 且无 multistatus | 同上 或 Secrets 缺失 | 检查 4 个 Secrets 是否都已配置 |
| `*.workers.dev` 无法访问 | 部分网络环境可达性差异 | 绑定自有自定义域名 |
| 担心门禁被暴力尝试 | 公开网络上的服务都可能被扫描 | 使用高熵 `GATE_PASS`；必要时在 Cloudflare 面板为该域名配置 Rate Limiting 规则 |

> 💰 **费用提示**：KV 在 Cloudflare 免费套餐中配有免费读写额度，个人日历同步用量（请求频率低、体积小）远低于限额；费用风险主要来自服务被公开滥用——所以务必设置强门禁口令。

## 许可证

[MIT](./LICENSE) © 2026 Ethan Chen