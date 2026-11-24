import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  getMissingSettings,
  resolvePaymentEnvironment,
} from "../config/payments-environment";

interface CheckoutRequest {
  courseId?: string;
  couponCode?: string;
}

export async function createCheckout(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const environment = resolvePaymentEnvironment(request.headers.get("origin"));
  if (!environment) {
    return { status: 403, jsonBody: { error: "Checkout origin is not configured." } };
  }

  let body: CheckoutRequest;
  try {
    body = (await request.json()) as CheckoutRequest;
  } catch {
    return { status: 400, jsonBody: { error: "A JSON request body is required." } };
  }

  if (!body.courseId?.trim()) {
    return { status: 400, jsonBody: { error: "courseId is required." } };
  }

  const missingSettings = getMissingSettings(environment);
  if (missingSettings.length > 0) {
    context.error("Checkout was requested before the environment was configured.", {
      environment: environment.name,
      missingSettings,
    });
    return { status: 503, jsonBody: { error: "Payments are not configured for this environment." } };
  }

  // Intentional next step: load the course and coupon from the mapped Dataverse
  // environment, calculate the charge, and create the PayPal order. Dev/test
  // must force the final PayPal amount to $0.01; production uses the calculated total.
  return {
    status: 501,
    jsonBody: {
      error: "Checkout creation has not been implemented yet.",
      environment: environment.name,
    },
  };
}

app.http("createCheckout", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "checkout",
  handler: createCheckout,
});
