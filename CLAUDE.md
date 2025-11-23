# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Principles

- Functions should be short and perform a single, well-defined task.
- Avoid duplicating code or logic; follow the DRY principle.
- Use meaningful and descriptive names for variables, functions, and classes.

## Project Overview

This is a code review SaaS application built on Next.js that allows users to connect GitHub repositories, analyze code functions, and mark them as "clean" or "dirty" for tracking code quality. The application includes subscription management via Stripe and team collaboration features.

## Development Commands

### Initial Setup

```bash
pnpm install
pnpm db:setup      # Create .env file
pnpm db:migrate    # Run database migrations
pnpm db:seed       # Seed with test user (test@test.com / admin123)
```

### Development

```bash
pnpm dev           # Start Next.js dev server with Turbopack
pnpm build         # Build for production
pnpm start         # Start production server
```

### Database Operations

```bash
pnpm db:generate   # Generate Drizzle migrations
pnpm db:migrate    # Run migrations
pnpm db:studio     # Open Drizzle Studio GUI
```

### Stripe Testing (Local)

```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Test card: 4242 4242 4242 4242 (any future date, any 3-digit CVC)

### Docker Testing

Test the production build locally with Docker:

```bash
# Build and run production container
docker compose up --build

# Or run in detached mode
docker compose up -d

# View logs
docker compose logs -f

# Stop container
docker compose down
```

Test security scanning tools inside container:

```bash
# Enter running container
docker exec -it codevf-prod bash

