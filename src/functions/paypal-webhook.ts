import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getAllPaymentEnvironments } from "../config/payments-environment";
import { createServices, handleWebhook, WebhookEvent } from "../lib/checkout-service";

export async function paypalWebhook(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const header = (name: string) => request.headers.get(name) ?? "";
  const headers = {
    authAlgo: header("paypal-auth-algo"),
    certUrl: header("paypal-cert-url"),
    transmissionId: header("paypal-transmission-id"),
    transmissionSig: header("paypal-transmission-sig"),
    transmissionTime: header("paypal-transmission-time"),
  };
  if (Object.values(headers).some((value) => !value)) {
    return { status: 400, jsonBody: { error: "Missing PayPal signature headers." } };
  }

  let event: WebhookEvent;
  try {
    event = (await request.json()) as WebhookEvent;
  } catch {
    return { status: 400, jsonBody: { error: "A JSON request body is required." } };
  }

  try {
    const environments = getAllPaymentEnvironments().map((config) => ({ config, services: createServices(config) }));
    const result = await handleWebhook(headers, event, environments, context);
    return { status: result.status, jsonBody: result.body };
  } catch (error) {
    // A 5xx makes PayPal redeliver, which is what we want for a transient Dataverse failure.
    context.error("Webhook processing failed.", { transmissionId: headers.transmissionId, message: (error as Error).message });
    return { status: 500, jsonBody: { error: "Webhook processing failed." } };
  }
}

app.http("paypalWebhook", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "paypal/webhook",
  handler: paypalWebhook,
});
