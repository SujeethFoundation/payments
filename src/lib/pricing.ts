// Money is handled in integer cents so discounts and totals never drift.

export interface Quote {
  courseName: string;
  currency: string;
  /** Listed course price. */
  price: number;
  /** Coupon discount actually applied (never more than the price). */
  discount: number;
  /** What the learner is charged today. */
  total: number;
  couponApplied: boolean;
  testMode: boolean;
}

export const TEST_CHARGE_CENTS = 1;

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

export function buildQuote(input: {
  courseName: string;
  currency: string;
  price: number;
  couponDiscount: number | undefined;
  environment: "dev" | "test" | "prod";
}): Quote {
  const priceCents = toCents(Math.max(0, input.price));
  const couponCents = input.couponDiscount === undefined ? 0 : toCents(Math.max(0, input.couponDiscount));
  const discountCents = Math.min(priceCents, couponCents);
  let totalCents = priceCents - discountCents;
  const testMode = input.environment !== "prod";
  // Dev and Test only ever move a penny, and only when something is actually owed.
  if (testMode && totalCents > 0) totalCents = TEST_CHARGE_CENTS;
  return {
    courseName: input.courseName,
    currency: input.currency,
    price: fromCents(priceCents),
    discount: fromCents(discountCents),
    total: fromCents(totalCents),
    couponApplied: input.couponDiscount !== undefined,
    testMode,
  };
}
