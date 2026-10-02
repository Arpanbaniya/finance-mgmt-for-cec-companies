# ADR 0001 — Phase 1 foundation

Accepted 2 October 2026.

The supplied GitHub repository had no refs and this folder had only V2 specifications. Preserve those specifications verbatim. The application uses the repository root, Next.js App Router, React, TypeScript, pnpm, PostgreSQL, Drizzle, Better Auth, Zod, Decimal.js, Tailwind and shadcn/ui. Domain functions stay independent from routes and React. Official setup references: https://nextjs.org/docs/app/getting-started/installation, https://orm.drizzle.team/docs/get-started/postgresql-new, https://better-auth.com/docs/installation.

Local development uses a real persistent PostgreSQL server from embedded-postgres, bound to loopback. This avoids requiring Docker on this workstation. The application database role is separate from the migration administrator. Docker Compose is an alternative for other machines. Hosted PostgreSQL must be explicitly configured before hosted sign-in works; local database files are never deployed.

Phase 1 is implemented incrementally. Only implemented endpoints are exposed. The full 256-operation catalog remains the planned contract; parity checks report planned versus implemented coverage. No dummy business handlers or financial dashboard values are shipped.

Deployment is authorized by the user, to Arpanbaniya/finance-mgmt-for-cec-companies and their Vercel account. Account inspection found one Vercel team, kiingduner-6788. Vercel initially rejected Git linking because the GitHub login connection was absent. Direct deployment is supported independently.
