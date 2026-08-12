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
