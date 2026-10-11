// GitHub 注册 worker（跑在 Actions 上，微软 IP）
// 流程: signup?source=login 填表 → launch code（经 repo state.json 交接）→ 完成注册
//       WB_LINK 模式: workbuddy 授权（登录 + 设备码交接 + Authorize）
// 复刻 hhhhhhhh567123/ghreg worker 配方: 禁止 JS 合成点击、humanize、逐格校验验证码

import { launch } from "cloakbrowser";

const SIGNUP_URL = "https://github.com/signup?source=login";

const EMAIL = (process.env.EMAIL || "").trim().toLowerCase();
const USERNAME = process.env.USERNAME || "";
const PASSWORD = process.env.PASSWORD || "";
const WB_LINK = (process.env.WB_LINK || "").trim();
const ROUND_ID = process.env.ROUND_ID || "r0";
const GH_REPO = process.env.GH_REPO || "";
const GH_TOKEN = process.env.GH_TOKEN || "";

const API = `https://api.github.com/repos/${GH_REPO}/contents`;
const H = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ghreg-worker",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function info(msg, extra = {}) {
  console.log(`[INFO] ${msg} ${JSON.stringify(extra).slice(0, 300)}`);
}
function warn(msg, extra = {}) {
  console.log(`[WARN] ${msg} ${JSON.stringify(extra).slice(0, 300)}`);
}

