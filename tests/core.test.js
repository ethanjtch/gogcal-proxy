// 核心链路测试：门禁、路径归一、Token 刷新与 401 重试、重定向改写、订阅白名单。
// 只依赖 node:test + 全局 fetch 打桩，不需要 wrangler 或网络。
import test from "node:test";
import assert from "node:assert/strict";

const CALDAV = "https://apidata.googleusercontent.com";
const TOKEN = "https://oauth2.googleapis.com/token";

// 每个用例拿一个全新的模块实例，避免 refreshPromise / refreshFailedAt 这类模块级状态互相污染
let seq = 0;
const loadWorker = async () => (await import(`../worker.js?case=${++seq}`)).default;

function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

function baseEnv(kvInit) {
  return {
    TOKENS: fakeKV(kvInit),
    CLIENT_ID: "cid",
    CLIENT_SECRET: "csecret",
    GATE_USER: "user",
    GATE_PASS: "pass",
  };
}

const validTokens = () => ({
  refresh_token: "rt",
  access_token: "at-old",
  access_expires: String(Date.now() + 3600_000),
});

// 记录所有上游调用，便于断言路径、头部与重发次数
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const call = { url, method: (init.method || "GET").toUpperCase(), headers: new Headers(init.headers || {}), body: init.body };
    calls.push(call);
    return handler(call, calls.length);
  };
  return calls;
}

const okCalDav = (body = "<ok/>", status = 207) =>
  new Response(body, { status, headers: { "content-type": "application/xml" } });

// ---------- 门禁 ----------

test("门禁：GATE_PASS 为空时必须失败关闭，不能用空口令通过", async () => {
  const worker = await loadWorker();
  const env = baseEnv(validTokens());
  env.GATE_PASS = "";
  let upstreamHit = false;
  stubFetch(() => { upstreamHit = true; return okCalDav(); });

  const res = await worker.fetch(
    new Request("https://proxy.test/caldav/v2/", { method: "PROPFIND", headers: { authorization: basic("user", "") } }),
    env, {}
  );
  assert.equal(res.status, 500);
  assert.equal(upstreamHit, false);
});

test("门禁：缺少 Authorization 返回 401 且带 WWW-Authenticate", async () => {
  const worker = await loadWorker();
  stubFetch(() => okCalDav());
  const res = await worker.fetch(new Request("https://proxy.test/caldav/v2/", { method: "PROPFIND" }), baseEnv(validTokens()), {});
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /^Basic realm=/);
});

test("门禁：scheme 大小写不敏感、容忍 base64 缺少填充、支持非 ASCII 口令", async () => {
  const worker = await loadWorker();
  const env = baseEnv(validTokens());
  env.GATE_USER = "张三";
  env.GATE_PASS = "口令";
  stubFetch(() => okCalDav());

  const raw = Buffer.from(`${env.GATE_USER}:${env.GATE_PASS}`, "utf8").toString("base64");
  const unpadded = raw.replace(/=+$/, "");
  const res = await worker.fetch(
    new Request("https://proxy.test/caldav/v2/", { method: "PROPFIND", headers: { authorization: "BASIC " + unpadded } }),
    env, {}
  );
  assert.equal(res.status, 207);
});

// ---------- 路径归一 ----------

test("路径：/caldav/v2/ 不会被二次拼接，/caldav/xxx 补齐 v2 前缀", async () => {
  const worker = await loadWorker();
  const calls = stubFetch(() => okCalDav());

  const cases = [
    ["https://proxy.test/caldav/v2/", "/caldav/v2/"],
    ["https://proxy.test/caldav/v2/user%40gmail.com/events/", "/caldav/v2/user%40gmail.com/events/"],
    ["https://proxy.test/caldav/v2", "/caldav/v2"],
    ["https://proxy.test/caldav/user%40gmail.com/", "/caldav/v2/user%40gmail.com/"],
    ["https://proxy.test/", "/caldav/v2/"],
  ];
  for (const [target, expectedPath] of cases) {
    await worker.fetch(new Request(target, { method: "PROPFIND", headers: { authorization: basic("user", "pass") } }), baseEnv(validTokens()), {});
    const got = new URL(calls.at(-1).url);
    assert.equal(got.origin, "https://apidata.googleusercontent.com");
    assert.equal(got.pathname, expectedPath, `输入 ${target}`);
  }
});

