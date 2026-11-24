# Sujeeth Foundation Payments

Azure Functions service for PayPal checkout, coupon validation, payment confirmation, and Online Course Enrollment creation.

## Runtime

- Azure Functions v4
- TypeScript on Node.js 24
- Linux Flex Consumption

## Endpoints

| Endpoint | Purpose | Status |
| --- | --- | --- |
| `GET /api/health` | Deployment health check | Implemented |
| `POST /api/checkout` | Validate a course/coupon and create a PayPal order | Scaffolded |
| `POST /api/paypal/webhook` | Verify payment completion and fulfil the purchase | Scaffolded |

The checkout endpoint maps an allowlisted website origin to `dev`, `test`, or
`prod` configuration. It never accepts an environment name from the browser.

## Required configuration

Copy `local.settings.json.example` to `local.settings.json` for local work.
Do not commit the copied file. Store deployed secrets in Azure Key Vault and
reference them from Function App settings.

Each environment needs:

- an allowlisted website origin;
- PayPal client ID, client secret, and API base URL;
- Dataverse environment URL and application identity.

## Implementation sequence

1. Add the Payment Coupon dollar amount and lifecycle fields in Dataverse.
2. Implement Dataverse reads for the selected course and coupon.
3. Create a PayPal order. Force the completed order amount to `$0.01` in Dev
   and Test; calculate the production amount from the course price and coupon.
4. Verify the PayPal webhook, create the payment and Online Course Enrollment
   idempotently, then mark the coupon redeemed.

No secrets, payment amounts, or Dataverse logical names are committed here.