// ==================== repo state.json 交接 ====================
async function ghGet(path) {
  const r = await fetch(`${API}/${path}`, { headers: H });
  if (!r.ok) return null;
  const d = await r.json();
  try {
    return JSON.parse(Buffer.from(d.content, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

async function ghPut(path, obj) {
  let sha = null;
  const r = await fetch(`${API}/${path}`, { headers: H });
  if (r.ok) {
    const d = await r.json();
    sha = d.sha;
  }
  const body = {
    message: `state update: ${path} ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(obj)).toString("base64"),
    ...(sha ? { sha } : {}),
  };
  const r2 = await fetch(`${API}/${path}`, {
    method: "PUT",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r2.ok;
}

async function pollState(matchField, matchValue, codeField, timeoutSec) {
  // 轮询 state.json 直到 codeField 出现且 matchField 匹配
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const st = await ghGet("state.json");
      if (st && st[matchField] === matchValue && st[codeField]) {
        return String(st[codeField]);
      }
    } catch (e) {
      warn(`state 轮询异常: ${e.message.slice(0, 80)}`);
    }
    await sleep(15000);
  }
  throw new Error(`等待 ${codeField} 超时(${timeoutSec}s)`);
}

// ==================== 页面工具 ====================
function pageText(page) {
  return page.textContent("body").catch(() => "");
}

async function detectCaptcha(page) {
  try {
    const hasForm = await page.evaluate(
      () =>
        !!document.querySelector("#email") ||
        !!document.querySelector("#launch-code-0") ||
        !!document.querySelector("#login_field")
    );
    if (hasForm) return false;
    const b = (await pageText(page)) || "";
    if (/octocaptcha|verify you'?re a human|to continue, verify|complete the captcha/i.test(b))
      return true;
  } catch {}
  return false;
}

async function humanFill(page, sel, text, timeoutMs = 10000) {
  const loc = page.locator(sel);
  try {
    await loc.fill(String(text), { timeout: 5000 });
    return;
  } catch {}
  try {
    await loc.click({ timeout: 3000 }).catch(() => {});
    await sleep(300);
    await loc.fill(String(text), { timeout: 5000 });
    return;
  } catch {}
  await loc.click({ timeout: 3000 }).catch(() => {});
  await sleep(200);
  await loc.pressSequentially(String(text), { delay: 40, timeout: timeoutMs });
}

async function humanClick(page, sel, timeoutMs = 15000) {
  const loc = page.locator(sel);
  try {
    await loc.click({ timeout: timeoutMs });
  } catch {
    try {
      await loc.first().click({ timeout: timeoutMs });
    } catch {
      await loc.first().click({ timeout: 8000, force: true });
    }
  }
  await sleep(500);
}

// ==================== 注册 ====================
async function fillSignup(page, email, password, username) {
  await page.waitForSelector("#email", { timeout: 30000 });
  info("注册表单已加载");
  await humanFill(page, "#email", email);
  await sleep(600);
  await humanFill(page, "#password", password);
  await sleep(600);
  await humanFill(page, "#login", username);
  info("表单已填写", { username });

  let available = false;
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const body = await pageText(page);
    if (body.includes("is available")) {
      available = true;
      break;
    }
    if (/is already taken|unavailable/i.test(body)) {
      throw new Error("用户名被占用: " + username);
    }
    await sleep(800);
  }
  if (!available) warn("用户名校验未确认（继续提交）");

  await page.locator("#login").press("Enter");
  info("回车提交注册表单");
}

async function waitAfterSubmit(page) {
  try {
    await page.waitForSelector("#launch-code-0", { timeout: 45000 });
    info("launch-code 输入框已出现", { url: page.url().slice(0, 100) });
    return "verify";
  } catch {
    let body = "";
    try { body = await pageText(page); } catch {}
    if (/Too many requests|secondary rate limit|rate limit exceeded/i.test(body)) {
      throw new Error("注册被限流: " + body.slice(0, 150));
    }
    if (await detectCaptcha(page)) {
      throw new Error("提交后被拦截: 表单不可用且出现人机验证");
    }
    throw new Error(`提交后未进验证阶段, url=${page.url().slice(0, 100)}`);
  }
}

async function enterLaunchCode(page, code) {
  info("输入 launch code", { len: code.length });
  await page.waitForSelector("#launch-code-0", { timeout: 20000 });

  async function clearBoxes() {
    await page.evaluate(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      document
        .querySelectorAll('input[id^="launch-code-"]')
        .forEach((i) => {
          setter.call(i, "");
          i.dispatchEvent(new Event("input", { bubbles: true }));
        });
    });
    await sleep(300);
  }

  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    await clearBoxes();
    let allGood = true;
    for (let i = 0; i < 8; i++) {
      await page.locator(`#launch-code-${i}`).click({ timeout: 3000 }).catch(() => {});
      await sleep(200);
      await page.keyboard.press(code[i]);
      await sleep(200);
      const v = await page.evaluate(
        (idx) => document.querySelector(`#launch-code-${idx}`)?.value,
        i
      );
      if (v !== code[i]) {
        await page.locator(`#launch-code-${i}`).click({ timeout: 3000 }).catch(() => {});
        await sleep(300);
        await page.keyboard.press(code[i]);
        await sleep(300);
        const v2 = await page.evaluate(
          (idx) => document.querySelector(`#launch-code-${idx}`)?.value,
          i
        );
        if (v2 !== code[i]) {
          allGood = false;
          break;
        }
      }
    }
    const vals = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[id^="launch-code-"]'))
        .map((i) => i.value)
        .join("")
    );
    if (vals === code) ok = true;
    else warn(`验证码第${attempt + 1}次输入错位: got=${vals}`);
  }
  if (!ok) throw new Error("launch code 输入失败");

  await page.locator("#launch-code-7").press("Enter");
  await sleep(2000);
  if (page.url().includes("account_verifications")) {
    info("回车未生效, 点 Continue");
    await humanClick(page, "button:has-text('Continue')", 8000);
  }
  info("验证码已提交");
}

async function waitRegistrationDone(page) {
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    let url;
    try { url = page.url(); } catch { await sleep(1000); continue; }
    if (url.includes("/dashboard") || url.includes("/settings") || url.includes("/new")) {
      info("注册流程结束", { url: url.slice(0, 100) });
      return true;
    }
    if (url.includes("/login")) {
      info("到登录页（账号已建好）");
      return true;
    }
    if (url.includes("/account_verifications")) {
      const body = await pageText(page).catch(() => "");
      if (/incorrect|wrong|invalid/i.test(body)) {
        throw new Error("验证码错误: " + body.slice(0, 150));
      }
    }
    await sleep(1500);
  }
  throw new Error("注册完成等待超时, url=" + page.url());
}

// ==================== 登录 + 设备验证 ====================
async function doLogin(page, username, password) {
  await page.waitForSelector("#login_field", { timeout: 20000 });
  await humanFill(page, "#login_field", username);
  await sleep(500);
  await humanFill(page, "#password", password);
  await sleep(400);
  await humanClick(page, ".js-sign-in-button", 10000);
  info("登录已提交");
}

async function handleDeviceVerify(page) {
  // 登录后可能跳设备验证页（6位码发到邮箱）
  for (let i = 0; i < 8; i++) {
    const u = page.url();
    if (/verified-device|device_verification|two-factor|otp/i.test(u) ||
        (await page.locator("#otp").count())) {
      info("设备验证页出现，轮询 device_code ...");
      const code = await pollState(ROUND_ID, ROUND_ID, "device_code", 600);
      info("device_code 到手");
      await page.waitForSelector("#otp", { timeout: 15000 });
      await humanFill(page, "#otp", code);
      await sleep(1000);
      try {
        await humanClick(page, "button:has-text('Verify')", 8000);
      } catch {}
      await sleep(4000);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

// ==================== WorkBuddy 授权 ====================
async function workbuddyAuth(page, username, password) {
  info("打开 WorkBuddy 授权链接");
  await page.goto(WB_LINK, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(6000);
  let frame = null;
  for (let i = 0; i < 10 && !frame; i++) {
    for (const fr of page.frames()) {
      if (fr.url().includes("/auth/realms/")) { frame = fr; break; }
    }
    if (!frame) await sleep(2000);
  }
  if (!frame) throw new Error("未找到 keycloak iframe: " + page.url().slice(0, 100));

  const cbs = frame.locator('input[type="checkbox"]');
  const n = await cbs.count();
  for (let i = 0; i < n; i++) {
    try {
      if (!(await cbs.nth(i).isChecked())) {
        await cbs.nth(i).click({ timeout: 3000 }).catch(() => {});
      }
    } catch {}
  }
  await sleep(500);
  await frame.locator('a:has-text("GitHub"), button:has-text("GitHub")').first().click();
  info("已点击 GitHub 登录");
  await sleep(9000);

  // GitHub 侧：可能要登录
  for (let attempt = 0; attempt < 15; attempt++) {
    const u = page.url();
    let body = "";
    for (const fr of page.frames()) {
      if (fr.url().includes("github.com")) {
        try { body = await fr.textContent("body"); } catch {}
      }
    }
    if (body.includes("flagged")) throw new Error("FLAGGED: 账号被标记");

    // 登录表单
    if (u.includes("github.com/login") || (await page.locator("#login_field").count())) {
      info("GitHub 登录表单");
      await doLogin(page, username, password);
      const dv = await handleDeviceVerify(page);
      if (dv) info("设备验证完成");
      await sleep(5000);
      continue;
    }
    // 授权页
    if (body.includes("Authorize") || (await page.locator('button[name="authorize"]').count())) {
      info("授权页出现，点击 Authorize");
      try {
        await page.locator('button[name="authorize"]').first().click({ timeout: 5000 });
      } catch {
        await humanClick(page, 'button:has-text("Authorize")', 8000);
      }
      await sleep(6000);
      continue;
    }
    // 回跳成功
    if (u.includes("workbuddy") || u.includes("127.0.0.1:8788")) {
      info("★ WorkBuddy 授权完成，已回跳: " + u.slice(0, 90));
      return true;
    }
    await sleep(3000);
  }
  throw new Error("授权流程超时, url=" + page.url().slice(0, 100));
}

// ==================== 主流程 ====================
async function main() {
  info("worker 启动", { round: ROUND_ID, mode: WB_LINK ? "workbuddy" : "register", email: EMAIL });

  const browser = await launch({
    headless: false,
    stealthArgs: false,
    launchOptions: { ignoreDefaultArgs: ["--enable-automation"] },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--fingerprint=" + Math.floor(Math.random() * 90000 + 10000),
      "--fingerprint-platform=windows",
    ],
    humanize: true,
    timezone: "America/New_York",
  });
  info("cloakbrowser 启动成功");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("about:blank");

  try {
    if (!WB_LINK) {
      // ========== 注册模式 ==========
      await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      let hasForm = false;
      try {
        await page.waitForSelector("#email", { timeout: 30000 });
        hasForm = true;
      } catch {}
      if (!hasForm) {
        const body = await pageText(page);
        throw new Error(`注册表单未加载(30s): ${body.slice(0, 150)}`);
      }
      info("表单已加载（datadome 静默通过）");

      await fillSignup(page, EMAIL, PASSWORD, USERNAME);
      await waitAfterSubmit(page);

      // 通知本地：到 launch code 阶段
      await ghPut("state.json", {
        round_id: ROUND_ID,
        email: EMAIL,
        phase: "waiting_launch_code",
        ts: Date.now(),
      });

      const launchCode = await pollState(ROUND_ID, ROUND_ID, "launch_code", 900);
      info("launch code 到手");
      await enterLaunchCode(page, launchCode);
      await waitRegistrationDone(page);
      info("★ 注册成功！");

      await ghPut("results/" + ROUND_ID + ".json", {
        round_id: ROUND_ID,
        ok: true,
        username: USERNAME,
        email: EMAIL,
        password: PASSWORD,
        ts: Date.now(),
      });
      info("结果已写入 results/" + ROUND_ID + ".json");
    } else {
      // ========== WorkBuddy 授权模式 ==========
      const ok = await workbuddyAuth(page, USERNAME, PASSWORD);
      if (!ok) throw new Error("授权未确认");
      await ghPut("results/" + ROUND_ID + "_wb.json", {
        round_id: ROUND_ID,
        ok: true,
        phase: "workbuddy_authorized",
        username: USERNAME,
        ts: Date.now(),
      });
      info("★ 授权结果已写入");
    }
  } catch (e) {
    console.log(`[ERROR] ${e.message}`);
    try {
      await ghPut("results/" + ROUND_ID + (WB_LINK ? "_wb" : "") + "_fail.json", {
        round_id: ROUND_ID,
        ok: false,
        mode: WB_LINK ? "workbuddy" : "register",
        error: e.message.slice(0, 300),
        ts: Date.now(),
      });
    } catch {}
    process.exitCode = 1;
  } finally {
    try { await browser.close(); } catch {}
  }
}

main().catch((e) => {
  console.log(`[ERROR] 未捕获: ${e.message}`);
  process.exit(1);
});
