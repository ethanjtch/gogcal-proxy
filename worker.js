// Google CalDAV Gateway for Cloudflare Workers (v7)
// 借助 Cloudflare 加速 Google 日历同步：Apple 设备 -> 本 Worker（自动换 Token） -> Google
// 敏感配置全部从 Cloudflare Worker Secrets（env）读取，请勿硬编码进代码。
// 部署前需配置 Secrets：CLIENT_ID / CLIENT_SECRET / GATE_USER / GATE_PASS
// 并绑定名为 TOKENS 的 KV 命名空间。回调地址默认按部署域名自动推断，也可通过 env.REDIRECT 覆盖。

const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/calendar";
const UPSTREAM_HOST = "apidata.googleusercontent.com";

// ---------- 工具函数 ----------

// 恒定时间字符串比较（避免门禁口令的时序侧信道）
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 解析 HTTP Basic 头：scheme 大小写不敏感、容忍客户端省略 base64 末尾的 "=" 填充、
// 按 UTF-8 解码（门禁口令可能含中文或符号）。返回 "user:pass" 字符串或 null。
function basicCredentials(header) {
  const m = /^\s*basic\s+(\S+)\s*$/i.exec(header || "");
  if (!m) return null;
  let b64 = m[1];
  while (b64.length % 4) b64 += "=";
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// 门禁校验结果：true 通过 / false 不通过 / "misconfigured" 表示 Secrets 缺失或为空。
// 空口令必须直接失败：否则 "Basic " + base64(":") 会让任何人用空用户名密码通过。
function checkGate(request, cfg) {
  if (!cfg.GATE_USER || !cfg.GATE_PASS) return "misconfigured";
  const decoded = basicCredentials(request.headers.get("authorization"));
  if (decoded === null) return false;
  return safeEqual(decoded, cfg.GATE_USER + ":" + cfg.GATE_PASS);
}

function gateMisconfiguredResponse() {
  return new Response(
    "配置缺失：GATE_USER / GATE_PASS 必须为两个非空字符串，否则门禁会失效。请在 Cloudflare Worker 设置中补齐 Secrets。",
    { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
  );
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 回调地址：优先 env.REDIRECT，否则按当前请求的域名动态推断
function redirectUri(env, url) {
  return env.REDIRECT ? env.REDIRECT : url.origin + "/__callback";
}

// 从 env 读取敏感配置（每次请求读取开销可忽略，简单可靠）
function config(env) {
  const cfg = {
    CLIENT_ID: env.CLIENT_ID || "",
    CLIENT_SECRET: env.CLIENT_SECRET || "",
    GATE_USER: env.GATE_USER || "",
    GATE_PASS: env.GATE_PASS || "",
  };
  if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET || !cfg.GATE_USER || !cfg.GATE_PASS) {
    console.error("[gogcal] 缺少 Secrets 配置：请在 Cloudflare Worker 设置中配置 CLIENT_ID/CLIENT_SECRET/GATE_USER/GATE_PASS");
  }
  return cfg;
}

// 并发刷新去重：同一隔离点内多个请求同时发现 token 过期时，只向 Google 发起一次刷新。
// 失败后 30 秒内的重复请求直接返回失败，避免 refresh token 失效时把每个同步请求都变成一次 Google 调用。
let refreshPromise = null;
let refreshFailedAt = 0;
const REFRESH_FAILURE_COOLDOWN = 30 * 1000;

async function refreshAccessToken(cfg, KV) {
  if (refreshFailedAt && Date.now() - refreshFailedAt < REFRESH_FAILURE_COOLDOWN) {
    return { token: null, error: "refresh failed recently" };
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const refresh = await KV.get("refresh_token");
      if (!refresh) return { token: null, error: "no refresh_token" };
      if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) return { token: null, error: "missing client credentials" };
      const body = new URLSearchParams({
        refresh_token: refresh,
        client_id: cfg.CLIENT_ID,
        client_secret: cfg.CLIENT_SECRET,
        grant_type: "refresh_token",
      });
      const r = await fetch(TOKEN_URI, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token) {
        refreshFailedAt = Date.now();
        const reason = data.error_description || data.error || `HTTP ${r.status}`;
        console.error("[gogcal] Token 刷新失败: " + JSON.stringify(data));
        return { token: null, error: reason };
      }
      await KV.put("access_token", data.access_token);
      const ttl = Number(data.expires_in);
      const ms = (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000 - 60000;
      await KV.put("access_expires", String(Date.now() + Math.max(ms, 0)));
      // Google 有可能轮换 refresh token，返回了就覆盖，否则下次刷新会用旧值失败
      if (data.refresh_token) await KV.put("refresh_token", data.refresh_token);
      refreshFailedAt = 0;
      return { token: data.access_token, error: null };
    } catch (e) {
      refreshFailedAt = Date.now();
      console.error("[gogcal] Token 刷新异常: " + (e && e.message));
      return { token: null, error: (e && e.message) || "refresh exception" };
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

// 取当前可用的 access token：未过期直接复用，否则刷新
async function currentToken(cfg, KV, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const token = await KV.get("access_token");
    const exp = Number(await KV.get("access_expires"));
    if (token && Number.isFinite(exp) && exp > 0 && Date.now() < exp) return { token, error: null };
  }
  return refreshAccessToken(cfg, KV);
}

// ---------- CalDAV 路径与上游请求 ----------
const CALDAV_V2 = "/caldav/v2";

// 把客户端路径归一到 Google CalDAV 的 /caldav/v2 前缀（避免 /caldav/v2/ 被二次拼接）
function toUpstreamPath(pathname) {
  const p = pathname || "/";
  if (p === "" || p === "/" || p === "/caldav" || p === "/caldav/" ||
      p === "/.well-known/caldav" || p === "/.well-known/caldav/") {
    return CALDAV_V2 + "/";
  }
  if (p === CALDAV_V2 || p.startsWith(CALDAV_V2 + "/")) return p;
  if (p.startsWith("/caldav/")) return CALDAV_V2 + p.slice("/caldav".length);
  return CALDAV_V2 + p;
}

// 转发到 Google CalDAV：透传请求头但剔除 Host 与 Cloudflare 注入头
function forwardToUpstream(request, url, token, body) {
  const headers = new Headers(request.headers);
  for (const h of ["host", "cf-connecting-ip", "cf-ray", "cf-visitor", "cf-worker", "cf-ipcountry",
    "cf-verification", "cdn-loop", "forwarded", "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
    "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-connection"]) {
    headers.delete(h);
  }
  headers.set("Authorization", "Bearer " + token);
  const init = { method: request.method, headers, redirect: "manual" };
  if (body !== undefined) init.body = body;
  return fetch(`https://${UPSTREAM_HOST}${toUpstreamPath(url.pathname)}${url.search}`, init);
}

// ---------- /subscribe 专用：Google 域名白名单 + 手动跟随重定向 ----------
function isGoogleHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "google.com" || host.endsWith(".google.com") || host.endsWith(".googleusercontent.com");
}

function assertGoogleUrl(u) {
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || !isGoogleHost(u.hostname)) {
    throw new Error("redirected to a non-Google address");
  }
  return u;
}

// 手动跟随重定向：每一跳都重新校验白名单。
// 不能依赖 fetch 自动跟随：Google 的跳转类端点可以指向任意外部域名，会把这个端点变成开放代理。
async function fetchGoogleFollow(start, maxHops = 3) {
  let target = assertGoogleUrl(start);
  for (let hop = 0; hop <= maxHops; hop++) {
    const r = await fetch(target.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Mozilla/5.0 (gogcal-proxy; +https://github.com/ethanjtch/gogcal-proxy)",
        Accept: "text/calendar, text/plain;q=0.8, */*;q=0.5",
      },
    });
    const isRedirect = r.status >= 300 && r.status < 400 && r.headers.get("location");
    if (!isRedirect) return r;
    if (hop === maxHops) {
      await r.body?.cancel();
      throw new Error("too many redirects");
    }
    await r.body?.cancel();
    target = assertGoogleUrl(new URL(r.headers.get("location"), target));
  }
  throw new Error("too many redirects");
}

