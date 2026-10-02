// The web app's address in every link the API builds. config/appUrls.ts has no default, and a
// deployed API refuses to start without APP_URL, so tests state theirs here (2 Oct 2026). A value
// already in the environment, for example from apps/api/.env, is kept.
process.env.APP_URL = process.env.APP_URL || 'http://localhost:3000';
