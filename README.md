# Sastha Infinite ERP — Local PostgreSQL Edition

This is a **local ERP MVP with database-backed workflows**, not a certified production accounting package. It is designed to be installed on a Windows computer first and moved to cloud hosting after the workflows and controls are tested.

## What is implemented

- Company workspace registration and sign-in with password hashing and JWT authentication.
- Company-separated tenant data and role checks for restricted actions.
- Company profile, currency, timezone and document-prefix settings.
- Customer and supplier master records with edit/archive actions.
- Product catalogue, SKUs/barcodes, price/cost, warehouses, stock-on-hand and movement ledger.
- Sales quotations, sales orders, invoices and credit notes; create drafts, issue documents, print/Save-as-PDF, and issue-related stock movements for invoices/credit notes.
- Purchase orders and supplier invoices; issue supplier invoices to receive stock; receive issued purchase orders once (whole order only; partial receipts are not enabled).
- Customer receipts and supplier payments with optional allocations to issued invoices and balance checks.
- Operating expense entry.
- Dashboard totals, stock preview, activity notifications, audit events and CSV exports for reports.
- Responsive frontend, forms, error notices and local API calls.

## Not yet included / requires separate implementation

Do not use this version for statutory accounting or real production transactions until your workflows have been tested and signed off. The starter schema does not implement a complete double-entry general ledger, bank reconciliation, payroll, manufacturing/BOM/MRP, lot/expiry/serial tracking, multi-currency revaluation, SST/e-Invoice submission, external payment-gateway settlement, recurring billing checkout, user/role administration screens, partial goods receipts, multi-warehouse transfers with paired postings, credit terms/aging policies, or backup scheduling UI. The Subscription page reports deployment status only; it does not charge subscriptions. Tax is entered as a user-supplied rate and does not certify Malaysian tax compliance.

## Requirements

1. Windows 10/11.
2. Node.js 22 LTS: https://nodejs.org/
3. Docker Desktop: https://www.docker.com/products/docker-desktop/ (keep it running when using the ERP).
4. Network access during first-time setup so npm can download packages.

## First-time setup

1. Extract the ZIP to a normal folder, for example `C:\SasthaERP`.
2. Install Node.js 22 LTS and Docker Desktop. Start Docker Desktop and wait for it to be ready.
3. Double-click `setup-local.bat` and wait. It creates `api\.env` with a random JWT secret, starts PostgreSQL, installs the API/frontend dependencies (the manifests explicitly allow the Prisma and esbuild install scripts they need), generates Prisma Client when required, and runs `prisma db push` to create/update the local schema.
4. When it finishes successfully, double-click `run-erp.bat` (or `start-local.bat`). The runner starts PostgreSQL, waits for database readiness, and launches the API and web app together.
5. Open http://localhost:5173. The API health endpoint is http://localhost:4000/health. The API allows localhost and 127.0.0.1 origins during local development to prevent the common local CORS mismatch.
6. On the first screen, choose **Create company** and set a company name, email, and password of at least 12 characters. Keep this password safe; the first account becomes the company owner.

The runner displays both API and web-server output in the same terminal. Leave that terminal open while using the ERP; press Ctrl+C to stop the development processes. PostgreSQL data persists in the Docker volume named `sastha_pgdata`. On each start, it checks the database readiness and runs `prisma db push --skip-generate` before launching the apps.

## Normal start

After first-time setup, use `run-erp.bat` or `start-local.bat`. You can also open Command Prompt in the project root and run `npm run dev`; the root launcher starts PostgreSQL, waits for readiness, and runs API plus frontend. Use `verify-local.bat` to validate the schema and build API/frontend. Use `repair-prisma.bat` only after closing this project's API/web windows if a Windows `EPERM` lock prevents Prisma generation. Setup and repair check for Node processes from this project and stop before replacing generated files if they are still running. Do not run `npx prisma ...` from the project root; run Prisma commands in the `api` directory so the project-local Prisma 6.19.3 CLI is used.

## Manual repair commands

Open Command Prompt in the `api` folder and run:

```bat
npx prisma validate
npx prisma generate
npx prisma db push
npm run dev
```

The `db push` command applies schema changes to this local database. Do not use `docker compose down -v` unless you intentionally want to permanently remove your local database volume and all data in it.

## Local configuration

- PostgreSQL container: `sastha-infinite-erp-db-1`
- Database: `sastha_erp`
- Database user: `sastha_app`
- API: `http://localhost:4000`
- Frontend: `http://localhost:5173`
- Frontend API URL defaults to `http://localhost:4000`; cloud hosting can supply `VITE_API_URL` later.
- `run-erp.bat` is the preferred launch option after extraction; it runs setup if required and then starts the services.
- `GET /health/live` checks whether the API process is alive; `GET /health` checks the database connection too.
- Run `check-local.bat` when troubleshooting; it checks API/database health, frontend availability and the `127.0.0.1:5173` CORS preflight. The launcher checks that ports 4000 and 5173 are free, so an older ERP server cannot silently keep handling requests.
- Keep `api\.env` private. Never upload it to GitHub or include it in a public issue.

## Backup and cloud migration

Before loading valuable company data, configure and test backups and restore. For cloud deployment, use managed PostgreSQL, a unique production JWT secret, HTTPS, private database networking, backups, access controls, logging, and a reviewed data migration plan. The local Docker database and cloud database are separate until data is migrated.

## Known business rules in this MVP

- A sales invoice reduces stock when issued; credit notes add stock when issued. Only product-linked lines move stock.
- A supplier invoice adds stock when issued. A purchase order adds stock only via its Receive action.
- Purchase-order receiving is all-at-once, not partial.
- Customer receipts and supplier payments can be allocated to issued invoices; the API prevents payments above the currently reported invoice balance, but high-concurrency financial posting still requires stronger transactional controls before production.
- Documents and stock movements are intentionally retained for traceability; use draft voiding or reversing documents instead of deleting issued financial transactions.
- The initial owner registration is self-service and needs production hardening (account recovery, email verification, session revocation, MFA and administrator invite flow).

For production use, run acceptance tests against your real workflows, including negative-stock blocking, document numbering collisions, failed transactions, restore tests, concurrent receipts/payments, and financial reconciliation. A passing local startup is not by itself proof of accounting correctness.


## Cloud hosting and subscription pilot

See `CLOUD-DEPLOYMENT.md` and `render.yaml` for the Render deployment starting point. The subscription screen now includes draft Launch, Business and Business Plus plans, a 14-day Launch trial for new registrations, current subscription status, and a plan-request workflow. The plan prices and limits are proposed configuration. Online payment gateway checkout and recurring billing are not implemented; requests require manual follow-up until a gateway integration is added. Do not treat the app as production-ready without the security, migration, backup and business acceptance tests described in `CLOUD-DEPLOYMENT.md`.

## Cloud deployment

For Render deployment, follow [`DEPLOY-TO-RENDER.md`](./DEPLOY-TO-RENDER.md) and use the `render.yaml` Blueprint. The root package is now an npm workspace for the API and frontend; the root start command no longer launches the Windows-only local runner. Responsive layout rules for mobile, tablet, and desktop are included in `web/src/styles.css`.
