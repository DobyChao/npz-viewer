import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const ROOT = "/auto-open";
const counts: Record<string, number> = { a: 125, b: 125, short: 61 };
const filename = (folder: string, index: number) => `${folder}_${String(index).padStart(3, "0")}.npz`;

async function setup(page: Page, beforeList?: (dir: string, page: number) => Promise<void>) {
  const opened: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("npz-view.app", JSON.stringify({
      version: 2, state: { locale: "zh", thumbs: { enabled: false, prefer: "rgb" } },
    }));
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    let body: unknown;
    switch (url.pathname) {
      case "/api/roots":
        body = { roots: [{ id: "auto-open", name: "分页测试", path: ROOT }] };
        break;
      case "/api/settings":
        body = { version: "test", small_matrix_max: 9, allow_pickle: false,
          embed_icc: false, cache_dir: "/cache", roots_file: "/roots.json" };
        break;
      case "/api/fs/dirs":
        body = { path, parent: null, dirs: path === ROOT ? Object.keys(counts).map((name) => ({
          name, path: `${ROOT}/${name}`, has_children: false,
        })) : [] };
        break;
      case "/api/npz/list": {
        const dir = url.searchParams.get("dir")!;
        const requested = Number(url.searchParams.get("page"));
        const pageSize = Number(url.searchParams.get("page_size"));
        await beforeList?.(dir, requested);
        const folder = dir.split("/").at(-1)!;
        const total = counts[folder] ?? 0;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const current = Math.min(requested, pages);
        const start = (current - 1) * pageSize;
        body = { dir, total, page: current, page_size: pageSize, pages,
          items: Array.from({ length: Math.min(pageSize, total - start) }, (_, offset) => {
            const name = filename(folder, start + offset + 1);
            return { name, path: `${dir}/${name}`, size: 1024, mtime: 123 };
          }),
        };
        break;
      }
      case "/api/npz/meta":
        opened.push(path);
        body = { path, name: path.split("/").at(-1), size: 1024, mtime: 123, compressed: false, keys: [] };
        break;
      case "/api/nav/locate":
        body = { path, name: path.split("/").at(-1), index: Number(path.match(/_(\d+)\.npz$/)?.[1]) - 1,
          total: counts[path.split("/").at(-2)!], size: 1024, mtime: 123 };
        break;
      default:
        throw new Error(`Unexpected API request: ${url.pathname}`);
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  await page.locator(`[data-testid="tree-node"][data-path="${ROOT}/a"]`).waitFor();
  return opened;
}

async function folder(page: Page, name: string) {
  await page.locator(`[data-testid="tree-node"][data-path="${ROOT}/${name}"]`).click();
}

async function enable(page: Page, index: number) {
  await page.getByRole("checkbox", { name: "切换文件夹时自动打开第" }).check();
  await page.getByRole("spinbutton").fill(String(index));
}

for (const index of [50, 51, 74, 100, 101]) {
  test(`auto-open #${index} waits for the target page instead of consuming cached page 1`, async ({ page }) => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let requested!: () => void;
    const targetRequested = new Promise<void>((resolve) => { requested = resolve; });
    let delay = false;
    const opened = await setup(page, async (dir, current) => {
      if (delay && dir === `${ROOT}/a` && current === Math.ceil(index / 50)) {
        requested();
        await delayed;
      }
    });

    // Cache A's first page, then switch away before enabling auto-open.
    await folder(page, "a");
    await page.locator(`[data-testid="npz-row"][data-path$="/${filename("a", 1)}"]`).waitFor();
    await folder(page, "b");
    await page.locator(`[data-testid="npz-row"][data-path$="/${filename("b", 1)}"]`).waitFor();
    await enable(page, index);
    delay = index > 50;
    await folder(page, "a");
    if (delay) await targetRequested;
    release();

    const expected = `${ROOT}/a/${filename("a", index)}`;
    await expect(page.getByText(filename("a", index), { exact: true }).first()).toBeVisible();
    expect(opened.filter((path) => path.startsWith(`${ROOT}/a/`))).toEqual([expected]);
    await expect(page.getByRole("textbox").last()).toHaveValue(String(Math.ceil(index / 50)));
  });
}

test("auto-open leaves a file chosen by sibling-folder navigation selected", async ({ page }) => {
  await setup(page);
  await page.route("**/api/nav/sibling?**", (route) => route.fulfill({ json: {
    path: `${ROOT}/b/${filename("b", 55)}`, name: filename("b", 55), index: 54,
    total: 125, size: 1024, mtime: 123,
  } }));
  await enable(page, 74);
  await folder(page, "a");
  await expect(page.getByText(filename("a", 74), { exact: true }).first()).toBeVisible();
  await page.getByRole("spinbutton").blur();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByText(filename("b", 55), { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("textbox").last()).toHaveValue("2");
});

test("auto-open clamps a folder-wide index to the last file in a shorter folder", async ({ page }) => {
  const opened = await setup(page);
  await enable(page, 101);
  await folder(page, "short");
  await expect(page.getByText(filename("short", 61), { exact: true }).first()).toBeVisible();
  expect(opened).toEqual([`${ROOT}/short/${filename("short", 61)}`]);
  await expect(page.getByRole("textbox").last()).toHaveValue("2");
});

test("auto-open uses the configured page size", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("每页条数").selectOption("25");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await enable(page, 74);
  await folder(page, "a");
  await expect(page.getByText(filename("a", 74), { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("textbox").last()).toHaveValue("3");
});

test("disabling auto-open cancels a pending target page selection", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const targetRequested = new Promise<void>((resolve) => { requested = resolve; });
  const opened = await setup(page, async (dir, current) => {
    if (dir === `${ROOT}/a` && current === 2) { requested(); await delayed; }
  });
  await enable(page, 74);
  await folder(page, "a");
  await targetRequested;
  await page.getByRole("checkbox", { name: "切换文件夹时自动打开第" }).uncheck();
  release();
  await page.waitForLoadState("networkidle");
  expect(opened).toEqual([]);
});

test("a delayed previous-folder page cannot change the current folder's selection", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const targetRequested = new Promise<void>((resolve) => { requested = resolve; });
  const opened = await setup(page, async (dir, current) => {
    if (dir === `${ROOT}/a` && current === 2) { requested(); await delayed; }
  });
  await enable(page, 74);
  await folder(page, "a");
  await targetRequested;
  await folder(page, "b");
  await expect(page.getByText(filename("b", 74), { exact: true }).first()).toBeVisible();
  release();
  await page.waitForLoadState("networkidle");
  expect(opened).toEqual([`${ROOT}/b/${filename("b", 74)}`]);
  await expect(page.getByText(filename("b", 74), { exact: true }).first()).toBeVisible();
});
