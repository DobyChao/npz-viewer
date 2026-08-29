import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * End-to-end coverage for the FastStone-style comparison view.
 *
 * Synchronised pan/zoom is the feature that cannot be verified from unit tests:
 * it depends on a non-passive native wheel listener and pointer capture, so it
 * only exercises correctly under real browser input.
 */

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

function transformsOf(page: Page): Promise<string[]> {
  return page
    .getByTestId("compare-image")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.transform));
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function parsePercent(text: string): number {
  return Number(text.replace("%", ""));
}

test("synchronised zoom and pan across compare tiles", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);

  // The panel auto-fits on first load, so both tiles start from the same transform.
  await expect
    .poll(async () => {
      const transforms = await transformsOf(page);
      return transforms.length === 2 && transforms[0] === transforms[1] && transforms[0] !== "";
    })
    .toBe(true);

  const zoomLabel = page.getByTestId("compare-zoom");
  const zoomBefore = parsePercent((await zoomLabel.textContent()) ?? "0");
  const transformBefore = (await transformsOf(page))[0];

  const leftTile = page.getByTestId("compare-tile").first();
  const point = await centerOf(leftTile);
  await page.mouse.move(point.x, point.y);
  for (let index = 0; index < 3; index += 1) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(60);
  }

  await expect
    .poll(async () => parsePercent((await zoomLabel.textContent()) ?? "0"))
    .toBeGreaterThan(zoomBefore);

  const afterZoom = await transformsOf(page);
  expect(afterZoom[0]).not.toBe(transformBefore);
  expect(afterZoom[0]).toBe(afterZoom[1]);

  // Drag on one tile; both must move by the same offset.
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(point.x - step * 20, point.y - step * 20);
  }
  await page.mouse.up();

  const afterPan = await transformsOf(page);
  expect(afterPan[0]).not.toBe(afterZoom[0]);
  expect(afterPan[0]).toBe(afterPan[1]);
  expect(parsePercent((await zoomLabel.textContent()) ?? "0")).toBeGreaterThan(zoomBefore);
});

test("stepping to the next file keeps the current zoom", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc"]);

  const zoomLabel = page.getByTestId("compare-zoom");
  const fitted = parsePercent((await zoomLabel.textContent()) ?? "0");

  const point = await centerOf(page.getByTestId("compare-tile").first());
  await page.mouse.move(point.x, point.y);
  for (let index = 0; index < 4; index += 1) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(40);
  }
  const zoomed = parsePercent((await zoomLabel.textContent()) ?? "0");
  expect(zoomed).toBeGreaterThan(fitted);

  // Comparing the same region across versions only works if the viewport survives.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("compare-tile").first()).toContainText("frame_002.npz");
  await page.waitForTimeout(800);
  expect(parsePercent((await zoomLabel.textContent()) ?? "0")).toBe(zoomed);
});

test("holding X overlays without locking, and the button locks it on", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);

  const baseTile = page.getByTestId("compare-tile").first();
  const overlay = baseTile.getByTestId("compare-overlay");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("overlay-status")).toContainText("按住 X 覆盖 2 → 1");
  await expect(page.getByTestId("overlay-toggle")).toHaveAttribute("data-locked", "false");

  await page.keyboard.down("x");
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId("overlay-status")).toContainText("松开 X 移开");
  const base = await baseTile.getByTestId("compare-image").evaluate((n) => (n as HTMLElement).style.transform);
  expect(await overlay.evaluate((n) => (n as HTMLElement).style.transform)).toBe(base);
  await page.keyboard.up("x");
  await expect(overlay).toHaveCount(0);

  await page.getByTestId("overlay-toggle").click();
  await expect(page.getByTestId("overlay-toggle")).toHaveAttribute("data-locked", "true");
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId("overlay-status")).toContainText("按住 X 移开覆盖层");

  await page.keyboard.down("x");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("overlay-status")).toContainText("已移开");
  await page.keyboard.up("x");
  await expect(overlay).toBeVisible();
});

