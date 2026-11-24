import { PaymentEnvironmentConfig } from "../config/payments-environment";
import { FetchLike } from "./dataverse";

export interface OrderMetadata {
  courseId: string;
  contactId: string;
  couponCode: string;
}

/** custom_id is capped at 255 characters; GUID|GUID|coupon fits comfortably. */
export function encodeOrderMetadata(meta: OrderMetadata): string {
  return [meta.courseId, meta.contactId, meta.couponCode].join("|").slice(0, 255);
}

export function decodeOrderMetadata(value: string | undefined): OrderMetadata | undefined {
  const [courseId, contactId, ...coupon] = (value ?? "").split("|");
  if (!courseId || !contactId) return undefined;
  return { courseId, contactId, couponCode: coupon.join("|") };
}

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export class PayPalClient {
  private token?: { value: string; expires: number };

  constructor(
    private readonly config: PaymentEnvironmentConfig["paypal"],
    private readonly fetcher: FetchLike = fetch,
  ) {}

  private get base(): string {
    return this.config.baseUrl!.replace(/\/$/, "");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.fetcher(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw new Error(`PayPal sign-in failed (${response.status}).`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  /**
   * Creates an order PayPal captures as soon as the learner approves it, so the only
   * thing that fulfils a purchase is the verified PAYMENT.CAPTURE.COMPLETED webhook.
   */
  async createOrder(input: {
    amount: string;
    currency: string;
    description: string;
    meta: OrderMetadata;
    returnUrl: string;
    cancelUrl: string;
    requestId: string;
  }): Promise<{ orderId: string; approvalUrl: string }> {
    const response = await this.fetcher(`${this.base}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": input.requestId,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        processing_instruction: "ORDER_COMPLETE_ON_PAYMENT_APPROVAL",
        purchase_units: [
          {
            reference_id: input.meta.courseId,
            custom_id: encodeOrderMetadata(input.meta),
            description: input.description.slice(0, 127),
            amount: { currency_code: input.currency, value: input.amount },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "The Sujeeth Foundation",
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`PayPal order creation failed (${response.status}).`);
    const order = (await response.json()) as { id: string; links?: Array<{ rel: string; href: string }> };
    const link = order.links?.find((item) => item.rel === "payer-action" || item.rel === "approve");
    if (!order.id || !link) throw new Error("PayPal did not return an approval link.");
    return { orderId: order.id, approvalUrl: link.href };
  }

  async getOrder(orderId: string): Promise<{ customId?: string; orderStatus?: string; captureStatus?: string }> {
    const response = await this.fetcher(`${this.base}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!response.ok) throw new Error(`PayPal order lookup failed (${response.status}).`);
    const order = (await response.json()) as {
      status?: string;
      purchase_units?: Array<{ custom_id?: string; payments?: { captures?: Array<{ status?: string }> } }>;
    };
    const unit = order.purchase_units?.[0];
    return { customId: unit?.custom_id, orderStatus: order.status, captureStatus: unit?.payments?.captures?.[0]?.status };
  }

  async getOrderCustomId(orderId: string): Promise<string | undefined> {
    return (await this.getOrder(orderId)).customId;
  }

  async verifyWebhook(webhookId: string, headers: WebhookHeaders, event: unknown): Promise<boolean> {
    const response = await this.fetcher(`${this.base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { verification_status?: string };
    return body.verification_status === "SUCCESS";
  }
}
