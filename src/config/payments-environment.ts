export type PaymentEnvironment = "dev" | "test" | "prod";

export interface PaymentEnvironmentConfig {
  name: PaymentEnvironment;
  allowedOrigins: string[];
  paypal: {
    clientId?: string;
    clientSecret?: string;
    baseUrl?: string;
    webhookId?: string;
  };
  dataverse: {
    url?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
  };
}

const environments: PaymentEnvironment[] = ["dev", "test", "prod"];

function getValue(environment: PaymentEnvironment, suffix: string): string | undefined {
  return process.env[`PAYMENTS_${environment.toUpperCase()}_${suffix}`];
}

function parseOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function getPaymentEnvironmentConfig(
  environment: PaymentEnvironment,
): PaymentEnvironmentConfig {
  return {
    name: environment,
    allowedOrigins: parseOrigins(getValue(environment, "ALLOWED_ORIGINS")),
    paypal: {
      clientId: getValue(environment, "PAYPAL_CLIENT_ID"),
      clientSecret: getValue(environment, "PAYPAL_CLIENT_SECRET"),
      baseUrl: getValue(environment, "PAYPAL_BASE_URL"),
      webhookId: getValue(environment, "PAYPAL_WEBHOOK_ID"),
    },
    dataverse: {
      url: getValue(environment, "DATAVERSE_URL"),
      tenantId: getValue(environment, "DATAVERSE_TENANT_ID"),
      clientId: getValue(environment, "DATAVERSE_CLIENT_ID"),
      clientSecret: getValue(environment, "DATAVERSE_CLIENT_SECRET"),
    },
  };
}

export function getAllPaymentEnvironments(): PaymentEnvironmentConfig[] {
  return environments.map(getPaymentEnvironmentConfig);
}

export function resolvePaymentEnvironment(origin: string | null): PaymentEnvironmentConfig | undefined {
  if (!origin) {
    return undefined;
  }

  return environments
    .map(getPaymentEnvironmentConfig)
    .find((environment) => environment.allowedOrigins.includes(origin));
}

export function getMissingSettings(config: PaymentEnvironmentConfig): string[] {
  const settings: Array<[string, string | undefined]> = [
    ["PayPal client ID", config.paypal.clientId],
    ["PayPal client secret", config.paypal.clientSecret],
    ["PayPal base URL", config.paypal.baseUrl],
    ["Dataverse URL", config.dataverse.url],
    ["Dataverse tenant ID", config.dataverse.tenantId],
    ["Dataverse client ID", config.dataverse.clientId],
    ["Dataverse client secret", config.dataverse.clientSecret],
  ];

  return settings.filter(([, value]) => !value).map(([name]) => name);
}
