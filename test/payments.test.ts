import test from "node:test";
import assert from "node:assert/strict";
import { PaymentEnvironmentConfig } from "../src/config/payments-environment";
import { buildQuote } from "../src/lib/pricing";
import { DataverseClient, Coupon } from "../src/lib/dataverse";
import { handleCheckout, handleWebhook, handlePaymentStatus, Services, WebhookEvent } from "../src/lib/checkout-service";

const COURSE = "11111111-1111-1111-1111-111111111111";
const CONTACT = "22222222-2222-2222-2222-222222222222";
const ORIGIN = "https://portal.example.org";
const logger = { log() {}, error() {} };

function config(name: "dev" | "test" | "prod"): PaymentEnvironmentConfig {
  return {
    name, allowedOrigins: [ORIGIN],
    paypal: { clientId: "c", clientSecret: "s", baseUrl: "https://pp.test", webhookId: "WH" },
    dataverse: { url: "https://dv.test", tenantId: "t", clientId: "c", clientSecret: "s" },
  };
}

function fakes(opts: { price?: number; coupon?: Coupon; enrollment?: { id: string; accessStatus: number; orderId: string | null }; verify?: boolean } = {}) {
  const calls: Record<string, any[]> = { grant: [], redeem: [], order: [] };
  const dataverse = {
    getCourse: async () => ({ id: COURSE, name: "Career Ascent", price: opts.price ?? 50, currency: "USD", active: true }),
    findCoupon: async () => opts.coupon,
    couponHasUsesLeft: (c: Coupon) => c.maximumUses === null || c.timesUsed < c.maximumUses,
    findEnrollment: async () => opts.enrollment,
    grantEnrollment: async (input: unknown) => { calls.grant.push(input); return { enrollmentId: "e1", created: true, changed: true }; },
    redeemCoupon: async (id: string) => { calls.redeem.push(id); },
  };
  const paypal = {
    createOrder: async (input: unknown) => { calls.order.push(input); return { orderId: "ORD1", approvalUrl: "https://www.paypal.com/x" }; },
    verifyWebhook: async () => opts.verify ?? true,
    getOrderCustomId: async () => undefined,
  };
  return { services: { dataverse, paypal } as unknown as Services, calls };
}

const coupon = (over: Partial<Coupon> = {}): Coupon => ({ id: "cp1", code: "TEN", discountAmount: 10, maximumUses: 5, timesUsed: 1, etag: "e", ...over });
const input = { courseId: COURSE, contactId: CONTACT, returnUrl: `${ORIGIN}/c?sf_payment=success`, cancelUrl: `${ORIGIN}/c?sf_payment=cancel` };

test("quote: prod charges price minus coupon, never below zero", () => {
  const q = buildQuote({ courseName: "C", currency: "USD", price: 50, couponDiscount: 10, environment: "prod" });
  assert.deepEqual([q.price, q.discount, q.total, q.couponApplied, q.testMode], [50, 10, 40, true, false]);
  assert.equal(buildQuote({ courseName: "C", currency: "USD", price: 50, couponDiscount: 80, environment: "prod" }).total, 0);
});

test("quote: dev and test force one cent only when money is owed", () => {
  assert.equal(buildQuote({ courseName: "C", currency: "USD", price: 50, couponDiscount: undefined, environment: "dev" }).total, 0.01);
  assert.equal(buildQuote({ courseName: "C", currency: "USD", price: 50, couponDiscount: 50, environment: "test" }).total, 0);
});

test("checkout: quoteOnly applies a valid coupon and creates nothing", async () => {
  const { services, calls } = fakes({ coupon: coupon() });
  const r = await handleCheckout(config("prod"), ORIGIN, { ...input, couponCode: "ten", quoteOnly: true }, services, logger);
  assert.equal(r.status, 200); assert.equal(r.body.total, 40); assert.equal(r.body.couponApplied, true);
  assert.equal(calls.order.length + calls.grant.length, 0);
});

test("checkout: exhausted or unknown coupon is ignored, full price quoted", async () => {
  for (const c of [undefined, coupon({ timesUsed: 5 })]) {
    const { services } = fakes({ coupon: c });
    const r = await handleCheckout(config("prod"), ORIGIN, { ...input, couponCode: "TEN", quoteOnly: true }, services, logger);
    assert.equal(r.body.total, 50); assert.equal(r.body.couponApplied, false);
  }
});