test("路径：透传 query，剔除 Host 与 Cloudflare 注入头，注入 Bearer", async () => {
  const worker = await loadWorker();
  const calls = stubFetch(() => okCalDav());

  await worker.fetch(
    new Request("https://proxy.test/caldav/v2/?start=2026-01-01T00:00:00Z", {
      method: "PROPFIND",
      headers: { authorization: basic("user", "pass"), host: "proxy.test", "cf-connecting-ip": "1.2.3.4" },
    }),
    baseEnv(validTokens()), {}
  );

  const call = calls.at(-1);
  assert.equal(new URL(call.url).search, "?start=2026-01-01T00:00:00Z");
  assert.equal(call.headers.get("authorization"), "Bearer at-old");
  assert.equal(call.headers.get("host"), null);
  assert.equal(call.headers.get("cf-connecting-ip"), null);
});

// ---------- Token ----------

test("Token：未授权时返回 401 并指引到 /__auth", async () => {
  const worker = await loadWorker();
  stubFetch(() => okCalDav());
  const res = await worker.fetch(
    new Request("https://proxy.test/caldav/v2/", { method: "PROPFIND", headers: { authorization: basic("user", "pass") } }),
    baseEnv({}), {}
  );
  assert.equal(res.status, 401);
  assert.match(await res.text(), /__auth/);
});

test("Token：过期时自动刷新，并把新 token 写回 KV", async () => {
  const worker = await loadWorker();
  const env = baseEnv({ refresh_token: "rt", access_token: "stale", access_expires: "0" });
  stubFetch((call) => {
    if (call.url.startsWith(TOKEN)) {
      return new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), { status: 200 });
    }
    return okCalDav();
  });

  const res = await worker.fetch(
    new Request("https://proxy.test/caldav/v2/", { method: "PROPFIND", headers: { authorization: basic("user", "pass") } }),
    env, {}
  );
  assert.equal(res.status, 207);
  assert.equal(env.TOKENS.dump().access_token, "at-new");
  assert.ok(Number(env.TOKENS.dump().access_expires) > Date.now());
});

test("Token：上游返回 401 时强制刷新并重试一次，客户端不应收到 401", async () => {
  const worker = await loadWorker();
  const env = baseEnv(validTokens());
  let caldavHits = 0;
  const calls = stubFetch((call) => {
    if (call.url.startsWith(TOKEN)) {
      return new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), { status: 200 });
    }
    caldavHits++;
    // 旧 token 被上游判定失效
    if (call.headers.get("authorization") === "Bearer at-old") {
      return new Response("expired", { status: 401 });
    }
    return okCalDav();
  });

  const res = await worker.fetch(
    new Request("https://proxy.test/caldav/v2/", { method: "PROPFIND", headers: { authorization: basic("user", "pass") } }),
    env, {}
  );
  assert.equal(res.status, 207);
  assert.equal(caldavHits, 2);
  assert.equal(calls.filter((c) => c.url.startsWith(TOKEN)).length, 1);
});

test("Token：PUT 的请求体在 401 重试时能被完整重发", async () => {
  const worker = await loadWorker();
  const env = baseEnv(validTokens());
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
  const bodies = [];
  stubFetch(async (call) => {
    if (call.url.startsWith(TOKEN)) {
      return new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), { status: 200 });
    }
    bodies.push(await new Response(call.body).text());
    if (call.headers.get("authorization") === "Bearer at-old") return new Response("expired", { status: 401 });
    return new Response(null, { status: 201 });
  });

  const res = await worker.fetch(
    new Request("https://proxy.test/caldav/v2/user%40gmail.com/events/x.ics", {
      method: "PUT",
      headers: { authorization: basic("user", "pass"), "content-type": "text/calendar" },
      body: ics,
    }),
    env, {}
  );
  assert.equal(res.status, 201);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], ics);
  assert.equal(bodies[1], ics);
});

