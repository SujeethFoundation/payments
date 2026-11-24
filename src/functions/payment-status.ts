import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getMissingSettings, resolvePaymentEnvironment } from "../config/payments-environment";
import { createServices, handlePaymentStatus } from "../lib/checkout-service";

export async function paymentStatus(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const environment = resolvePaymentEnvironment(request.headers.get("origin"));
  if (!environment) return { status: 403, jsonBody: { error: "Checkout origin is not configured." } };

  let body: { orderId?: unknown; contactId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return { status: 400, jsonBody: { error: "A JSON request body is required." } };
  }
  if (getMissingSettings(environment).length > 0) {
    return { status: 503, jsonBody: { error: "Payments are not configured for this environment." } };
  }
  try {
    const result = await handlePaymentStatus(body, createServices(environment));
    return { status: result.status, jsonBody: result.body };
  } catch (error) {
    context.error("Payment status lookup failed.", { environment: environment.name, message: (error as Error).message });
    return { status: 502, jsonBody: { error: "Could not check the payment." } };
  }
}

app.http("paymentStatus", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "checkout/status",
  handler: paymentStatus,
});
