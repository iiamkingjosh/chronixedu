# Chronix Edu

Monorepo scaffold for Chronix Edu — a multi-tenant school management SaaS.

## Stack

- Frontend: `Next.js 14` (App Router), `React`, `Tailwind CSS`, `TypeScript`
- Backend: `Node.js + Express`, `TypeScript`
- Database: `PostgreSQL via Supabase`
- Monorepo workspaces: `/apps/web`, `/apps/api`

## Setup

```bash
npm install
```

## Scripts

```bash
npm run dev:web    # Start Next.js frontend
npm run dev:api    # Start Express backend
npm run lint       # Run ESLint across both workspaces
npm run format     # Format files with Prettier
```

## Environment

Copy `.env.example` to `.env` and provide required values before starting the API or frontend.
