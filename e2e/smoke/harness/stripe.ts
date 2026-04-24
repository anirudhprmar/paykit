import { stripe } from "@paykitjs/stripe";
import { chromium } from "playwright";
import { default as Stripe } from "stripe";

import type { PayKitDatabase } from "../../../packages/paykit/src/database/index";
import { syncPaymentMethodByProviderCustomer } from "../../../packages/paykit/src/payment-method/payment-method.service";
import { env } from "../../env";
import type { ProviderHarness } from "./types";

export function createStripeHarness(): ProviderHarness {
  const secretKey = env.E2E_STRIPE_SK;
  const webhookSecret = env.E2E_STRIPE_WHSEC;
  if (!secretKey || !webhookSecret) {
    throw new Error("E2E_STRIPE_SK and E2E_STRIPE_WHSEC must be set");
  }

  const stripeClient = new Stripe(secretKey);

  return {
    id: "stripe",
    capabilities: {
      testClocks: true,
      directSubscription: true,
    },

    createProviderConfig() {
      return stripe({ secretKey, webhookSecret });
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

        // Stripe's hosted checkout uses custom inputs that require per-key events;
        // fill() does not dispatch them correctly, so use pressSequentially.
        const cardNumber = page.locator("#cardNumber");
        await cardNumber.waitFor({ timeout: 60_000 });
        await cardNumber.pressSequentially("4242424242424242");

        const cardExpiry = page.locator("#cardExpiry");
        await cardExpiry.waitFor({ timeout: 30_000 });
        await cardExpiry.pressSequentially("1234");

        const cardCvc = page.locator("#cardCvc");
        await cardCvc.waitFor({ timeout: 30_000 });
        await cardCvc.pressSequentially("123");

        const billingName = page.locator("#billingName");
        if (await billingName.isVisible().catch(() => false)) {
          await billingName.pressSequentially("Test Customer");
        }

        const submitBtn = page.locator(".SubmitButton-TextContainer").first();
        await submitBtn.evaluate((el) => (el as HTMLElement).click());

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
