import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ROOT_LABEL = "样例数据";

async function selectSampleFrame(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("tree-node").filter({ hasText: ROOT_LABEL }).first()).toBeVisible();
  for (const segment of ["scene_01", "baseline"]) {
    await page.locator(`[data-testid="tree-node"][data-path$="/${segment}"]`).first().click();
  }
  await page.locator('[data-testid="npz-row"][data-path$="frame_001.npz"]').click();
  await expect(page.getByTestId("gallery-card").first()).toBeVisible();
}

test("leaf folders stay collapsed and do not show an empty-child placeholder", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("tree-node").filter({ hasText: ROOT_LABEL }).first()).toBeVisible();

  await page.locator('[data-testid="tree-node"][data-path$="/scene_01"]').first().click();
  const scene = page.locator('[data-testid="tree-node"][data-path$="/scene_01"]').first();
  await expect(scene).toHaveAttribute("data-expanded", "true");

  const baseline = page.locator('[data-testid="tree-node"][data-path$="/baseline"]').first();
  await expect(baseline).toBeVisible();
  await baseline.click();
  await expect(baseline).toHaveAttribute("data-has-children", "false");
  await expect(baseline).toHaveAttribute("data-expanded", "false");
  await expect(page.getByText("没有子文件夹")).toHaveCount(0);
});

test("toggling the compare panel keeps the gallery scroll offset", async ({ page }) => {
  await selectSampleFrame(page);
  const gallery = page.getByTestId("gallery-scroll");
  await expect(gallery).toBeVisible();
  await expect
    .poll(async () => gallery.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(200);

  await gallery.evaluate((el) => {
    el.scrollTop = 360;
  });
  await expect.poll(async () => gallery.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  const before = await gallery.evaluate((el) => el.scrollTop);

  await page.getByTestId("compare-panel-toggle").click();
  await expect(page.getByTestId("compare-panel-toggle")).toHaveAttribute("title", "隐藏对比面板");
  await expect.poll(async () => gallery.evaluate((el) => el.scrollTop)).toBe(before);

  await page.getByTestId("compare-panel-toggle").click();
  await expect(page.getByTestId("compare-panel-toggle")).toHaveAttribute("title", "显示对比面板");
  await expect.poll(async () => gallery.evaluate((el) => el.scrollTop)).toBe(before);
});

test("dragging the compare panel past minSize hides it and updates the toggle", async ({ page }) => {
  await selectSampleFrame(page);
  await page.getByTestId("compare-panel-toggle").click();
  await expect(page.getByTestId("compare-panel-toggle")).toHaveAttribute("title", "隐藏对比面板");

  const handle = page.getByTestId("gallery-compare-separator");
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error("no separator");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 900, { steps: 16 });
  await page.mouse.up();

  await expect(page.getByTestId("compare-panel-toggle")).toHaveAttribute("title", "显示对比面板");

  const restored = await handle.boundingBox();
  if (!restored) throw new Error("no separator after collapse");
  await page.mouse.move(restored.x + restored.width / 2, restored.y + restored.height / 2);
  await page.mouse.down();
  await page.mouse.move(restored.x + restored.width / 2, restored.y - 450, { steps: 16 });
  await page.mouse.up();

  await expect(page.getByTestId("compare-panel-toggle")).toHaveAttribute("title", "隐藏对比面板");
});

test("the lightbox opens, zooms, and steps between keys", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await selectSampleFrame(page);
  await page.locator('[data-testid="gallery-card"][data-key="rgb_hwc"]').hover();
  await page.locator('[data-testid="lightbox-open"][data-key="rgb_hwc"]').click();

  const lightbox = page.getByTestId("lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox).toContainText("rgb_hwc");

  // A render loop here would keep the zoom label churning; it has to settle.
  const zoomLabel = page.getByTestId("lightbox-zoom");
  await expect(zoomLabel).not.toHaveText("0%");
  const settled = await zoomLabel.textContent();
  await page.waitForTimeout(700);
  expect(await zoomLabel.textContent()).toBe(settled);

  const image = page.getByTestId("lightbox-image");
  const box = await image.boundingBox();
  if (!box) throw new Error("no lightbox image");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await expect
    .poll(async () => Number(((await zoomLabel.textContent()) ?? "0").replace("%", "")))
    .toBeGreaterThan(Number((settled ?? "0").replace("%", "")));

  await page.keyboard.press("ArrowRight");
  await expect(lightbox).toContainText("rgb_chw");

  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