test("checkout: creates a PayPal order for the service-computed amount", async () => {
  const { services, calls } = fakes({ coupon: coupon() });
  const r = await handleCheckout(config("prod"), ORIGIN, { ...input, couponCode: "TEN", total: 0.01, amount: 0.01 } as any, services, logger);
  assert.equal(r.body.status, "redirect");
  assert.equal(calls.order[0].amount, "40.00");
  assert.equal(calls.order[0].meta.couponCode, "TEN");
});

test("checkout: dev environment orders exactly $0.01", async () => {
  const { services, calls } = fakes();
  await handleCheckout(config("dev"), ORIGIN, input, services, logger);
  assert.equal(calls.order[0].amount, "0.01");
});

test("checkout: free total enrolls immediately and redeems the coupon", async () => {
  const { services, calls } = fakes({ coupon: coupon({ discountAmount: 50 }) });
  const r = await handleCheckout(config("prod"), ORIGIN, { ...input, couponCode: "TEN" }, services, logger);
  assert.equal(r.body.status, "enrolled");
  assert.equal(calls.grant.length, 1); assert.deepEqual(calls.redeem, ["cp1"]); assert.equal(calls.order.length, 0);
});

test("checkout: already-enrolled learner is not charged again", async () => {
  const { services, calls } = fakes({ enrollment: { id: "e0", accessStatus: 100000000, orderId: "X" } });
  const r = await handleCheckout(config("prod"), ORIGIN, input, services, logger);
  assert.equal(r.body.status, "enrolled"); assert.equal(calls.order.length, 0);
});

test("checkout: rejects bad ids and off-origin return urls", async () => {
  const { services } = fakes();
  assert.equal((await handleCheckout(config("prod"), ORIGIN, { ...input, courseId: "nope" }, services, logger)).status, 400);
  assert.equal((await handleCheckout(config("prod"), ORIGIN, { ...input, contactId: undefined }, services, logger)).status, 400);
  assert.equal((await handleCheckout(config("prod"), ORIGIN, { ...input, returnUrl: "https://evil.example/" }, services, logger)).status, 400);
});

const event = (over: Record<string, unknown> = {}): WebhookEvent => ({
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAP1", status: "COMPLETED", custom_id: `${COURSE}|${CONTACT}|TEN`, amount: { value: "40.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "ORD1" } }, ...over },
});
const hdrs = { authAlgo: "a", certUrl: "c", transmissionId: "t", transmissionSig: "s", transmissionTime: "x" };

test("webhook: unverified signature is rejected", async () => {
  const { services } = fakes({ verify: false });
  assert.equal((await handleWebhook(hdrs, event(), [{ config: config("prod"), services }], logger)).status, 401);
});

test("webhook: verified capture enrolls once and redeems the coupon", async () => {
  const { services, calls } = fakes({ coupon: coupon() });
  const r = await handleWebhook(hdrs, event(), [{ config: config("prod"), services }], logger);
  assert.equal(r.body.fulfilled, true);
  assert.equal(calls.grant[0].orderId, "ORD1"); assert.equal(calls.grant[0].captureId, "CAP1");
  assert.deepEqual(calls.redeem, ["cp1"]);
});

test("webhook: underpayment withholds enrollment", async () => {
  const { services, calls } = fakes({ coupon: coupon() });
  const r = await handleWebhook(hdrs, event({ amount: { value: "1.00", currency_code: "USD" } }), [{ config: config("prod"), services }], logger);
  assert.equal(r.body.ignored, "amount-mismatch"); assert.equal(calls.grant.length, 0);
});

test("webhook: other event types are acknowledged and ignored", async () => {
  const { services, calls } = fakes();
  const r = await handleWebhook(hdrs, { event_type: "CHECKOUT.ORDER.APPROVED" }, [{ config: config("prod"), services }], logger);
  assert.equal(r.status, 200); assert.equal(calls.grant.length, 0);
});

test("webhook: pending and denied captures are logged, not fulfilled", async () => {
  for (const type of ["PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"]) {
    const { services, calls } = fakes();
    const logged: string[] = [];
    const r = await handleWebhook(hdrs, { ...event(), event_type: type }, [{ config: config("prod"), services }], { log() {}, error: (m: string) => { logged.push(m); } });
    assert.equal(r.status, 200); assert.equal(calls.grant.length, 0); assert.equal(logged.length, 1);
  }
});

test("webhook: environment is the one whose webhook verifies", async () => {
  const dev = fakes({ verify: false }); const prod = fakes({ coupon: coupon() });
  await handleWebhook(hdrs, event({ amount: { value: "40.00", currency_code: "USD" } }), [{ config: config("dev"), services: dev.services }, { config: config("prod"), services: prod.services }], logger);
  assert.equal(dev.calls.grant.length, 0); assert.equal(prod.calls.grant.length, 1);
});

