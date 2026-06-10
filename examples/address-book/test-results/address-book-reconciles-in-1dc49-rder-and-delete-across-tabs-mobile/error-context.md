# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: address-book.spec.ts >> reconciles insert, update, reorder, and delete across tabs
- Location: tests/address-book.spec.ts:76:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByRole('link', { name: /Cross Aaron/ })
Expected substring: "Cross-tab Director"
Error: strict mode violation: getByRole('link', { name: /Cross Aaron/ }) resolved to 2 elements:
    1) <a class="contact-row" href="/contacts/28" data-preserve-query="true">…</a> aka getByRole('link', { name: 'Cross Aaron Cross-tab Director' }).first()
    2) <a class="contact-row" href="/contacts/28" data-preserve-query="true">…</a> aka getByRole('link', { name: 'Cross Aaron Cross-tab Director' }).nth(1)

Call log:
  - Expect "toContainText" with timeout 15000ms
  - waiting for getByRole('link', { name: /Cross Aaron/ })

```

# Page snapshot

```yaml
- main [ref=e5]:
  - article [ref=e9]:
    - generic [ref=e10]:
      - link "‹ People" [ref=e11] [cursor=pointer]:
        - /url: /contacts
      - generic [ref=e12]:
        - link "Edit contact" [ref=e13] [cursor=pointer]:
          - /url: /contacts/30/edit
        - button "Delete" [ref=e15] [cursor=pointer]
    - generic [ref=e16]:
      - generic [ref=e18]: CA
      - generic [ref=e19]:
        - generic [ref=e20]:
          - heading "Cross Aaron" [level=1] [ref=e21]
          - button "Add to favorites" [ref=e23] [cursor=pointer]: ☆
        - paragraph [ref=e24]: Cross-tab Director
    - generic [ref=e25]:
      - generic [ref=e26]:
        - term [ref=e27]: Email
        - definition [ref=e28]: Not provided
      - generic [ref=e29]:
        - term [ref=e30]: Phone
        - definition [ref=e31]: Not provided
      - generic [ref=e32]:
        - term [ref=e33]: Notes
        - definition [ref=e34]: No notes yet.