# Run security tools test
./test-security-tools.sh
```

## Architecture Overview

### Application Structure

The application uses Next.js 15 with the App Router and follows a route group pattern:

- **`app/(login)/`** - Unauthenticated routes (sign-in, sign-up)
- **`app/(dashboard)/`** - Protected routes with shared dashboard layout
- **`app/repos/[id]/`** - Repository-specific pages for code review
- **`app/api/`** - API routes and server actions

### Key Technical Components

#### Authentication & Middleware

- JWT-based authentication with cookies (`lib/auth/session.ts`)
- Global middleware (`middleware.ts`) protects `/dashboard` routes and refreshes session tokens on GET requests
- Session expires in 24 hours and is automatically renewed

#### Database Schema (PostgreSQL + Drizzle ORM)

Core tables defined in `lib/db/schema.ts`:

- **users** - User accounts with email/password
- **teams** - Organizations with Stripe subscription data
- **teamMembers** - Many-to-many relationship with RBAC roles
- **githubAppInstallations** - GitHub App installations with access tokens per user
- **githubRepos** - Synced repository metadata
- **codeReviews** - Function-level code quality marks (clean/dirty/unmarked) with unique constraint on (repoId, filePath, lineStart, lineEnd)
- **featureGroups** - AI-generated feature groupings with function IDs and confidence scores
- **activityLogs** - Audit trail for user actions
- **invitations** - Team member invitation system
- **securityScans** - Security scan metadata and summary statistics
- **securityIssues** - Individual security findings from scans
- **scanQuotas** - Monthly scan quota tracking per team
- **aiUsageEvents** - AI token usage tracking for quota enforcement

#### Code Analysis Pipeline

1. **GitHub Integration** (`lib/github/app.ts`, `app/api/github/`)

   - GitHub App-based OAuth authentication
   - Octokit-based GitHub API client
   - Repository access, file fetching, branch management
   - Installation tokens automatically refreshed (1-hour expiry)

2. **Code Parsing** (`app/api/parse/actions.ts`)

   - Tree-sitter parser for JavaScript/TypeScript
   - Extracts function definitions with line ranges
   - Falls back to regex-based parsing if tree-sitter fails

3. **Code Review Marking** (`app/repos/[id]/contents/page.tsx`)

   - Monaco Editor integration for code viewing
   - Function-level marking system (clean/dirty/unmarked)
   - Marks stored with reasons in `codeReviews` table

4. **Auto-Detection & Auto-Clean** (`app/api/repos/[id]/`)
   - AI-powered function analysis endpoints
   - Auto-detect: suggests which functions need review
   - Auto-clean: automatically marks obviously clean functions
   - Statistics aggregation at file and directory levels

5. **AI Feature Grouping** (`app/api/repos/[id]/ai-group-features`)
   - 2-phase hybrid approach for cost-efficient classification
   - **Phase 1 (Metadata)**: Fast classification using function names + file paths only
     - Model: Nova Lite (0.333x credits)
     - Max tokens: 8000
     - Returns confident classifications + ambiguous functions list
   - **Phase 2 (Context)**: Deep dive for ambiguous functions only
     - Model: Nova Lite (0.333x credits)
     - Max tokens: 4000 per file
     - Reads file content from GitHub only when needed
     - Groups by file to minimize API calls
   - Results stored in `featureGroups` table with confidence scores
   - UI: `GroupedFunctionsView.tsx` with directory/AI toggle

6. **Security Scanning** (`lib/security/`)
   - Multi-tool security scanning using open-source tools
   - **Semgrep**: Static application security testing (SAST) using Trail of Bits rules
   - **OpenGrep**: Fast, open-source fork of Semgrep for SAST using Trail of Bits rules
   - **Gitleaks**: Secret and credential detection
   - **Checkov**: Infrastructure as Code (IaC) scanning
   - **Trivy**: Dependency vulnerability scanning
   - Parallel execution for fast results
   - Quota management per subscription tier (Free: 10, Plus: 500, Pro: 10,000 scans/month)
   - Results stored in `securityScans` and `securityIssues` tables

### AI System Architecture

**All AI operations go through `lib/ai/` to prevent duplication and ensure usage tracking.**

Key points:
- Single entry point: `lib/ai/index.ts` exports all AI functions
- Provider: AWS Bedrock (`lib/ai/providers/bedrock.ts`) with Nova Pro/Lite models
- Usage flow: `assertWithinAiLimits()` → AI call → `recordAiUsageEvent()`
- Models: Nova Pro (1.0x), Nova Lite (0.333x credits)
- Limits: Free 40K/150K, Plus 200K/1.5M, Pro 2M/5M tokens (5hr/week windows)

See `docs/api-reference.md` for full function catalog.

### State Management

- **SWR** for client-side data fetching and caching
- Server Components for initial data loading
- Server Actions for mutations (prefixed with `'use server'`)

### Subscription & Payments

- Stripe Checkout for new subscriptions (`app/api/stripe/checkout/route.ts`)
- Webhook handling for subscription updates (`app/api/stripe/webhook/route.ts`)
- Customer Portal integration for subscription management
- Subscription status stored in `teams` table

### Styling

- Tailwind CSS 4.x with PostCSS
- shadcn/ui components (`components/ui/`)
- Radix UI primitives for accessible components

## Important Patterns

### Code Reference Documentation

**ALWAYS check `docs/api-reference.md` before adding new code.**

This file catalogs all API routes, library functions, and components to prevent duplication. Reference it when:
- Adding new API endpoints (check if similar route exists)
- Creating new functions (verify functionality doesn't already exist)
- Implementing features (ensure we're not duplicating code)

### Server Actions Location

Server actions are colocated with their route groups:

- Authentication actions: `app/(login)/actions.ts`
- GitHub operations: `app/api/github/actions.ts`
- Code parsing: `app/api/parse/actions.ts`

### Protected Routes

All routes under `/dashboard` require authentication via middleware. Use `getUser()` from `lib/db/queries.ts` to access current user in Server Components and Server Actions.

### Database Queries

- Common queries abstracted in `lib/db/queries.ts`
- Use Drizzle ORM query builder for complex queries
- Prefer `db.query` API over SQL-like builders for readability

### API Route Patterns

Routes under `app/api/repos/[id]/` follow a consistent pattern:

1. Extract repo ID and validate ownership
2. Perform operation (parse, mark, analyze)
3. Return JSON response with error handling

## Environment Variables

Required variables (see `.env`):

- `POSTGRES_URL` - PostgreSQL connection string
- `STRIPE_SECRET_KEY` - Stripe API key
- `STRIPE_WEBHOOK_SECRET` - Stripe webhook signing secret
- `BASE_URL` - Application URL (for redirects)
- `AUTH_SECRET` - JWT signing secret (generate with `openssl rand -base64 32`)

GitHub App variables (required for repository integration):

- `GITHUB_APP_ID` - Your GitHub App ID
- `GITHUB_APP_PRIVATE_KEY` - (Optional) GitHub App private key. If not set, will be loaded from `github-app-private-key.pem` in the project root
- `GITHUB_APP_CLIENT_ID` - GitHub App OAuth client ID
- `GITHUB_APP_CLIENT_SECRET` - GitHub App OAuth client secret
- `NEXT_PUBLIC_GITHUB_APP_NAME` - GitHub App name (used for installation URL)

**Note**: The GitHub App private key is stored in `github-app-private-key.pem` in the project root and is committed to the repository for convenience. If you prefer to use an environment variable, set `GITHUB_APP_PRIVATE_KEY` and the file will be ignored.

### Setting up a GitHub App

1. Go to GitHub Settings > Developer settings > GitHub Apps > New GitHub App
2. Fill in the required fields:
   - **GitHub App name**: Your app name (e.g., "CodeReviewer")
   - **Homepage URL**: Your application URL
   - **Callback URL**: `{BASE_URL}/api/github/callback`
   - **Webhook**: Can be disabled for now
3. Set permissions:
   - **Repository permissions**:
     - Contents: Read and write
     - Metadata: Read-only
4. Select "Only on this account" or "Any account" depending on your needs
5. After creation, generate a private key and download it
6. Copy the App ID and Client ID from the app settings
7. Generate a client secret
8. Update your `.env` file with these values

## Production Deployment

The application is configured for deployment on:

- **Vercel** (default Next.js hosting)
- **AWS Elastic Beanstalk** (current: uses `Procfile` and `$PORT`)

Important: Set `BASE_URL` to production domain and use production Stripe keys/webhook secrets.