test("Token：Google 轮换 refresh_token 时必须写回 KV", async () => {
  const worker = await loadWorker();
  const env = baseEnv({ refresh_token: "rt-old", access_token: "", access_expires: "0" });
  stubFetch((call) => {
    if (call.url.startsWith(TOKEN)) {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt-new" }), { status: 200 });
    }
    return okCalDav();
  });

  await worker.fetch(
    new Request("https://proxy.test/caldav/v2/", { method: "PROPFIND", headers: { authorization: basic("user", "pass") } }),
    env, {}
  );
  assert.equal(env.TOKENS.dump().refresh_token, "rt-new");
});

test("Token：刷新失败时不把上游 401 伪装成成功，返回 502 并说明原因", async () => {
  const worker = await loadWorker();
  const env = baseEnv({ refresh_token: "rt-bad", access_token: "", access_expires: "0" });
  stubFetch((call) => {
    if (call.url.startsWith(TOKEN)) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return okCalDav();
  });

  const res = await worker.fetch(
    new Request("https://proxy.test/caldav/v2/", { method: "PROPFIND", headers: { authorization: basic("user", "pass") } }),
    env, {}
  );
  assert.equal(res.status, 502);
  assert.match(await res.text(), /invalid_grant/);
});

// ---------- 重定向改写 ----------

test("重定向：Location 与 Content-Location 都改写回代理域名", async () => {
  const worker = await loadWorker();
  stubFetch(() =>
    new Response(null, {
      status: 301,
      headers: {
        location: `${CALDAV}/caldav/v2/user%40gmail.com/`,
        "content-location": `${CALDAV}/caldav/v2/user%40gmail.com/events/`,
      },
    })
  );

  const res = await worker.fetch(
    new Request("https://proxy.test/caldav/v2", { method: "PROPFIND", headers: { authorization: basic("user", "pass") } }),
    baseEnv(validTokens()), {}
  );
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://proxy.test/caldav/v2/user%40gmail.com/");
  assert.equal(res.headers.get("content-location"), "https://proxy.test/caldav/v2/user%40gmail.com/events/");
});

// ---------- /subscribe ----------

test("/subscribe：非 Google 域名直接 403，且不发起任何抓取", async () => {
  const worker = await loadWorker();
  const calls = stubFetch(() => new Response("x", { status: 200 }));
  const res = await worker.fetch(
    new Request("https://proxy.test/subscribe?url=https%3A%2F%2Fevil.example%2Fa.ics"),
    baseEnv(validTokens()), {}
  );
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("/subscribe：Google 域名的 ICS 正常返回", async () => {
  const worker = await loadWorker();
  stubFetch(() => new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { status: 200, headers: { "content-type": "text/calendar" } }));
  const res = await worker.fetch(
    new Request("https://proxy.test/subscribe?url=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Fical%2Fx%2Fbasic.ics"),
    baseEnv(validTokens()), {}
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /BEGIN:VCALENDAR/);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("/subscribe：Google 上的跳转若指向站外，必须拒绝（防止变成开放代理）", async () => {
  const worker = await loadWorker();
  const calls = stubFetch((call) => {
    if (call.url.startsWith("https://www.google.com/")) {
      return new Response(null, { status: 302, headers: { location: "https://evil.example/steal.ics" } });
    }
    return new Response("evil", { status: 200 });
  });

  const res = await worker.fetch(
    new Request("https://proxy.test/subscribe?url=https%3A%2F%2Fwww.google.com%2Furl%3Fq%3Dhttps%3A%2F%2Fevil.example"),
    baseEnv(validTokens()), {}
  );
  assert.equal(res.status, 502);
  assert.equal(calls.some((c) => new URL(c.url).hostname === "evil.example"), false);
});

test("/subscribe：OPTIONS 预检返回 204", async () => {
  const worker = await loadWorker();
  stubFetch(() => new Response("x"));
  const res = await worker.fetch(new Request("https://proxy.test/subscribe", { method: "OPTIONS" }), baseEnv(validTokens()), {});
  assert.equal(res.status, 204);
});
