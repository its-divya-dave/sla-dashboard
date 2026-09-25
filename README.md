# SLA Monitoring Dashboard

> Full README is written in build stage 5. This file currently holds only the
> pre-push checklist so it isn't lost.

## Before pushing

Vercel type-checks on build; the Next.js dev server does not. Type errors only
appear on deploy unless caught locally. Run the production build from `web/`
before every push:

```bash
cd web
npm run build
```

Fix anything it surfaces before pushing, so type errors are caught locally
rather than one Vercel deploy at a time.
