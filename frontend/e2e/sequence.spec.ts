import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ROOT_LABEL = "样例数据";

async function selectSampleFrame(page: Page): Promise<void> {
  await page.goto("/");

  const root = page.getByTestId("tree-node").filter({ hasText: ROOT_LABEL }).first();
  await expect(root).toBeVisible();

  for (const segment of ["scene_01", "baseline"]) {
    const node = page.locator(`[data-testid="tree-node"][data-path$="/${segment}"]`).first();
    await expect(node).toBeVisible();
    await node.click();
  }

  const firstRow = page.locator('[data-testid="npz-row"][data-path$="frame_001.npz"]');
  await expect(firstRow).toBeVisible();
  await firstRow.click();
}

async function openInsideCompare(page: Page, keys: string[]): Promise<void> {
  await page.getByRole("button", { name: "文件内" }).click();
  for (const key of keys) {
    await page.locator(`[data-testid="inside-key"][data-key="${key}"]`).click();
  }
  await expect(page.getByTestId("compare-tile")).toHaveCount(keys.length);
  await expect(page.getByTestId("compare-image")).toHaveCount(keys.length);
}

test("inside-compare sequence bar stays disabled until a range is chosen", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);

  const bar = page.getByTestId("sequence-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("sequence-play")).toBeDisabled();
  await expect(page.getByTestId("sequence-export")).toBeDisabled();
});

test("playing a range changes tile filenames without moving the file list", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);

  await page.getByTestId("sequence-start").fill("1");
  await page.getByTestId("sequence-end").fill("3");
  await expect(page.getByTestId("sequence-play")).toBeEnabled();
  await expect(page.getByTestId("sequence-export")).toBeEnabled();

  await page.getByTestId("sequence-play").click();
  await expect(page.getByTestId("sequence-play")).toHaveAttribute("title", "暂停（P）");
  await expect(page.getByTestId("compare-tile").first()).toContainText("frame_003", {
    timeout: 8_000,
  });
  await expect(page.getByTestId("sequence-play")).toHaveAttribute("title", "播放（P）");
  await expect(page.getByTestId("compare-tile").first()).toContainText("frame_003");
  await expect(
    page.locator('[data-testid="npz-row"][data-path$="frame_001.npz"]'),
  ).toHaveAttribute("data-selected", "true");
});

test("pausing sequence stops prefetch requests", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);

  await page.getByTestId("sequence-start").fill("1");
  await page.getByTestId("sequence-end").fill("3");
  await page.getByTestId("sequence-play").click();
  await expect(page.getByTestId("sequence-play")).toHaveAttribute("title", "暂停（P）");
  await page.getByTestId("sequence-play").click();
  await expect(page.getByTestId("sequence-play")).toHaveAttribute("title", "播放（P）");
  await page.waitForTimeout(300);

  let navAt = 0;
  let render = 0;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/nav/at")) navAt += 1;
    if (url.includes("/npz/render")) render += 1;
  });
  await page.waitForTimeout(600);
  expect(navAt).toBe(0);
  expect(render).toBe(0);
});

test("cross-file compare hides the sequence bar", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc"]);
  await expect(page.getByTestId("sequence-bar")).toBeVisible();

  await page.getByRole("button", { name: "跨文件" }).click();
  await expect(page.getByTestId("sequence-bar")).toHaveCount(0);
});
