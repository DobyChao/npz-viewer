#!/usr/bin/env node
// Windows native smoke test against a built portable folder, using WebView2 CDP.
// Node and Playwright are test dependencies only, never part of the distribution.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "frontend/package.json"));
const { chromium } = require("@playwright/test");
const version = JSON.parse(readFileSync(resolve(root, "frontend/package.json"), "utf8")).version;
const stage = resolve(process.argv[2] ?? resolve(root, `dist-portable/npz-view-${version}-windows-x64`));
const output = resolve(root, "_verify/native-desktop");
mkdirSync(output, { recursive: true });

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function until(fn, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw last ?? new Error("desktop smoke test timed out");
}

const debugPort = await freePort();
const backendPort = await freePort();
const child = spawn(resolve(stage, "npz-view.exe"), [], {
  // Exercise executable-relative resources, including extracted folders with spaces.
  cwd: output,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    NPZVIEW_ROOT: "",
    NPZVIEW_ROOTS_FILE: resolve(root, "roots.json"),
    NPZVIEW_CACHE_DIR: resolve(output, "cache"),
    NPZVIEW_BACKEND_PORT: String(backendPort),
    WEBVIEW2_USER_DATA_FOLDER: resolve(output, `profile-${Date.now()}`),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  },
});
let exited = false;
child.once("exit", () => { exited = true; });
let browser;
try {
  await until(async () => {
    if (exited) throw new Error("desktop exited before WebView2 opened; see npz-view-boot.log");
    return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const pages = () => browser.contexts().flatMap((context) => context.pages());
  const chrome = await until(() => pages().find((page) => page.url().includes("tabs.html")));
  const content = await until(() => pages().find((page) => page.url().includes("index.html")));
  const errors = [];
  content.on("pageerror", (error) => errors.push(error.message));
  assert.match(content.url(), /^https?:\/\/tauri\.localhost\//);
  await content.getByTestId("tree-node").filter({ hasText: "样例数据" }).first().waitFor();
  for (const name of ["scene_01", "baseline"]) {
    await content.locator(`[data-testid="tree-node"][data-path$="/${name}"]`).first().click();
  }
  await content.locator('[data-testid="npz-row"][data-path$="frame_001.npz"]').click();
  await content.getByTestId("gallery-card").first().waitFor();
  await content.waitForLoadState("networkidle");
  const config = await content.evaluate(() => window.__NPZVIEW_DESKTOP__);
  assert.match(config.origin, /^http:\/\/127\.0\.0\.1:/);
  assert.equal((await fetch(`${config.origin}/__hub/state`)).status, 401);
  const session = new URL(content.url()).searchParams.get("session");
  const health = await fetch(`${config.origin}/api/health?npzview_token=${config.token}&npzview_session=${session}`);
  assert.equal((await health.json()).version, version);

  const gallery = content.getByTestId("gallery-scroll");
  await gallery.evaluate((el) => { el.scrollTop = 360; });
  // Lazy cards fetch stats after scrolling; record the settled layout, not the
  // initial placeholder geometry (especially with fractional Windows scaling).
  await content.waitForLoadState("networkidle");
  const before = await gallery.evaluate((el) => el.scrollTop);
  assert.ok(before > 0);
  await content.getByTestId("compare-panel-toggle").click(); // split
  await content.getByTestId("compare-panel-toggle").click(); // hidden
  await content.waitForLoadState("networkidle");
  assert.equal(await gallery.evaluate((el) => el.scrollTop), before);
  await content.getByRole("button", { name: "文件内", exact: true }).click();
  await content.locator('[data-testid="inside-key"][data-key="rgb_hwc"]').click();
  await content.locator('[data-testid="inside-key"][data-key="gainmap"]').click();
  await until(async () => (await content.getByTestId("compare-image").count()) === 2);
  await content.evaluate(() => document.activeElement?.blur());
  await content.keyboard.press("f");
  await until(async () => content.locator('[data-panel][id="gallery"]').evaluate((el) => el.getBoundingClientRect().height < 2));
  await content.keyboard.press("f");
  await until(async () => content.locator('[data-panel][id="gallery"]').evaluate((el) => el.getBoundingClientRect().height > 20));
  await content.screenshot({ path: resolve(output, "compare.png") });

  const firstSession = new URL(content.url()).searchParams.get("session");
  const tabs = await chrome.evaluate(() => window.__TAURI__.core.invoke("tab_new"));
  assert.equal(tabs.length, 2);
  const second = await until(() => pages().find((page) => page.url().includes("index.html") && page !== content));
  const secondSession = new URL(second.url()).searchParams.get("session");
  assert.ok(firstSession && secondSession && firstSession !== secondSession);
  await second.getByTestId("tree-node").first().waitFor();
  await chrome.evaluate((id) => window.__TAURI__.core.invoke("tab_close", { id }), secondSession);
  assert.equal((await chrome.evaluate(() => window.__TAURI__.core.invoke("tab_list"))).length, 1);
  const bridgePort = new URL(config.origin).port;
  await chrome.evaluate((id) => window.__TAURI__.core.invoke("tab_close", { id }), firstSession);
  await until(() => exited);
  await until(async () => {
    try { await fetch(`http://127.0.0.1:${backendPort}/api/health`); return false; } catch { return true; }
  });
  await until(async () => {
    try { await fetch(`http://127.0.0.1:${bridgePort}/__hub/state`); return false; } catch { return true; }
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, embeddedOrigin: content.url(), nativeTabs: true,
    compare: true, galleryScroll: true, backendExit: true, bridgeExit: true,
    screenshot: resolve(output, "compare.png") }));
} catch (error) {
  if (browser) {
    const content = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("index.html"));
    const chrome = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("tabs.html"));
    if (content) {
      await content.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
    }
    if (chrome) {
      await chrome.evaluate(() => window.__TAURI__.core.invoke("tab_list")).then(async (tabs) => {
        for (const tab of tabs) await chrome.evaluate((id) => window.__TAURI__.core.invoke("tab_close", { id }), tab.id).catch(() => {});
      }).catch(() => {});
      await until(() => exited, 5000).catch(() => {});
    }
  }
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (!exited) child.kill();
}
