# Deploy Sastha Infinite ERP to Render

## Recommended: deploy all three services with the Blueprint

This project contains a React/Vite frontend, an Express API, and a PostgreSQL database. Deploy all three together; a single Node Web Service does not host the static frontend automatically.

1. Upload the **contents** of this project folder to a GitHub repository (the `render.yaml` file must be at the repository root). Do not upload only the ZIP file as a file in GitHub.
2. In Render, choose **New + → Blueprint** and connect that repository.
3. Render reads `render.yaml` and proposes the API, frontend, and database. Review costs before creating paid services.
4. Confirm the API's `DATABASE_URL` is from the Render database, `JWT_SECRET` is generated, `WEB_ORIGIN` equals the actual frontend URL, and the frontend `VITE_API_URL` equals the actual API URL.
5. Deploy and wait for the API's pre-deploy database schema and plan-seeding command to finish.
6. Test `https://<api-service-host>/health`, then register a test company in the frontend.

## If you are repairing an existing Node Web Service

The old root `start` command launched `scripts/start-dev.cjs`, a Windows/local-only runner. This project changes the root scripts so `yarn start` builds and launches the API instead. In Render Settings → Build & Deploy set:

- Build Command: `yarn install --production=false && yarn build`
- Start Command: `yarn start`

This existing service will host the API only. To use the complete ERP, still create the separate frontend Static Site and PostgreSQL database from `render.yaml` (or configure equivalent services manually). Ensure `DATABASE_URL`, `JWT_SECRET`, and `WEB_ORIGIN` exist on the API service and run the database setup once after the database is connected.

## Node version

Node.js 22 is pinned in `.node-version` and package `engines` to avoid Render selecting an untested major version.

## Security and production note

Never commit `api/.env`, database passwords, JWT secrets, or production data. This MVP's online checkout is not integrated; subscription plan requests require manual follow-up. Review database migrations, backups, tenant isolation, payment processing, and acceptance tests before using real business data.