// DataverseClient against a mocked HTTP layer.
function mockDataverse(rows: { byOrder?: any; existing?: any }) {
  const log: Array<{ method: string; url: string; body?: any }> = [];
  const fetcher = (async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "tok", expires_in: 3600 });
    log.push({ method, url: decodeURIComponent(String(url)), body: init.body ? JSON.parse(init.body) : undefined });
    if (method === "POST") return Response.json({ suj_onlinecourseenrollmentid: "NEW-1" }, { status: 201 });
    if (method === "PATCH") return new Response(null, { status: 204 });
    if (decodeURIComponent(String(url)).includes("suj_paypal_order_id eq")) return Response.json({ value: rows.byOrder ? [rows.byOrder] : [] });
    return Response.json({ value: rows.existing ? [rows.existing] : [] });
  }) as unknown as typeof fetch;
  return { client: new DataverseClient(config("prod").dataverse, fetcher), log };
}

test("dataverse: redelivered webhook for the same order changes nothing", async () => {
  const { client, log } = mockDataverse({ byOrder: { suj_onlinecourseenrollmentid: "e9", suj_access_status: 100000000, suj_paypal_order_id: "ORD1" } });
  const r = await client.grantEnrollment({ courseId: COURSE, courseName: "C", contactId: CONTACT, orderId: "ORD1", captureId: "CAP1" });
  assert.equal(r.changed, false); assert.equal(log.filter((l) => l.method !== "GET").length, 0);
});

test("dataverse: refunded learner who buys again is reactivated, not duplicated", async () => {
  const { client, log } = mockDataverse({ existing: { suj_onlinecourseenrollmentid: "e7", suj_access_status: 100000001 } });
  const r = await client.grantEnrollment({ courseId: COURSE, courseName: "C", contactId: CONTACT, orderId: "ORD2", captureId: "CAP2" });
  assert.equal(r.created, false); assert.equal(r.changed, true);
  const patch = log.find((l) => l.method === "PATCH")!;
  assert.equal(patch.body.suj_access_status, 100000000); assert.equal(patch.body.suj_paypal_order_id, "ORD2");
  assert.equal(log.filter((l) => l.method === "POST").length, 0);
});

test("dataverse: new learner gets an active enrollment bound to contact and course", async () => {
  const { client, log } = mockDataverse({});
  const r = await client.grantEnrollment({ courseId: COURSE, courseName: "Career Ascent", contactId: CONTACT, orderId: "ORD3", captureId: "CAP3" });
  assert.equal(r.created, true);
  const post = log.find((l) => l.method === "POST")!;
  assert.equal(post.body["suj_Learner@odata.bind"], `/contacts(${CONTACT})`);
  assert.equal(post.body["suj_Online_Course@odata.bind"], `/suj_onlinecourses(${COURSE})`);
  assert.equal(post.body.suj_access_status, 100000000);
});

test("dataverse: coupon codes are escaped in the OData filter", async () => {
  const { client, log } = mockDataverse({});
  await client.findCoupon("O'Brien");
  assert.ok(log[0].url.includes("suj_couponcode eq 'O''Brien'"));
});

function statusServices(captureStatus: string | undefined, contact = CONTACT) {
  return { paypal: { getOrder: async () => ({ customId: `${COURSE}|${contact}|`, captureStatus }) } } as unknown as Services;
}

test("status: maps PayPal capture states for the order's own learner", async () => {
  const cases: Array<[string | undefined, string]> = [["COMPLETED", "completed"], ["PENDING", "pending"], ["DECLINED", "declined"], ["DENIED", "declined"], [undefined, "waiting"]];
  for (const [capture, state] of cases) {
    const r = await handlePaymentStatus({ orderId: "ORDER-12345", contactId: CONTACT }, statusServices(capture));
    assert.equal(r.body.state, state);
  }
});

test("status: another learner's order is not revealed", async () => {
  const r = await handlePaymentStatus({ orderId: "ORDER-12345", contactId: CONTACT }, statusServices("COMPLETED", "33333333-3333-3333-3333-333333333333"));
  assert.equal(r.status, 404);
});

test("status: rejects malformed order ids", async () => {
  assert.equal((await handlePaymentStatus({ orderId: "x'; drop", contactId: CONTACT }, statusServices("COMPLETED"))).status, 400);
});
