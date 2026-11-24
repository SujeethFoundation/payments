import { randomUUID } from "node:crypto";
import { PaymentEnvironmentConfig } from "../config/payments-environment";
import { DataverseClient, cleanGuid, isGuid, ACCESS_ACTIVE } from "./dataverse";
import { PayPalClient, decodeOrderMetadata, WebhookHeaders } from "./paypal";
import { buildQuote, formatAmount, toCents } from "./pricing";

export interface Services {
  dataverse: DataverseClient;
  paypal: PayPalClient;
}

export interface Result {
  status: number;
  body: Record<string, unknown>;
}

export interface Logger {
  log(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export function createServices(config: PaymentEnvironmentConfig): Services {
  return { dataverse: new DataverseClient(config.dataverse), paypal: new PayPalClient(config.paypal) };
}

export interface CheckoutInput {
  courseId?: unknown;
  contactId?: unknown;
  couponCode?: unknown;
  quoteOnly?: unknown;
  returnUrl?: unknown;
  cancelUrl?: unknown;
}

function fail(status: number, error: string): Result {
  return { status, body: { error } };
}

function sameOrigin(value: unknown, origin: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.origin === origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export async function handleCheckout(
  config: PaymentEnvironmentConfig,
  origin: string,
  input: CheckoutInput,
  services: Services,
  logger: Logger,
): Promise<Result> {
  if (!isGuid(input.courseId)) return fail(400, "courseId is required.");
  if (!isGuid(input.contactId)) return fail(400, "Sign in before subscribing.");
  const couponCode = typeof input.couponCode === "string" ? input.couponCode.trim() : "";
  if (couponCode.length > 60) return fail(400, "That coupon code is too long.");

  const courseId = cleanGuid(input.courseId);
  const contactId = cleanGuid(input.contactId);
  const course = await services.dataverse.getCourse(courseId);
  if (!course || !course.active) return fail(404, "This course is not available.");

  let couponDiscount: number | undefined;
  let couponId: string | undefined;
  if (couponCode) {
    const coupon = await services.dataverse.findCoupon(couponCode);
    if (coupon && services.dataverse.couponHasUsesLeft(coupon)) {
      couponDiscount = coupon.discountAmount;
      couponId = coupon.id;
    }
  }

  const quote = buildQuote({
    courseName: course.name,
    currency: course.currency,
    price: course.price,
    couponDiscount,
    environment: config.name,
  });

  if (input.quoteOnly === true) return { status: 200, body: { ...quote } };

  const existing = await services.dataverse.findEnrollment(courseId, contactId);
  if (existing && existing.accessStatus === ACCESS_ACTIVE) {
    return { status: 200, body: { status: "enrolled" } };
  }

  if (toCents(quote.total) <= 0) {
    const granted = await services.dataverse.grantEnrollment({ courseId, courseName: course.name, contactId });
    if (granted.changed && couponId) await services.dataverse.redeemCoupon(couponId);
    logger.log("Free enrollment granted.", { environment: config.name, enrollmentId: granted.enrollmentId });
    return { status: 200, body: { status: "enrolled" } };
  }

  const returnUrl = sameOrigin(input.returnUrl, origin);
  const cancelUrl = sameOrigin(input.cancelUrl, origin);
  if (!returnUrl || !cancelUrl) return fail(400, "returnUrl and cancelUrl must belong to the checkout site.");

  const order = await services.paypal.createOrder({
    amount: formatAmount(quote.total),
    currency: quote.currency,
    description: `${course.name} (lifetime access)`,
    meta: { courseId, contactId, couponCode: couponId ? couponCode : "" },
    returnUrl,
    cancelUrl,
    requestId: randomUUID(),
  });
  logger.log("PayPal order created.", { environment: config.name, orderId: order.orderId });
  return { status: 200, body: { status: "redirect", approvalUrl: order.approvalUrl, orderId: order.orderId } };
}

export interface WebhookEvent {
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    custom_id?: string;
    amount?: { value?: string; currency_code?: string };
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
}

export interface WebhookEnvironment {
  config: PaymentEnvironmentConfig;
  services: Services;
}

export async function handleWebhook(
  headers: WebhookHeaders,
  event: WebhookEvent,
  environments: WebhookEnvironment[],
  logger: Logger,
): Promise<Result> {
  // The environment comes from whichever configured webhook PayPal's signature verifies
  // against, never from anything the sender claims.
  let matched: WebhookEnvironment | undefined;
  for (const candidate of environments) {
    const { webhookId, clientId, clientSecret, baseUrl } = candidate.config.paypal;
    if (!webhookId || !clientId || !clientSecret || !baseUrl) continue;
    if (await candidate.services.paypal.verifyWebhook(webhookId, headers, event)) {
      matched = candidate;
      break;
    }
  }
  if (!matched) return fail(401, "Webhook signature could not be verified.");

  const { config, services } = matched;

  if (event.event_type === "PAYMENT.CAPTURE.PENDING" || event.event_type === "PAYMENT.CAPTURE.DENIED" || event.event_type === "PAYMENT.CAPTURE.DECLINED") {
    // No enrollment yet (pending) or ever (denied); leave a trail so a support question
    // like "I paid but have no access" can be traced to an order.
    logger.error(`PayPal capture is ${event.event_type === "PAYMENT.CAPTURE.PENDING" ? "pending" : "declined or denied"}; no enrollment created.`, {
      environment: config.name,
      eventType: event.event_type,
      captureId: event.resource?.id,
      orderId: event.resource?.supplementary_data?.related_ids?.order_id,
      status: event.resource?.status,
    });
    return { status: 200, body: { ignored: event.event_type } };
  }

  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED" || event.resource?.status !== "COMPLETED") {
    return { status: 200, body: { ignored: event.event_type ?? "unknown" } };
  }

  const resource = event.resource;
  const captureId = resource.id;
  const orderId = resource.supplementary_data?.related_ids?.order_id;
  if (!captureId || !orderId) return fail(400, "Capture event is missing its order.");

  const customId = resource.custom_id ?? (await services.paypal.getOrderCustomId(orderId));
  const meta = decodeOrderMetadata(customId);
  if (!meta || !isGuid(meta.courseId) || !isGuid(meta.contactId)) {
    logger.error("Capture has no usable course metadata.", { environment: config.name, orderId });
    return { status: 200, body: { ignored: "no-metadata" } };
  }

  const course = await services.dataverse.getCourse(meta.courseId);
  if (!course) {
    logger.error("Captured payment is for an unknown course.", { environment: config.name, orderId });
    return { status: 200, body: { ignored: "unknown-course" } };
  }

  let couponId: string | undefined;
  let couponDiscount: number | undefined;
  if (meta.couponCode) {
    const coupon = await services.dataverse.findCoupon(meta.couponCode);
    if (coupon) {
      couponId = coupon.id;
      couponDiscount = coupon.discountAmount;
    }
  }
  const expected = buildQuote({
    courseName: course.name,
    currency: course.currency,
    price: course.price,
    couponDiscount,
    environment: config.name,
  });
  const paid = toCents(Number(resource.amount?.value ?? 0));
  if (paid < toCents(expected.total) || resource.amount?.currency_code !== expected.currency) {
    logger.error("Captured amount is below the expected total; enrollment withheld for review.", {
      environment: config.name, orderId, captureId, paid: resource.amount?.value, expected: expected.total,
    });
    return { status: 200, body: { ignored: "amount-mismatch" } };
  }

  const granted = await services.dataverse.grantEnrollment({
    courseId: cleanGuid(meta.courseId),
    courseName: course.name,
    contactId: cleanGuid(meta.contactId),
    orderId,
    captureId,
  });
  if (granted.changed && couponId) await services.dataverse.redeemCoupon(couponId);
  logger.log("Purchase fulfilled.", { environment: config.name, orderId, enrollmentId: granted.enrollmentId, created: granted.created });
  return { status: 200, body: { fulfilled: true, enrollmentId: granted.enrollmentId } };
}

export type PaymentState = "completed" | "pending" | "declined" | "waiting";

/** What a returning learner's page should tell them, read from PayPal for their own order. */
export async function handlePaymentStatus(
  input: { orderId?: unknown; contactId?: unknown },
  services: Services,
): Promise<Result> {
  if (typeof input.orderId !== "string" || !/^[A-Za-z0-9_-]{8,40}$/.test(input.orderId) || !isGuid(input.contactId)) {
    return fail(400, "orderId and contactId are required.");
  }
  const order = await services.paypal.getOrder(input.orderId);
  const meta = decodeOrderMetadata(order.customId);
  if (!meta || cleanGuid(meta.contactId) !== cleanGuid(input.contactId)) return fail(404, "Order not found.");

  const capture = order.captureStatus;
  let state: PaymentState = "waiting";
  if (capture === "COMPLETED") state = "completed";
  else if (capture === "PENDING") state = "pending";
  else if (capture === "DECLINED" || capture === "DENIED" || capture === "FAILED") state = "declined";
  return { status: 200, body: { state } };
}
