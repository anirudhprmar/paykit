import { stripe } from "@paykitjs/stripe";
import { chromium, type Locator, type Page } from "playwright";
import { default as Stripe } from "stripe";

import type { PayKitDatabase } from "../../../packages/paykit/src/database/index";
import { syncPaymentMethodByProviderCustomer } from "../../../packages/paykit/src/payment-method/payment-method.service";
import { env } from "../env";
import type { ProviderHarness } from "./types";

const stripeCardNumberSelectors = [
  "#cardNumber",
  'input[name="cardnumber"]',
  'input[autocomplete="cc-number"]',
  'input[placeholder*="card number" i]',
  '[data-testid="card-number"]',
];

const stripeCardExpirySelectors = [
  "#cardExpiry",
  'input[name="exp-date"]',
  'input[autocomplete="cc-exp"]',
  'input[placeholder*="MM / YY" i]',
  '[data-testid="card-expiry"]',
];

const stripeCardCvcSelectors = [
  "#cardCvc",
  'input[name="cvc"]',
  'input[autocomplete="cc-csc"]',
  'input[placeholder*="CVC" i]',
  '[data-testid="card-cvc"]',
];

const stripeBillingNameSelectors = [
  "#billingName",
  'input[name="name"]',
  'input[autocomplete="cc-name"]',
  '[data-testid="billing-name"]',
];

const stripeSubmitSelectors = [
  'button[type="submit"]',
  'button:has-text("Subscribe")',
  'button:has-text("Pay")',
  'button:has-text("Start trial")',
  ".SubmitButton-TextContainer",
];

async function waitForVisibleLocator(
  page: Page,
  selectors: string[],
  timeout: number,
): Promise<Locator> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const context of [page, ...page.frames()]) {
      for (const selector of selectors) {
        const locator = context.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
          return locator;
        }
      }
    }

    await page.waitForTimeout(500);
  }

  const frameUrls = page
    .frames()
    .map((frame) => frame.url())
    .filter(Boolean)
    .join("\n- ");

  throw new Error(
    [
      `Timed out waiting for Stripe checkout selectors: ${selectors.join(", ")}`,
      `Page URL: ${page.url()}`,
      frameUrls ? `Frames:\n- ${frameUrls}` : "Frames: (none)",
    ].join("\n"),
  );
}

async function maybeGetVisibleLocator(
  page: Page,
  selectors: string[],
  timeout: number,
): Promise<Locator | null> {
  try {
    return await waitForVisibleLocator(page, selectors, timeout);
  } catch {
    return null;
  }
}

async function fillStripeField(page: Page, selectors: string[], value: string, timeout: number) {
  const locator = await waitForVisibleLocator(page, selectors, timeout);
  await locator.click();
  await locator.pressSequentially(value);
}