test("overlay paints the source tile on top of the first one", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);

  const baseTile = page.getByTestId("compare-tile").first();
  const overlay = baseTile.getByTestId("compare-overlay");
  await expect(overlay).toHaveCount(0);

  await page.getByTestId("overlay-toggle").click();
  await expect(overlay).toBeVisible();

  await expect(page.getByTestId("overlay-toggle")).toHaveAttribute("data-locked", "true");

  // Both layers ride the shared viewport, so they must sit at the same transform.
  const base = await baseTile.getByTestId("compare-image").evaluate((n) => (n as HTMLElement).style.transform);
  expect(await overlay.evaluate((n) => (n as HTMLElement).style.transform)).toBe(base);

  // The source tile keeps showing its own image as the reference.
  await expect(page.getByTestId("compare-tile").nth(1).getByTestId("compare-image")).toBeVisible();
  await expect(page.getByTestId("overlay-status")).toContainText("覆盖 2 → 1");

  await page.keyboard.down("x");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("overlay-status")).toContainText("已移开");
  await page.keyboard.up("x");
  await expect(overlay).toBeVisible();

  // A/B and overlay are alternative views of the same tiles; turning one on drops the other.
  await page.getByRole("button", { name: "A/B" }).click();
  await expect(page.getByTestId("overlay-status")).toHaveCount(0);
});

test("three tiles sit side by side and the overlay source can be reassigned", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap", "soft_mask"]);

  const grid = page.getByTestId("compare-grid");
  await expect(grid).toHaveClass(/grid-cols-3/);

  await page.getByTestId("overlay-toggle").click();
  await expect(page.getByTestId("overlay-status")).toContainText("覆盖 2 → 1");

  // Only the non-base tiles that are not already the source offer the switch.
  await expect(page.getByTestId("pick-overlay-source")).toHaveCount(1);
  await page.getByTestId("compare-tile").nth(2).getByTestId("pick-overlay-source").click();
  await expect(page.getByTestId("overlay-status")).toContainText("覆盖 3 → 1");
  await expect(page.getByTestId("compare-tile").first()).toContainText("soft_mask");

  // Controls layered over a draggable image still have to receive their click.
  await page.getByTestId("compare-tile").nth(2).getByTestId("remove-tile").click();
  await expect(page.getByTestId("compare-tile")).toHaveCount(2);
});

function scaleOf(transform: string): number {
  const match = /scale\(([-\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`no scale in ${transform}`);
  return Number(match[1]);
}

test("equal height scales a half-resolution image to the reference height", async ({ page }) => {
  await selectSampleFrame(page);
  // gainmap_half is deliberately half the resolution of rgb_hwc.
  await openInsideCompare(page, ["rgb_hwc", "gainmap_half"]);

  const images = page.getByTestId("compare-image");
  const heightsOf = () =>
    images.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLImageElement).getBoundingClientRect().height),
    );

  // Sharing one viewport means the half-res image renders at half the height.
  const [fullHeight, halfHeight] = await heightsOf();
  expect(halfHeight).toBeLessThan(fullHeight * 0.6);

  await page.getByTestId("equal-height-toggle").click();
  await expect(page.getByTestId("equal-height-status")).toContainText("基准");

  const matched = await heightsOf();
  expect(Math.abs(matched[0] - matched[1])).toBeLessThan(1.5);
  expect(Math.abs(matched[0] - fullHeight)).toBeLessThan(1.5);

  // Only the second tile gets the extra factor; the reference keeps the shared scale.
  const transforms = await transformsOf(page);
  expect(scaleOf(transforms[1]) / scaleOf(transforms[0])).toBeCloseTo(2, 1);

  // Zoom stays synchronised: the ratio between the two layers has to survive it.
  const point = await centerOf(page.getByTestId("compare-tile").first());
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(120);
  const zoomed = await transformsOf(page);
  expect(scaleOf(zoomed[1]) / scaleOf(zoomed[0])).toBeCloseTo(2, 1);
  expect(scaleOf(zoomed[0])).toBeGreaterThan(scaleOf(transforms[0]));

  await page.getByTestId("equal-height-toggle").click();
  await expect(page.getByTestId("equal-height-status")).toHaveCount(0);
});

