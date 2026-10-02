# KaamLedger
  
  Finance and workforce operations for companies in Nepal.
  
  ## Development
  
  Use Node.js 24 and pnpm 11.19.0.
  
  ```sh
  pnpm install --frozen-lockfile
  pnpm setup:local
  pnpm services:up
  ```
  
  Keep PostgreSQL running. In another terminal:
  
  ```sh
  pnpm db:migrate
  pnpm dev
  ```
  
  Open http://localhost:3000. Local credentials and service data stay in ignored .env.local and .local files.
  
  ## Accounts
  
  Set BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD in your process environment, then run pnpm bootstrap:admin to provision the initial organization administrator. Passwords must contain at least 14 characters. Public signup is disabled. Organization administration does not grant financial approval.
  
  ## Deployment
  
  Configure a hosted PostgreSQL database with restricted runtime credentials, DATABASE_URL, BETTER_AUTH_SECRET and BETTER_AUTH_URL. Apply migrations using separate administrator credentials. Never upload local credentials, service data or MIGRATION_DATABASE_URL to the web deployment.
  