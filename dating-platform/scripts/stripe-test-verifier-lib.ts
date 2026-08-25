export function inspectStripeTestConfig(env: Partial<NodeJS.ProcessEnv>) {
  const failures: string[] = [];
  if (!env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) failures.push("STRIPE_SECRET_KEY must be a Stripe test secret key");
  if (!env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) failures.push("STRIPE_WEBHOOK_SECRET is required");
  if (!env.STRIPE_TEST_PRICE_ID?.startsWith("price_")) failures.push("STRIPE_TEST_PRICE_ID must be a Stripe price id");
  let webhookValid = false;
  try { webhookValid = new URL(env.STRIPE_TEST_WEBHOOK_URL ?? "").protocol === "https:"; } catch { /* fail closed */ }
  if (!webhookValid) failures.push("STRIPE_TEST_WEBHOOK_URL must be an HTTPS acceptance endpoint");
  return failures;
}

export function assertTestModeResource(resource: { livemode?: boolean }, label: string) {
  if (resource.livemode !== false) throw new Error(`${label} was not returned in Stripe test mode`);
}
