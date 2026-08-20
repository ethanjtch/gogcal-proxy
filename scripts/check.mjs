// 部署前预检脚本（npm run check）
// 检查：KV 占位符是否替换 / wrangler 是否安装 / 是否登录 Cloudflare / Secrets 提示
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const toml = existsSync("wrangler.toml") ? readFileSync("wrangler.toml", "utf8") : "";
const idMatch = toml.match(/^id = "([^"]+)"/m);
const id = idMatch && idMatch[1];
const ok = (msg) => console.log("  ✅ " + msg);
const warn = (msg) => console.log("  ⚠️  " + msg);

console.log("gogcal-proxy 部署预检\n" + "-".repeat(30));

// 1. KV ID
if (!id) warn("wrangler.toml 中未找到 KV id，请先创建 KV 命名空间并填写");
else if (id.startsWith("REPLACE")) warn("wrangler.toml 的 KV id 仍是占位符 → 1) 面板创建 KV 命名空间 2) 把 Namespace ID 粘进来");
else ok(`KV 命名空间 id 已配置（${id.slice(0, 8)}…）`);

// 2. wrangler 安装
try {
  const v = execSync("wrangler --version", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  ok(`wrangler 已安装（${v}）`);
} catch {
  warn("未安装 wrangler → 运行 npm install（含 devDependencies）");
}

// 3. 登录状态
try {
  execSync("wrangler whoami", { stdio: "ignore" });
  ok("已登录 Cloudflare 账号");
} catch {
  warn("尚未登录 Cloudflare → 运行 wrangler login");
}

console.log("\n别忘了配置 4 个核心 Secrets（面板 → Worker 设置 → 变量与 Secrets）：");
console.log("  CLIENT_ID / CLIENT_SECRET / GATE_USER / GATE_PASS");
console.log("  可选配置：NOTIFY_URL（配置 Webhook/Bark 地址后，Token 失效将收到推送警报）");
console.log("详见 README「后续配置」一节。");