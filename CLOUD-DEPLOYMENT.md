# Sastha Infinite ERP — Cloud Deployment (Render)

This repository includes a Render Blueprint (`render.yaml`) for the API, static React frontend and managed PostgreSQL database. It is a deployment starting point, not a claim that the ERP is production-certified.

## Before deploying

1. Review `README.md` and test the local app using the provided Windows scripts.
2. Confirm `api/.env` is not tracked by Git. Never commit secrets or production data.
3. Push the project to a **private GitHub repository**.
4. Sign in to Render and create a new Blueprint from that repository using `render.yaml`.
5. Review service and database pricing in Render before confirming. The blueprint uses a paid API plan and managed PostgreSQL; hosting charges are separate from your marketing budget.
6. Confirm the API service's `WEB_ORIGIN` matches the actual frontend URL. Confirm the frontend's `VITE_API_URL` matches the actual API URL. If Render assigns different names/URLs, update both environment variables and redeploy.
7. After first deployment, verify `https://<api-host>/health` returns `status: ok` and `database: connected`.
8. Register a test company, confirm the 14-day trial, create sample customers/products/invoices, and verify tenant separation with a second test company.

## Important database note

The initial Blueprint uses `prisma db push` as a convenience for this MVP because the repository does not currently contain committed Prisma migration files. Before production financial data is stored, establish and test a reviewed Prisma migration history and use `prisma migrate deploy` rather than relying on `db push` for future schema changes. Back up and test restore before any schema update.

## Subscription functionality in this version

- Three draft plans are seeded: Launch (RM149/month), Business (RM249/month), and Business Plus (RM499/month).
- New company registrations receive a 14-day Launch trial.
- The Subscription screen displays the current plan, trial end date, proposed usage limits and plan-request form. Usage limits are informational only until enforced in API routes.
- Expired or missing subscriptions are blocked from normal ERP data API routes while `/api/me` and `/api/subscription` remain accessible to manage subscription status.
- A plan request is recorded for manual follow-up by Sastha Infinite Enterprise.

**Online checkout and recurring payments are not integrated.** The app does not charge customers, send payment receipts, or automatically activate a paid subscription. To start charging online, select a Malaysian payment gateway that supports the billing model you need, implement server-side checkout creation and signed/idempotent webhooks, then test success, failure, refunds, cancellation and renewal. Never activate subscriptions from a browser redirect alone.

## Production readiness checklist

- Configure a real domain and HTTPS; update CORS and `VITE_API_URL`.
- Review tenant isolation, rate limits, password reset, email verification, session revocation and MFA needs.
- Configure database backups and perform a restore test.
- Confirm user/product/warehouse limits are enforced in API routes, not only shown in the UI.
- Implement payment gateway and webhook verification before advertising online subscription checkout.
- Perform acceptance testing for sales, purchasing, stock, finance, reporting, and concurrent transactions. This MVP is not a certified statutory accounting package.
