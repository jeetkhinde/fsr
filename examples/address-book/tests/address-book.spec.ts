import { expect, test } from "@playwright/test";

test("search synchronizes q and filters rows", async ({ page }) => {
  await page.goto("/contacts");
  const search = page.getByPlaceholder("Search people");
  await search.fill("Sarah");
  await expect(page).toHaveURL(/\?q=Sarah$/);
  await expect(page.getByRole("link", { name: /Sarah Chen/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Maya Patel/ })).toBeHidden();
});

test("navigation preserves the contacts layout and fetches a fragment", async ({
  page,
}) => {
  await page.goto("/contacts");
  const directory = page.locator(".directory");
  const before = await directory.evaluate((node) => {
    (window as any).__directoryNode = node;
    return node.isConnected;
  });
  expect(before).toBe(true);

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/contacts/") && response.request().method() === "GET",
  );
  await page.getByRole("link", { name: /Sarah Chen/ }).click();
  const response = await responsePromise;

  expect(response.request().headers()["x-ps-present"]).toContain("/contacts");
  expect(response.headers()["content-type"]).toContain("x-ps-fragment=1");
  expect(await page.evaluate(() => (window as any).__directoryNode === document.querySelector(".directory"))).toBe(true);
});

test("creates, edits, favorites, and deletes a contact", async ({ page }) => {
  await page.goto("/contacts/new");
  await page.getByLabel("First name").fill("Avery");
  await page.getByLabel("Last name").fill("Stone");
  await page.getByLabel("Role").fill("Editor");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  await expect(
    page.getByRole("heading", { name: "Avery Stone" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Edit contact" }).click();
  await page.getByLabel("Role").fill("Editorial Director");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#detail .profile__copy > p")).toContainText(
    "Editorial Director",
  );

  await page.getByRole("button", { name: "Add to favorites" }).click();
  await expect(
    page.getByRole("button", { name: "Remove from favorites" }),
  ).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL("/contacts");
  await expect(page.getByRole("link", { name: /Avery Stone/ })).toHaveCount(0);
});

test("shows validation errors and portrait fallback", async ({ page }) => {
  await page.goto("/contacts/new");
  await page.getByLabel("Email").fill("broken");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page.getByText("Enter a first or last name.")).toBeVisible();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();

  await page.goto("/contacts");
  await expect(
    page.locator("[data-avatar] .avatar__fallback").first(),
  ).toBeVisible();
});

test("reconciles insert, update, reorder, and delete across tabs", async ({
  browser,
}) => {
  test.setTimeout(75_000);
  const liveTimeout = 15_000;
  const context = await browser.newContext();
  const left = await context.newPage();
  const right = await context.newPage();
  await Promise.all([left.goto("/contacts"), right.goto("/contacts")]);

  await left.goto("/contacts/new");
  await left.getByLabel("First name").fill("Cross");
  await left.getByLabel("Last name").fill("Aaron");
  await left.getByRole("button", { name: "Create contact" }).click();

  await expect(right.getByRole("link", { name: /Cross Aaron/ })).toBeVisible({
    timeout: liveTimeout,
  });

  await left.getByRole("link", { name: "Edit contact" }).click();
  await left.getByLabel("Role").fill("Cross-tab Director");
  await left.getByRole("button", { name: "Save changes" }).click();
  await expect(right.getByRole("link", { name: /Cross Aaron/ })).toContainText(
    "Cross-tab Director",
    { timeout: liveTimeout },
  );

  await left.getByRole("button", { name: "Add to favorites" }).click();
  await expect(right.locator("[data-contact-row]").first()).toContainText(
    "Cross Aaron",
    { timeout: liveTimeout },
  );

  left.once("dialog", (dialog) => dialog.accept());
  await left.getByRole("button", { name: "Delete" }).click();
  await expect(right.getByRole("link", { name: /Cross Aaron/ })).toHaveCount(0, {
    timeout: liveTimeout,
  });

  await context.close();
});

test("mobile detail route hides the directory and exposes back navigation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/contacts");
  await page.getByRole("link", { name: /Sarah Chen/ }).click();
  await expect(page.getByRole("link", { name: "‹ People" })).toBeVisible();
  await expect(page.locator(".directory")).toBeHidden();
});