```

# Test source

```ts
  1   | import { expect, test } from "@playwright/test";
  2   | 
  3   | test("search synchronizes q and filters rows", async ({ page }) => {
  4   |   await page.goto("/contacts");
  5   |   const search = page.getByPlaceholder("Search people");
  6   |   await search.fill("Sarah");
  7   |   await expect(page).toHaveURL(/\?q=Sarah$/);
  8   |   await expect(page.getByRole("link", { name: /Sarah Chen/ })).toBeVisible();
  9   |   await expect(page.getByRole("link", { name: /Maya Patel/ })).toBeHidden();
  10  | });
  11  | 
  12  | test("navigation preserves the contacts layout and fetches a fragment", async ({
  13  |   page,
  14  | }) => {
  15  |   await page.goto("/contacts");
  16  |   const directory = page.locator(".directory");
  17  |   const before = await directory.evaluate((node) => {
  18  |     (window as any).__directoryNode = node;
  19  |     return node.isConnected;
  20  |   });
  21  |   expect(before).toBe(true);
  22  | 
  23  |   const responsePromise = page.waitForResponse(
  24  |     (response) => response.url().includes("/contacts/") && response.request().method() === "GET",
  25  |   );
  26  |   await page.getByRole("link", { name: /Sarah Chen/ }).click();
  27  |   const response = await responsePromise;
  28  | 
  29  |   expect(response.request().headers()["x-ps-present"]).toContain("/contacts");
  30  |   expect(response.headers()["content-type"]).toContain("x-ps-fragment=1");
  31  |   expect(await page.evaluate(() => (window as any).__directoryNode === document.querySelector(".directory"))).toBe(true);
  32  | });
  33  | 
  34  | test("creates, edits, favorites, and deletes a contact", async ({ page }) => {
  35  |   await page.goto("/contacts/new");
  36  |   await page.getByLabel("First name").fill("Avery");
  37  |   await page.getByLabel("Last name").fill("Stone");
  38  |   await page.getByLabel("Role").fill("Editor");
  39  |   await page.getByRole("button", { name: "Create contact" }).click();
  40  |   await expect(page).toHaveURL(/\/contacts\/\d+$/);
  41  |   await expect(
  42  |     page.getByRole("heading", { name: "Avery Stone" }),
  43  |   ).toBeVisible();
  44  | 
  45  |   await page.getByRole("link", { name: "Edit contact" }).click();
  46  |   await page.getByLabel("Role").fill("Editorial Director");
  47  |   await page.getByRole("button", { name: "Save changes" }).click();
  48  |   await expect(page.locator("#detail .profile__copy > p")).toContainText(
  49  |     "Editorial Director",
  50  |   );
  51  | 
  52  |   await page.getByRole("button", { name: "Add to favorites" }).click();
  53  |   await expect(
  54  |     page.getByRole("button", { name: "Remove from favorites" }),
  55  |   ).toBeVisible();
  56  | 
  57  |   page.once("dialog", (dialog) => dialog.accept());
  58  |   await page.getByRole("button", { name: "Delete" }).click();
  59  |   await expect(page).toHaveURL("/contacts");
  60  |   await expect(page.getByRole("link", { name: /Avery Stone/ })).toHaveCount(0);
  61  | });
  62  | 
  63  | test("shows validation errors and portrait fallback", async ({ page }) => {
  64  |   await page.goto("/contacts/new");
  65  |   await page.getByLabel("Email").fill("broken");
  66  |   await page.getByRole("button", { name: "Create contact" }).click();
  67  |   await expect(page.getByText("Enter a first or last name.")).toBeVisible();
  68  |   await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  69  | 
  70  |   await page.goto("/contacts");
  71  |   await expect(
  72  |     page.locator("[data-avatar] .avatar__fallback").first(),
  73  |   ).toBeVisible();
  74  | });
  75  | 
  76  | test("reconciles insert, update, reorder, and delete across tabs", async ({
  77  |   browser,
  78  | }) => {
  79  |   test.setTimeout(75_000);
  80  |   const liveTimeout = 15_000;
  81  |   const context = await browser.newContext();
  82  |   const left = await context.newPage();
  83  |   const right = await context.newPage();
  84  |   await Promise.all([left.goto("/contacts"), right.goto("/contacts")]);
  85  | 
  86  |   await left.goto("/contacts/new");
  87  |   await left.getByLabel("First name").fill("Cross");
  88  |   await left.getByLabel("Last name").fill("Aaron");
  89  |   await left.getByRole("button", { name: "Create contact" }).click();
  90  | 
  91  |   await expect(right.getByRole("link", { name: /Cross Aaron/ })).toBeVisible({
  92  |     timeout: liveTimeout,
  93  |   });
  94  | 
  95  |   await left.getByRole("link", { name: "Edit contact" }).click();
  96  |   await left.getByLabel("Role").fill("Cross-tab Director");
  97  |   await left.getByRole("button", { name: "Save changes" }).click();
> 98  |   await expect(right.getByRole("link", { name: /Cross Aaron/ })).toContainText(
      |                                                                  ^ Error: expect(locator).toContainText(expected) failed
  99  |     "Cross-tab Director",
  100 |     { timeout: liveTimeout },
  101 |   );
  102 | 
  103 |   await left.getByRole("button", { name: "Add to favorites" }).click();
  104 |   await expect(right.locator("[data-contact-row]").first()).toContainText(
  105 |     "Cross Aaron",
  106 |     { timeout: liveTimeout },
  107 |   );
  108 | 
  109 |   left.once("dialog", (dialog) => dialog.accept());
  110 |   await left.getByRole("button", { name: "Delete" }).click();
  111 |   await expect(right.getByRole("link", { name: /Cross Aaron/ })).toHaveCount(0, {
  112 |     timeout: liveTimeout,
  113 |   });
  114 | 
  115 |   await context.close();
  116 | });
  117 | 
  118 | test("mobile detail route hides the directory and exposes back navigation", async ({
  119 |   page,
  120 | }, testInfo) => {
  121 |   test.skip(testInfo.project.name !== "mobile");
  122 |   await page.goto("/contacts");
  123 |   await page.getByRole("link", { name: /Sarah Chen/ }).click();
  124 |   await expect(page.getByRole("link", { name: "‹ People" })).toBeVisible();
  125 |   await expect(page.locator(".directory")).toBeHidden();
  126 | });
  127 | 
```