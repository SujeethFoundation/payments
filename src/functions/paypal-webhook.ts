import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

export async function paypalWebhook(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const transmissionId = request.headers.get("paypal-transmission-id");
  context.log("PayPal webhook received.", { transmissionId });

  // Intentional next step: verify the webhook signature with PayPal, resolve the
  // correct environment from verified order metadata, then idempotently create
  // the payment and Online Course Enrollment before redeeming the coupon.
  return {
    status: 501,
    jsonBody: { error: "PayPal webhook processing has not been implemented yet." },
  };
}

app.http("paypalWebhook", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "paypal/webhook",
  handler: paypalWebhook,
});