test("equal height lines up an overlay of a different resolution", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap_half"]);
  await page.getByTestId("equal-height-toggle").click();
  await page.getByTestId("overlay-toggle").click();

  const baseTile = page.getByTestId("compare-tile").first();
  const overlay = baseTile.getByTestId("compare-overlay");
  await expect(overlay).toBeVisible();

  // The overlay carries the source's own factor, so both layers cover the same box.
  const box = await baseTile.getByTestId("compare-image").boundingBox();
  const overlayBox = await overlay.boundingBox();
  if (!box || !overlayBox) throw new Error("missing layer geometry");
  expect(Math.abs(overlayBox.height - box.height)).toBeLessThan(1.5);
  expect(Math.abs(overlayBox.y - box.y)).toBeLessThan(1.5);
  expect(Math.abs(overlayBox.x - box.x)).toBeLessThan(1.5);
});

async function hoverFraction(page: Page, image: Locator, fraction: number): Promise<void> {
  const box = await image.boundingBox();
  if (!box) throw new Error("image has no bounding box");
  const x = box.x + box.width * fraction;
  const y = box.y + box.height * fraction;
  // The readout is throttled, so space the moves out or the second one is dropped.
  await page.mouse.move(x, y);
  await page.waitForTimeout(200);
  await page.mouse.move(x + 1, y);
  await page.waitForTimeout(200);
}

function readoutCoords(page: Page): Promise<{ x: number; y: number }> {
  return page
    .getByTestId("compare-readout")
    .textContent()
    .then((text) => {
      const match = /x (-?\d+) y (-?\d+)/.exec(text ?? "");
      if (!match) throw new Error(`unexpected readout: ${text}`);
      return { x: Number(match[1]), y: Number(match[2]) };
    });
}

test("the pixel readout maps the cursor back to source coordinates", async ({ page }) => {
  await selectSampleFrame(page);
  // rgb_hwc is 720×480 and gainmap_half is 360×240.
  await openInsideCompare(page, ["rgb_hwc", "gainmap_half"]);

  const images = page.getByTestId("compare-image");
  await hoverFraction(page, images.first(), 0.25);
  await expect(page.getByTestId("compare-readout")).toBeVisible();
  await expect.poll(async () => (await readoutCoords(page)).x).toBeGreaterThan(160);
  let coords = await readoutCoords(page);
  expect(Math.abs(coords.x - 180)).toBeLessThan(20);
  expect(Math.abs(coords.y - 120)).toBeLessThan(20);

  // A quarter into the half-res image is a quarter of *its* pixels, and stays that way
  // once equal-height stretches it: the readout has to divide by the extra factor.
  await hoverFraction(page, images.nth(1), 0.25);
  await expect.poll(async () => (await readoutCoords(page)).x).toBeLessThan(120);
  coords = await readoutCoords(page);
  expect(Math.abs(coords.x - 90)).toBeLessThan(15);

  await page.getByTestId("equal-height-toggle").click();
  await hoverFraction(page, images.nth(1), 0.25);
  await page.waitForTimeout(300);
  coords = await readoutCoords(page);
  expect(Math.abs(coords.x - 90)).toBeLessThan(15);
  expect(Math.abs(coords.y - 60)).toBeLessThan(15);
});

test("zoomed-in images switch to nearest-neighbour sampling", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc"]);

  const image = page.getByTestId("compare-image").first();
  const tile = page.getByTestId("compare-tile").first();
  const point = await centerOf(tile);
  await page.mouse.move(point.x, point.y);
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(40);
  }

  await expect(image).toHaveClass(/pixelated/);
});