// 消息推送助手（支持 GET 占位符 URL 或 POST Webhook）
async function sendNotification(env, title, message) {
  const notifyUrl = env.NOTIFY_URL;
  if (!notifyUrl) return;
  try {
    const fullText = `${title}: ${message}`;
    if (notifyUrl.includes("{title}") || notifyUrl.includes("{msg}") || notifyUrl.includes("{text}")) {
      const url = notifyUrl
        .replace(/{title}/g, encodeURIComponent(title))
        .replace(/{msg}/g, encodeURIComponent(message))
        .replace(/{text}/g, encodeURIComponent(fullText));
      await fetch(url);
    } else {
      await fetch(notifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, message, text: fullText }),
      });
    }
  } catch (e) {
    console.error("[gogcal] 推送消息发送异常:", e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const cfg = config(env);
    const url = new URL(request.url);
    const KV = env.TOKENS; // KV 命名空间绑定，用于存 token

    // ========== 0. KV 绑定缺失防御（一键部署/未配置时给出清晰指引） ==========
    if (!KV) {
      return new Response(
        "配置缺失：请先在 Cloudflare 面板为 Worker 绑定 KV 命名空间（绑定名 TOKENS）。详见 README「后续配置」步骤 1。",
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    // ========== 0.5 浏览器/发现流程友好处理（CalDAV 协议请求仍走代理） ==========
    // .well-known 发现：RFC 6764 要求 301 重定向到 CalDAV 资源（Apple 设备依赖此行为）
    if ((url.pathname === "/.well-known/caldav" || url.pathname === "/.well-known/caldav/") && (request.method === "GET" || request.method === "HEAD")) {
      return Response.redirect(url.origin + "/caldav/v2/", 301);
    }
    // 根路径纯浏览器访问：返回说明页（不代理到 Google，避免 404；不暴露内部端点）
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const page = `<div style="font-family:-apple-system,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;line-height:1.7">
  <h1>Google 日历同步网关 · CalDAV Gateway</h1>
  <p>此服务将 Apple 设备的原生「日历」App 接入 Google 日历（CalDAV + OAuth2）。</p>
  <p>本实例为个人自建服务。想搭建同款？见开源仓库 <a href="https://github.com/ethanjtch/gogcal-proxy" style="color:#0366d6">github.com/ethanjtch/gogcal-proxy</a>（含一键部署指引）。</p>
  <p style="color:#666;font-size:.9em">This endpoint serves CalDAV protocol traffic only.</p>
</div>`;
      return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // ========== 1. 授权入口（仅按需启用，防公开刷写 KV） ==========
    if (url.pathname === "/__auth") {
      // 已授权后默认上锁：必须携带门禁凭据才能重新授权，杜绝公开端点被用作 KV 写入放大器
      const hasRefresh = !!(await KV.get("refresh_token"));
      if (hasRefresh) {
        const gate = checkGate(request, cfg);
        if (gate === "misconfigured") return gateMisconfiguredResponse();
        if (!gate) {
          // 用 401 + WWW-Authenticate 触发浏览器 Basic 弹窗（403 不会弹）
          return new Response("此实例已完成授权。如需重新授权，请携带门禁凭据访问本入口（浏览器会弹出登录框）。", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="gogcal"', "content-type": "text/plain; charset=utf-8" },
          });
        }
      }
      // 简易限速（Cache API，不消耗 KV 配额）：同一 IP 60 秒内最多 20 次进入授权流程
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const cacheKey = new Request("https://" + url.host + "/__rl/" + ip);
      const cached = await caches.default.match(cacheKey);
      const count = cached ? Number(await cached.text()) || 0 : 0;
      if (count >= 20) {
        return new Response("请求过于频繁，请稍后再试。", { status: 429 });
      }
      await caches.default.put(cacheKey, new Response(String(count + 1), { headers: { "Cache-Control": "max-age=60" } }));
      const state = crypto.randomUUID();
      await KV.put("oauth_state", state, { expirationTtl: 600 }); // 防 CSRF：回调时校验，10 分钟后自动失效
      const params = new URLSearchParams({
        client_id: cfg.CLIENT_ID,
        redirect_uri: redirectUri(env, url),
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
      });
      return Response.redirect(AUTH_URI + "?" + params.toString(), 302);
    }

    // ========== 2. 回调：校验 state 后，用 code 换 token 并存入 KV ==========
    if (url.pathname === "/__callback") {
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (err || !code) {
        return new Response(`授权失败: ${err || "缺少 code"}，请重新访问 /__auth`, { status: 400 });
      }
      // state 校验（CSRF 防护）
      const state = url.searchParams.get("state") || "";
      const storedState = await KV.get("oauth_state");
      await KV.delete("oauth_state");
      if (!storedState || !safeEqual(state, storedState)) {
        return new Response("state 校验失败，请重新访问 /__auth", { status: 400 });
      }
      try {
        const body = new URLSearchParams({
          code,
          client_id: cfg.CLIENT_ID,
          client_secret: cfg.CLIENT_SECRET,
          redirect_uri: redirectUri(env, url),
          grant_type: "authorization_code",
        });
        const r = await fetch(TOKEN_URI, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        const data = await r.json();
        if (!r.ok || !data.refresh_token) {
          return new Response(`Token 交换失败: ${JSON.stringify(data)}`, { status: 502 });
        }
        await KV.put("refresh_token", data.refresh_token);
        await KV.put("access_token", data.access_token);
        await KV.put("access_expires", String(Date.now() + (data.expires_in - 60) * 1000));
        return new Response(
          `<h2 style='font-family:sans-serif'>✅ 授权成功！Token 已保存。</h2><p style='font-family:sans-serif'>现在可以在苹果设备上开始同步了（服务器地址为 ${esc(url.host)}）。</p>`,
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      } catch (e) {
        return new Response("Token 交换异常: " + e.message, { status: 502 });
      }
    }

    // ========== 2.5 订阅日历转发（ICS 代理）：/subscribe?url=<公开ICS> ==========
    // 用途：Google CalDAV 不暴露「按 URL 添加」的订阅日历，且本地网络直连 calendar.google.com
    // 可能受限——本端点在 Cloudflare 边缘抓取目标公开 ICS 再返回给 Apple 端「订阅日历」。
    // 只支持 /subscribe?url=<Google 公开 ICS 地址> 直传（零注册）。白名单仅放行 Google 托管域，
    // 防止端点被当作开放代理滥用；不要求门禁凭据（Apple 的订阅日历不支持认证）。
    if (url.pathname === "/subscribe" || url.pathname.startsWith("/subscribe/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS" },
        });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("此端点只支持 GET / HEAD", {
          status: 405,
          headers: { allow: "GET, HEAD, OPTIONS", "content-type": "text/plain; charset=utf-8" },
        });
      }
      const direct = url.searchParams.get("url");
      if (!direct) {
        return new Response("缺少 url 参数。用法: /subscribe?url=<Google 公开 ICS 地址>", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      let t;
      try {
        t = new URL(direct);
      } catch {
        return new Response("url 参数不是合法地址", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (t.protocol !== "https:" || t.username || t.password || (t.port && t.port !== "443") || !isGoogleHost(t.hostname)) {
        return new Response("仅允许 Google 域名下的公开 ICS 地址（https，默认端口，不带凭据）", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      try {
        const r = await fetchGoogleFollow(t, 3);
        const out = new Headers(r.headers);
        // 不把上游的 set-cookie / hsts 等控制性头透给客户端
        for (const h of ["set-cookie", "set-cookie2", "strict-transport-security", "content-security-policy",
          "transfer-encoding", "connection", "keep-alive"]) out.delete(h);
        out.set("content-type", r.headers.get("content-type") || "text/calendar; charset=utf-8");
        out.set("access-control-allow-origin", "*");
        out.set("cache-control", "max-age=300");
        return new Response(r.body, { status: r.status, headers: out });
      } catch (e) {
        return new Response("订阅源抓取失败: " + e.message, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    }

    // ========== 3. 门禁校验（除 /__auth 与 /__callback 外所有请求） ==========
    const gate = checkGate(request, cfg);
    if (gate === "misconfigured") return gateMisconfiguredResponse();
    if (!gate) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="gogcal"', "content-type": "text/plain; charset=utf-8" },
      });
    }

    // ========== 4. 状态查看（排查用，不泄露 token） ==========
    if (url.pathname === "/__status") {
      const hasRefresh = !!(await KV.get("refresh_token"));
      const exp = Number((await KV.get("access_expires")) || 0);
      return new Response(JSON.stringify({
        hasRefreshToken: hasRefresh,
        accessTokenExpires: exp ? new Date(exp).toISOString() : null,
        now: new Date().toISOString(),
      }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    // ========== 5. 获取 / 刷新 Access Token ==========
    const bodyMethod = !["GET", "HEAD"].includes(request.method);
    // 有 body 的请求（PROPFIND / PUT / REPORT）先缓冲：401 重试时需要重发同一个 body，流只能读一次
    const requestBody = bodyMethod && request.body ? await request.arrayBuffer() : undefined;

    const issued = await currentToken(cfg, KV);
    if (!issued.token) {
      if (!(await KV.get("refresh_token"))) {
        return new Response(`尚未授权：请先访问 ${url.origin}/__auth 完成一次性授权`, { status: 401 });
      }
      return new Response(`Token 刷新失败（${issued.error || "unknown"}），可能需要重新授权。请访问 ${url.origin}/__auth`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // ========== 6. 代理到 Google CalDAV（用 Bearer Token） ==========
    let resp;
    try {
      resp = await forwardToUpstream(request, url, issued.token, requestBody);
    } catch (e) {
      return new Response("Proxy error: " + e.message, { status: 502 });
    }

    // 上游判定 token 失效：清缓存、强制刷新后重试一次。
    // 不重试的话 Apple 会直接收到 401 并提示“密码错误”，而用户什么都没改。
    if (resp.status === 401) {
      await KV.put("access_token", "");
      await resp.body?.cancel();
      const retried = await currentToken(cfg, KV, { forceRefresh: true });
      if (retried.token) {
        try {
          resp = await forwardToUpstream(request, url, retried.token, requestBody);
        } catch (e) {
          return new Response("Proxy error: " + e.message, { status: 502 });
        }
        if (resp.status === 401) await KV.put("access_token", "");
      } else {
        return new Response(`Google 授权失效（${retried.error || "unknown"}），请访问 ${url.origin}/__auth 重新授权`, {
          status: 401,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    const out = new Headers(resp.headers);
    // 上游下发的绝对地址（Location / Content-Location）指回自己，否则客户端会绕过代理直连 Google
    for (const headerName of ["location", "content-location"]) {
      const loc = out.get(headerName);
      if (!loc) continue;
      try {
        const locUrl = new URL(loc, `https://${UPSTREAM_HOST}`);
        if (locUrl.host === UPSTREAM_HOST) out.set(headerName, url.origin + locUrl.pathname + locUrl.search);
      } catch {}
    }
    if (resp.status === 401 && !out.has("www-authenticate")) {
      out.set("www-authenticate", 'Basic realm="google-caldav", charset="UTF-8"');
    }
    out.set("access-control-allow-origin", "*");
    return new Response(resp.body, { status: resp.status, headers: out });
  },

  // ========== 7. 定时巡检：检查 OAuth Token 有效性，失效时主动推送通知 ==========
  async scheduled(event, env, ctx) {
    const cfg = config(env);
    const KV = env.TOKENS;
    if (!KV) return;

    const refresh = await KV.get("refresh_token");
    if (!refresh) {
      console.warn("[gogcal] 定时巡检：未配置 refresh_token，跳过验证");
      return;
    }

    const result = await refreshAccessToken(cfg, KV);
    if (!result.token) {
      console.error("[gogcal] 定时巡检：refresh_token 已失效（" + result.error + "）");
      // 24 小时内只告警一次，避免连续失败时反复推送
      const last = Number(await KV.get("alert_at")) || 0;
      if (Date.now() - last > 24 * 3600 * 1000) {
        await KV.put("alert_at", String(Date.now()));
        await sendNotification(
          env,
          "gogcal-proxy 警报",
          "Google OAuth 授权已失效，日历同步已中断！请尽快访问 /__auth 重新授权。"
        );
      }
    } else {
      console.log("[gogcal] 定时巡检：Token 状态正常");
    }
  },
};