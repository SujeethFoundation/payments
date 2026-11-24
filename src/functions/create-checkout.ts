import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getMissingSettings, resolvePaymentEnvironment } from "../config/payments-environment";
import { CheckoutInput, createServices, handleCheckout } from "../lib/checkout-service";

export async function createCheckout(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const origin = request.headers.get("origin");
  const environment = resolvePaymentEnvironment(origin);
  if (!environment || !origin) {
    return { status: 403, jsonBody: { error: "Checkout origin is not configured." } };
  }

  let body: CheckoutInput;
  try {
    body = (await request.json()) as CheckoutInput;
  } catch {
    return { status: 400, jsonBody: { error: "A JSON request body is required." } };
  }

  const missingSettings = getMissingSettings(environment);
  if (missingSettings.length > 0) {
    context.error("Checkout was requested before the environment was configured.", {
      environment: environment.name,
      missingSettings,
    });
    return { status: 503, jsonBody: { error: "Payments are not configured for this environment." } };
  }

  try {
    const result = await handleCheckout(environment, origin, body, createServices(environment), context);
    return { status: result.status, jsonBody: result.body };
  } catch (error) {
    context.error("Checkout failed.", { environment: environment.name, message: (error as Error).message });
    return { status: 502, jsonBody: { error: "We could not start checkout. You were not charged. Please try again." } };
  }
}

app.http("createCheckout", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "checkout",
  handler: createCheckout,
});