test("missing inside-compare keys can be removed", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);

  // frame_004 is generated without gainmap / soft_mask, so the checked name survives
  // as a KEY NOT FOUND tile that has to be removable.
  await page.locator('[data-testid="npz-row"][data-path$="frame_004.npz"]').click();
  const missing = page.locator('[data-testid="compare-tile"][data-missing="true"]');
  await expect(missing).toBeVisible();
  await expect(missing).toContainText("gainmap");
  await expect(page.getByTestId("inside-key-missing")).toHaveAttribute("data-key", "gainmap");

  await missing.getByTestId("remove-tile").click();
  await expect(page.getByTestId("compare-tile")).toHaveCount(1);
  await expect(page.getByTestId("inside-key-missing")).toHaveCount(0);
  await expect(page.getByTestId("compare-tile").first()).toHaveAttribute("data-key", "rgb_hwc");
});

test("keyboard navigation walks files and sibling folders", async ({ page }) => {
  await selectSampleFrame(page);

  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator('[data-testid="npz-row"][data-selected="true"]'),
  ).toHaveAttribute("data-path", /frame_002\.npz$/);

  await page.keyboard.press("ArrowDown");
  await expect(
    page.locator('[data-testid="npz-row"][data-selected="true"]'),
  ).toHaveAttribute("data-path", /method_a\/frame_002\.npz$/);
});

test("op tile is tile 2 ÷ tile 1, can swap operands, and can switch to multiply", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);

  await expect(page.getByTestId("op-toggle")).toBeEnabled();
  await page.getByTestId("op-toggle").click();
  await expect(page.getByTestId("compare-tile")).toHaveCount(3);

  const derived = page.locator('[data-testid="compare-tile"][data-derived="true"]');
  await expect(derived).toBeVisible();
  await expect(derived).toContainText("gainmap ÷ rgb_hwc");
  await expect(page.getByTestId("op-status")).toContainText("除法 2 ÷ 1");
  await expect(derived.getByTestId("compare-image")).toBeVisible();

  await page.getByTestId("op-swap").click();
  await expect(derived).toContainText("rgb_hwc ÷ gainmap");
  await expect(page.getByTestId("op-status")).toContainText("除法 1 ÷ 2");

  await page.getByTestId("op-kind").selectOption("mul");
  await expect(derived).toContainText("rgb_hwc × gainmap");
  await expect(page.getByTestId("op-status")).toContainText("乘法 1 × 2");
  await expect(derived.getByTestId("compare-image")).toBeVisible();

  await page.getByTestId("overlay-toggle").click();
  await expect(page.getByTestId("overlay-status")).toContainText("覆盖 2 → 1");
  await expect(page.getByTestId("pick-overlay-source")).toHaveCount(0);

  await derived.getByTestId("remove-tile").click();
  await expect(page.getByTestId("compare-tile")).toHaveCount(2);
  await expect(page.getByTestId("op-status")).toHaveCount(0);
});

test("op of mixed resolutions still paints", async ({ page }) => {
  await selectSampleFrame(page);
  await openInsideCompare(page, ["rgb_hwc", "gainmap_half"]);
  await page.getByTestId("op-toggle").click();
  const derived = page.locator('[data-testid="compare-tile"][data-derived="true"]');
  await expect(derived.getByTestId("compare-image")).toBeVisible();
});

test("browsing produces no console errors or failed requests", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(`[${message.type()}] ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) failedRequests.push(`${status} ${response.url()}`);
  });

  await selectSampleFrame(page);
  await expect(page.getByTestId("compare-tile")).toHaveCount(0);
  await openInsideCompare(page, ["rgb_hwc", "gainmap"]);
  await page.waitForTimeout(1500);

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
});
