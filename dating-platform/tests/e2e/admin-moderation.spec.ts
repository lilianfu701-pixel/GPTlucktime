import { expect, test } from "@playwright/test";

import { adminPage, approvePhoto, control, publishMember, registerMember } from "./support/member-setup";

test("reported message receives dual-control moderation, appeal, and immutable audit history", async ({
  browser, request, baseURL,
}) => {
  test.setTimeout(150_000);
  expect(baseURL).toBeTruthy();
  const seeded = await control(request, { action: "reset" });
  expect(seeded.adminCookie).toBeTruthy();
  expect(seeded.secondAdminCookie).toBeTruthy();
  expect(seeded.secondAdminCookie).not.toBe(seeded.adminCookie);

  const alex = await registerMember(browser, request, { email: "appealing.member@example.test",
    phone: "+14155550301", name: "Alex Appeal", birthDate: "1991-02-03", gender: "man" });
  const bailey = await registerMember(browser, request, { email: "reporting.member@example.test",
    phone: "+14155550302", name: "Bailey Reporter", birthDate: "1993-06-07", gender: "woman" });
  await approvePhoto(browser, baseURL!, seeded.adminCookie);
  await approvePhoto(browser, baseURL!, seeded.adminCookie);
  await publishMember(alex);
  await publishMember(bailey);

  await alex.page.goto("/en/discover");
  await alex.page.getByRole("button", { name: "Like Bailey Reporter" }).click();
  await expect(alex.page.getByText("You liked Bailey Reporter.")).toBeVisible();
  await bailey.page.goto("/en/discover");
  await bailey.page.getByRole("button", { name: "Like Alex Appeal" }).click();
  await expect(bailey.page.getByText("It’s a match with Alex Appeal!")).toBeVisible();
  await bailey.page.getByRole("button", { name: "Start conversation" }).click();

  await alex.page.goto("/en/messages");
  await alex.page.getByPlaceholder("Write a message").fill("This message is linked moderation evidence.");
  await alex.page.getByRole("button", { name: "Send" }).click();
  await expect(alex.page.getByText("This message is linked moderation evidence.")).toBeVisible();
  await bailey.page.goto("/en/messages");
  await expect(bailey.page.getByText("This message is linked moderation evidence.")).toBeVisible();
  await expect(bailey.page.getByRole("button", { name: "Report message" })).toBeVisible();
  await bailey.page.getByRole("button", { name: "Report message" }).click();
  await expect(bailey.page.getByText("Message reported for moderator review.")).toBeVisible();

  const firstModerator = await adminPage(browser, baseURL!, seeded.adminCookie, "/en/admin?queue=reports");
  await firstModerator.page.getByRole("button", { name: "Open case" }).click();
  await expect(firstModerator.page.getByText("Message reference:")).toBeVisible();
  await firstModerator.page.getByRole("button", { name: "Triage case" }).click();
  await firstModerator.page.getByRole("button", { name: "Begin review" }).click();
  await firstModerator.page.getByLabel("Restriction reason").fill("Confirmed targeted harassment in linked evidence");
  await firstModerator.page.getByLabel("Duration in hours").fill("24");
  await firstModerator.page.getByRole("button", { name: "Apply temporary restriction" }).click();
  await firstModerator.page.getByLabel("Final decision summary").fill("Temporary restriction imposed after evidence review");
  await firstModerator.page.getByRole("button", { name: "Finalize case" }).click();
  await expect(firstModerator.page.getByText("Action recorded in the immutable audit timeline.")).toBeVisible();

  await alex.page.goto("/en/messages");
  await expect(alex.page.getByText("Choose a conversation")).toBeVisible();
  await alex.page.goto("/en/settings/appeals");
  await alex.page.getByLabel("Appeal statement").fill("Please independently review the linked context and restriction.");
  await alex.page.getByRole("button", { name: "Submit appeal" }).click();
  await expect(alex.page.getByText("Appeal submitted for independent review.")).toBeVisible();

  const secondModerator = await adminPage(browser, baseURL!, seeded.secondAdminCookie, "/en/admin?queue=appeals");
  await secondModerator.page.getByRole("button", { name: "Begin independent review" }).click();
  await secondModerator.page.getByLabel("Appeal decision").selectOption("overturned");
  await secondModerator.page.getByLabel("Decision summary").fill("Independent review overturned the temporary restriction");
  await secondModerator.page.getByRole("button", { name: "Finalize appeal" }).click();
  await expect(secondModerator.page.getByText("Action recorded in the immutable audit timeline.")).toBeVisible();

  await firstModerator.page.reload();
  await firstModerator.page.getByRole("button", { name: "Open case" }).click();
  await expect(firstModerator.page.getByText("Appeal submitted")).toBeVisible();
  await expect(firstModerator.page.getByText("Appeal enforcement revoked")).toBeVisible();

  await alex.page.goto("/en/settings/appeals");
  await expect(alex.page.getByText("Independent review overturned the temporary restriction")).toBeVisible();

  await alex.page.goto("/en/messages");
  await alex.page.getByPlaceholder("Write a message").fill("Independent appeal restored interaction.");
  await alex.page.getByRole("button", { name: "Send" }).click();
  await expect(alex.page.getByText("Independent appeal restored interaction.")).toBeVisible();

  await secondModerator.context.close();
  await firstModerator.context.close();
  await alex.context.close();
  await bailey.context.close();
});
