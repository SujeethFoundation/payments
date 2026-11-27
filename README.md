# Sujeeth Foundation Payments

Azure Functions service for PayPal checkout, coupon validation, payment confirmation, and Online Course Enrollment creation.

## Platform architecture

The Sujeeth Foundation helps college students network into their first job through Career Circles, a six-week mentorship program. Students, mentors and partners use two front ends, the static site at sujeeth.org and a Power Pages portal, both on one Dataverse environment. Azure Function apps add chat, knowledge search, payments, short links and texting. The Dataverse side (Base Camp, circles, book requests, surveys, credentials, the Career Ascent course) ships as Dataverse solutions and has no repo.

| Repo (README) | Role |
|---|---|
| [`sujeethfoundation.github.io`](https://github.com/SujeethFoundation/sujeethfoundation.github.io/blob/main/README.md) | Website at sujeeth.org, wiki, Discussions, course player and Power Pages CSS |
| [`chat`](https://github.com/SujeethFoundation/chat/blob/main/README.md) | Chat API behind the site's assistant widget |
| [`mcp`](https://github.com/SujeethFoundation/mcp/blob/main/README.md) | MCP server (the "Sujeeth Foundation Graph") that AI assistants use to search Foundation knowledge |
| [`ontology`](https://github.com/SujeethFoundation/ontology/blob/main/README.md) | Concept graph and governance: concepts, approved domains, Feelings API |
| [`websearch`](https://github.com/SujeethFoundation/websearch/blob/main/README.md) | Crawler and hybrid search over ontology-approved websites |
| [`wikisearch`](https://github.com/SujeethFoundation/wikisearch/blob/main/README.md) | Keyword search over the GitHub wiki |
| [`payments`](https://github.com/SujeethFoundation/payments/blob/main/README.md) | PayPal checkout and webhook for online courses |
| [`shortner`](https://github.com/SujeethFoundation/shortner/blob/main/README.md) | Link shortener for go.sujeeth.org |
| [`acs-sms-bot`](https://github.com/SujeethFoundation/acs-sms-bot/blob/main/readme.md) | Texting through Azure Communication Services |

Architecture docs, in the website repo's `architecture/` folder: [platform architecture](https://github.com/SujeethFoundation/sujeethfoundation.github.io/blob/main/architecture/platform-architecture.md) (repos, Azure apps, how they connect), [data model and portal](https://github.com/SujeethFoundation/sujeethfoundation.github.io/blob/main/architecture/platform-data-model-and-portal.md) (Dataverse tables, solutions, Power Pages) and [business architecture](https://github.com/SujeethFoundation/sujeethfoundation.github.io/blob/main/architecture/business-architecture.md) (vision, assumptions, tests). This block is the same in every repo's README; the canonical copy is in the platform architecture doc.

**This repo:** called by the course player on the Power Pages portal (Career Ascent). It talks to PayPal and writes enrollment and payment status to Dataverse. Table names are in the data model doc.

## Runtime

- Azure Functions v4
- TypeScript on Node.js 24
- Linux Flex Consumption

## Endpoints

| Endpoint | Purpose | Status |
| --- | --- | --- |
| `GET /api/health` | Deployment health check | Implemented |
| `POST /api/checkout` | Quote a course/coupon, create a PayPal order, or enroll directly when the total is $0 | Implemented |
| `POST /api/paypal/webhook` | Verify payment completion and fulfil the purchase | Implemented |

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

## How a purchase flows

1. The course page's payment modal calls `POST /api/checkout` with `quoteOnly: true` to show price, coupon discount and total. The browser never sends an amount.
2. **Pay** calls `POST /api/checkout` again. The service recalculates the total from Dataverse (`suj_price`, coupon `tsj_discountamount`) and either:
   - returns `{ status: "enrolled" }` when the total is $0 (the enrollment is created and the coupon redeemed), or
   - creates a PayPal order with `ORDER_COMPLETE_ON_PAYMENT_APPROVAL` and returns `{ status: "redirect", approvalUrl }`.
3. PayPal hosts login, funding and approval, captures the payment on approval, and sends `PAYMENT.CAPTURE.COMPLETED` to the webhook.
4. The webhook verifies PayPal's signature, rechecks the captured amount, then creates (or reactivates) the Online Course Enrollment keyed on the PayPal order ID and adds one to the coupon's `suj_timesused`. A redelivered event changes nothing.

Dev and Test charge exactly `$0.01` whenever money is owed. A $0 total is never charged.

Request and response shapes the browser uses are documented in the website repo's `docs/course-player.md`.

## PayPal webhook setup

In each PayPal app, add a webhook to `https://<function-app>/api/paypal/webhook` subscribed to **Payment capture completed**, and store its ID in `PAYMENTS_<ENV>_PAYPAL_WEBHOOK_ID`. The webhook has no origin, so the environment is whichever configured webhook ID verifies the signature.

## Things to verify in a live environment

- Lookup navigation names used when creating an enrollment (`suj_Learner`, `suj_Online_Course` in `src/lib/dataverse.ts`) match the environment's metadata; a mismatch returns "undeclared property".
- The Dataverse application user can read courses, coupons and enrollments, and write enrollments and `suj_timesused` on coupons.
- Two simultaneous deliveries of the same event could create two enrollments; PayPal redelivers sequentially, so this is unlikely, but an alternate key on `suj_paypal_order_id` would close it.

## Tests

`npm test` builds and runs the unit tests with mocked PayPal and Dataverse.
