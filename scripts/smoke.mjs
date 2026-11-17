// 部署后冒烟测试：node scripts/smoke.mjs https://<你的域名>
// 依赖环境变量 GATE_USER / GATE_PASS；可选 SUBSCRIBE_URL 验证订阅转发。
// 只断言"基本功能是否通"，不写入任何数据。
const base = (process.argv[2] || "").replace(/\/+$/, "");
const user = process.env.GATE_USER;
const pass = process.env.GATE_PASS;
const subscribeUrl = process.env.SUBSCRIBE_URL;

if (!base || !/^https?:\/\//.test(base)) {
  console.error("用法: GATE_USER=... GATE_PASS=... node scripts/smoke.mjs https://<域名>");
  process.exit(2);
}
if (!user || !pass) {
  console.error("缺少 GATE_USER / GATE_PASS 环境变量");
  process.exit(2);
}

const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name} — ${e.message}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log(`gogcal-proxy 冒烟测试 → ${base}\n` + "-".repeat(40));

await check("门禁：无凭据必须 401", async () => {
  const r = await fetch(base + "/__status");
  expect(r.status === 401, `期望 401，实际 ${r.status}`);
  expect(!!r.headers.get("www-authenticate"), "缺少 WWW-Authenticate");
  return "401 + Basic challenge";
});

await check("门禁：错误口令必须 401（不能放行）", async () => {
  const r = await fetch(base + "/__status", { headers: { authorization: "Basic " + Buffer.from("x:y").toString("base64") } });
  expect(r.status === 401, `期望 401，实际 ${r.status}`);
  return "401";
});

await check("/__status 返回授权状态", async () => {
  const r = await fetch(base + "/__status", { headers: { authorization: auth } });
  expect(r.status === 200, `期望 200，实际 ${r.status}（若为 500 说明 GATE_USER/GATE_PASS 未配置）`);
  const j = await r.json();
  expect(j.hasRefreshToken === true, "hasRefreshToken 为 false，需要先访问 /__auth 授权");
  return `token 到期于 ${j.accessTokenExpires || "未知"}`;
});

await check("PROPFIND /caldav/v2/ 返回 207", async () => {
  const r = await fetch(base + "/caldav/v2/", {
    method: "PROPFIND",
    headers: { authorization: auth, depth: "0", "content-type": "application/xml; charset=utf-8" },
    body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>',
  });
  expect(r.status === 207, `期望 207，实际 ${r.status}`);
  const body = await r.text();
  expect(/<[^>]*current-user-principal/i.test(body), "响应里没有 current-user-principal，discovery 会失败");
  expect(!body.includes("apidata.googleusercontent.com"), "响应里出现了 Google 主机名，客户端会绕过代理");
  return "discovery 正常且无上游主机泄漏";
});

await check("/.well-known/caldav 301 到 /caldav/v2/", async () => {
  const r = await fetch(base + "/.well-known/caldav", { redirect: "manual" });
  expect(r.status === 301, `期望 301，实际 ${r.status}`);
  expect((r.headers.get("location") || "").endsWith("/caldav/v2/"), "Location 未指向 /caldav/v2/");
  return r.headers.get("location");
});

if (subscribeUrl) {
  await check("/subscribe 转发公开 ICS", async () => {
    const r = await fetch(base + "/subscribe?url=" + encodeURIComponent(subscribeUrl));
    expect(r.status === 200, `期望 200，实际 ${r.status}`);
    const body = await r.text();
    expect(body.includes("BEGIN:VCALENDAR"), "响应不是 ICS");
    return `${body.length} 字节`;
  });
}

console.log("\n" + (failed ? `❌ ${failed} 项失败` : "✅ 全部通过"));
process.exit(failed ? 1 : 0);