export function createStripeHarness(): ProviderHarness {
  const secretKey = env.E2E_STRIPE_SK;
  const webhookSecret = env.E2E_STRIPE_WHSEC;
  if (!secretKey || !webhookSecret) {
    throw new Error("E2E_STRIPE_SK and E2E_STRIPE_WHSEC must be set");
  }

  const stripeClient = new Stripe(secretKey, { maxNetworkRetries: 3 });

  return {
    id: "stripe",
    capabilities: {
      testClocks: true,
      directSubscription: true,
    },

    createProviderConfig() {
      return stripe({ secretKey, webhookSecret });
    },

    applyTestingOverrides(ctx) {
      // Stripe's real createSubscription uses payment_behavior: "default_incomplete",
      // which requires client-side confirmation via Stripe.js. In tests we want the
      // subscription to activate straight away from the server after a PM is attached.
      (ctx.provider as unknown as Record<string, unknown>).createSubscription = async (data: {
        providerCustomerId: string;
        providerProduct: Record<string, string>;
      }) => {
        const sub = await stripeClient.subscriptions.create({
          customer: data.providerCustomerId,
          items: [{ price: data.providerProduct.priceId }],
          payment_behavior: "allow_incomplete",
          expand: ["latest_invoice"],
        });

        const firstItem = sub.items.data[0];
        const periodStart = firstItem?.current_period_start ?? null;
        const periodEnd = firstItem?.current_period_end ?? null;
        const latestInvoice = sub.latest_invoice;
        const inv =
          latestInvoice && typeof latestInvoice !== "string"
            ? {
                currency: latestInvoice.currency,
                hostedUrl: latestInvoice.hosted_invoice_url ?? null,
                periodEndAt: latestInvoice.period_end
                  ? new Date(latestInvoice.period_end * 1000)
                  : null,
                periodStartAt: latestInvoice.period_start
                  ? new Date(latestInvoice.period_start * 1000)
                  : null,
                providerInvoiceId: latestInvoice.id,
                status: latestInvoice.status,
                totalAmount: latestInvoice.total,
              }
            : null;

        return {
          invoice: inv,
          paymentUrl: null,
          subscription: {
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            canceledAt: sub.canceled_at != null ? new Date(sub.canceled_at * 1000) : null,
            currentPeriodEndAt: periodEnd != null ? new Date(periodEnd * 1000) : null,
            currentPeriodStartAt: periodStart != null ? new Date(periodStart * 1000) : null,
            endedAt: sub.ended_at != null ? new Date(sub.ended_at * 1000) : null,
            providerSubscriptionId: sub.id,
            providerSubscriptionScheduleId: null,
            status: sub.status,
          },
        };
      };
    },

    async setupCustomerForDirectSubscription(providerCustomerId: string) {
      const pm = await stripeClient.paymentMethods.attach("pm_card_visa", {
        customer: providerCustomerId,
      });
      await stripeClient.customers.update(providerCustomerId, {
        invoice_settings: { default_payment_method: pm.id },
      });
    },

    async completeCheckout(url: string) {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();

      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("load").catch(() => {});

        // Stripe's hosted checkout uses custom inputs that require per-key events;
        // fill() does not dispatch them correctly, so use pressSequentially. In
        // CI Stripe sometimes renders these fields inside iframes rather than as
        // top-level inputs, so search both the page and all frames.
        await fillStripeField(page, stripeCardNumberSelectors, "4242424242424242", 60_000);
        await fillStripeField(page, stripeCardExpirySelectors, "1234", 30_000);
        await fillStripeField(page, stripeCardCvcSelectors, "123", 30_000);

        const billingName = await maybeGetVisibleLocator(page, stripeBillingNameSelectors, 5_000);
        if (billingName) {
          await billingName.click();
          await billingName.pressSequentially("Test Customer");
        }

        const submitBtn = await waitForVisibleLocator(page, stripeSubmitSelectors, 30_000);
        await submitBtn.click({ force: true });

        // Wait for Stripe to navigate away from the checkout page (success redirect
        // or embedded confirmation). Don't fail the test if this times out — the
        // webhook poll downstream is the real signal.
        await page
          .waitForURL((u) => !u.toString().includes("checkout.stripe.com"), {
            timeout: 60_000,
          })
          .catch(() => {});
      } finally {
        await browser.close();
      }
    },

    async cleanup(ctx) {
      // Delete test clocks for all customers
      for (const providerCustomerId of ctx.providerCustomerIds) {
        try {
          const customer = await stripeClient.customers.retrieve(providerCustomerId);
          if ("deleted" in customer && customer.deleted) continue;
          const testClockId = (customer as Stripe.Customer).test_clock;
          if (testClockId && typeof testClockId === "string") {
            await stripeClient.testHelpers.testClocks.del(testClockId).catch(() => {});
          }
        } catch {
          // Customer may already be deleted
        }
      }
    },

    validateEnv() {
      if (!env.E2E_STRIPE_SK || !env.E2E_STRIPE_WHSEC) {
        throw new Error("E2E_STRIPE_SK and E2E_STRIPE_WHSEC must be set");
      }
    },
  };
}

/** Sync a Stripe payment method into the PayKit database. */
export async function syncStripePaymentMethod(input: {
  database: PayKitDatabase;
  providerCustomerId: string;
  providerId: string;
  stripeClient: Stripe;
}): Promise<void> {
  const pm = await input.stripeClient.paymentMethods.list({
    customer: input.providerCustomerId,
    type: "card",
    limit: 1,
  });
  const method = pm.data[0];
  if (!method) return;

  await syncPaymentMethodByProviderCustomer(input.database, {
    paymentMethod: {
      providerMethodId: method.id,
      type: method.type,
      last4: method.card?.last4,
      expiryMonth: method.card?.exp_month,
      expiryYear: method.card?.exp_year,
      isDefault: true,
    },
    providerCustomerId: input.providerCustomerId,
    providerId: input.providerId,
  });
}
