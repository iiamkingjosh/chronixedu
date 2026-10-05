import 'dotenv/config';
import { initSentry, Sentry } from './config/sentry';
initSentry(); // must be first
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pool from './db/client';
import { mountRateLimiters } from './middleware/rateLimit';
import authRoutes from './routes/auth';
import schoolsRoutes from './routes/schools';
import sessionsRoutes from './routes/sessions';
import rosterRoutes from './routes/roster';
import usersRoutes from './routes/users';
import assessmentConfigRoutes from './routes/assessmentConfig';
import studentsRoutes from './routes/students';
import scoresRoutes from './routes/scores';
import resultsRoutes from './routes/results';
import dashboardRoutes from './routes/dashboard';
import teacherDashboardRoutes from './routes/teacherDashboard';
import attendanceRoutes from './routes/attendance';
import parentRoutes from './routes/parent';
import studentRoutes from './routes/student';
import assignmentsRoutes from './routes/assignments';
import behaviourRoutes from './routes/behaviour';
import messagesRoutes from './routes/messages';
import announcementsRoutes from './routes/announcements';
import notificationsRoutes from './routes/notifications';
import feesRoutes from './routes/fees';
import feesPublicRoutes from './routes/feesPublic';
import platformBillingRoutes from './routes/platformBilling';
import platformBillingPublicRoutes from './routes/platformBillingPublic';
import analyticsRoutes from './routes/analytics';
import timetableRoutes from './routes/timetable';
import classCommentsRoutes from './routes/classComments';
import principalRemarksRoutes from './routes/principalRemarks';
import noticesRoutes from './routes/notices';
import partnerRoutes from './routes/partner';
import superAdminRoutes from './routes/superAdmin';
import twoFactorRoutes from './routes/twoFactor';
import { detectSupportSession } from './middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from './middleware/auth';
import { requireActiveSchool } from './middleware/requireActiveSchool';
import { requireWritableSubscription } from './middleware/requireWritableSubscription';
import { closeReportCardBrowser } from './services/reportCardService';
import { startNotificationWorker, stopNotificationWorker } from './services/notificationWorker';
import { startAnalyticsCron, stopAnalyticsCron } from './services/analyticsService';
import { startFeeReminderCron, stopFeeReminderCron } from './services/feeReminderService';
import { startSubscriptionCron, stopSubscriptionCron } from './services/subscriptionService';
import { startPlatformAnalyticsCron, stopPlatformAnalyticsCron } from './services/platformAnalyticsService';
import { startEmailQueueCron, stopEmailQueueCron } from './services/emailQueueService';
import { startPasswordHistoryCron, stopPasswordHistoryCron } from './services/passwordHistoryRetention';
import { isSmsEnabled, smsDisabledReason } from './services/termiiService';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { validateEnv } from './config/env';
import { logger } from './config/logger';
import { corsOptions } from './config/cors';

const env = validateEnv();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start.');
  process.exit(1);
}
if (!process.env.ROOT_ADMIN_EMAIL) {
  console.error('FATAL: ROOT_ADMIN_EMAIL is not set. Refusing to start.');
  process.exit(1);
}
if (!process.env.SUPABASE_URL) {
  console.error('FATAL: SUPABASE_URL is not set. Refusing to start.');
  process.exit(1);
}
if (!process.env.SUPABASE_PUBLISHABLE_KEY) {
  console.error('FATAL: SUPABASE_PUBLISHABLE_KEY is not set. Refusing to start.');
  process.exit(1);
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_SERVICE_ROLE_KEY is not set. Refusing to start.');
  process.exit(1);
}
if (process.env.SENDGRID_API_KEY && !process.env.SENDGRID_FROM_EMAIL) {
  console.error('FATAL: SENDGRID_FROM_EMAIL is required when SENDGRID_API_KEY is set. Refusing to start.');
  process.exit(1);
}

const app = express();
const port = env.PORT;

// Railway (and any cloud reverse proxy) sets X-Forwarded-For.
// Without this, express-rate-limit v8 throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// on every request, crashing the process for all rate-limited routes.
app.set('trust proxy', 1);

const allowedOrigins = ['http://localhost:3000', ...(env.CORS_ORIGIN ? [env.CORS_ORIGIN] : [])];

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
}));
app.use(cors(corsOptions(allowedOrigins)));
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    (req as express.Request).rawBody = buf;
  },
}));
app.use(requestLogger);

// Rate limiting — see middleware/rateLimit.ts (Agent File Rule S5, as amended in CLAUDE.md)
mountRateLimiters(app);

// Routes
app.use('/api/auth', authRoutes);
logger.info('auth_router_mounted');

// Paystack webhook + callback — mounted BEFORE the auth chain below because
// Paystack cannot supply a bearer token for either request (server-to-server
// webhook / unauthenticated browser redirect). Every other /api/schools route
// still requires auth via the chain that follows.
app.use('/api/schools', feesPublicRoutes);
// Platform billing — a school paying Chronix for its own subscription. Same reason as
// feesPublicRoutes above: Paystack cannot supply a bearer token for either the webhook or
// the browser callback.
app.use('/api/schools', platformBillingPublicRoutes);

// Support session impersonation — must be before school-level routes
app.use('/api/schools', detectSupportSession);
// Authenticate once for all school routes; verifyToken is a no-op for
// requests already authenticated by detectSupportSession (fix #4).
app.use('/api/schools', verifyToken);
// Block every school route until a pending forced password change is
// resolved — the only way past this is POST /api/auth/change-password,
// which lives on a different router this middleware never touches.
app.use('/api/schools', requirePasswordChanged);
// Block non-super_admin access to any suspended school before any handler runs.
app.use('/api/schools', requireActiveSchool);
// A read-only subscription (the trial gate, migration 046) may read but not write.
app.use('/api/schools', requireWritableSubscription);

app.use('/api/schools', schoolsRoutes);
app.use('/api/schools', sessionsRoutes);
app.use('/api/schools', rosterRoutes);
app.use('/api/schools', usersRoutes);
app.use('/api/schools', assessmentConfigRoutes);
app.use('/api/schools', studentsRoutes);
app.use('/api/schools', scoresRoutes);
app.use('/api/schools', resultsRoutes);
app.use('/api/schools', dashboardRoutes);
app.use('/api/schools', teacherDashboardRoutes);
app.use('/api/schools', attendanceRoutes);
app.use('/api/schools', parentRoutes);
app.use('/api/schools', studentRoutes);
app.use('/api/schools', assignmentsRoutes);
app.use('/api/schools', behaviourRoutes);
app.use('/api/schools', messagesRoutes);
app.use('/api/schools', announcementsRoutes);
app.use('/api/schools', notificationsRoutes);
app.use('/api/schools', feesRoutes);
app.use('/api/schools', platformBillingRoutes);
app.use('/api/schools', analyticsRoutes);
app.use('/api/schools', timetableRoutes);
app.use('/api/schools', classCommentsRoutes);
app.use('/api/schools', principalRemarksRoutes);
app.use('/api/schools', noticesRoutes);
// Outside /api/schools on purpose: machine-to-machine, API-key gated, and none of that
// chain's middleware (support sessions, password-change, active-school) applies.
app.use('/api/partner', partnerRoutes);

// Super admin platform routes — guarded by requireRole('super_admin'),
// must NOT have detectSupportSession applied.
// Platform-admin two-factor (routes/twoFactor.ts), mounted ahead of the rest of /api/super-admin.
app.use('/api/super-admin/two-factor', twoFactorRoutes);
app.use('/api/super-admin', superAdminRoutes);

app.get('/health', async (req, res) => {
  const healthToken = process.env.HEALTH_CHECK_TOKEN;
  if (healthToken) {
    const provided = req.headers['x-health-token'];
    if (provided !== healthToken) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid health check token' } });
    }
  }
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    return res.json({
      success: true,
      status: 'ok',
      db: 'ok',
      dbLatencyMs: Date.now() - dbStart,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch {
    return res.status(503).json({
      success: false,
      status: 'degraded',
      db: 'error',
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }
});

// Public liveness check — no token, no DB query, no sensitive detail (no
// dbLatencyMs, no uptimeSeconds). Exists for external uptime monitors whose
// plan can't send a custom header (so they can't use the token-gated
// /health above). Express serves HEAD requests to this route automatically.
app.get('/health/ping', (req, res) => {
  res.status(200).json({ success: true, status: 'ok' });
});

// Catch-all 404 — keeps unmatched routes on the same JSON envelope as the rest
// of the API instead of falling through to Express's default HTML error page.
app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

// Sentry error handler must be before the custom error handler
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(Sentry.expressErrorHandler() as any);

// Global error handler must be registered last
app.use(errorHandler);

const server = app.listen(port, () => {
  logger.info('server_started', { port });
});

// Stated once at boot, so SMS being off reads as the decision it is, not a broken integration.
if (!isSmsEnabled()) {
  logger.warn('sms_disabled', { run: 'startup', reason: smsDisabledReason() });
  // Switched on without a key is a fault, not the decision: it raises the sms_failing alert.
  if (process.env.SMS_ENABLED?.trim().toLowerCase() === 'true') logger.error('sms_misconfigured', { reason: smsDisabledReason() });
}

startNotificationWorker();
startAnalyticsCron();
startFeeReminderCron();
startSubscriptionCron();
startPlatformAnalyticsCron();
startEmailQueueCron();
startPasswordHistoryCron();

process.on('SIGTERM', () => {
  stopNotificationWorker();
  stopAnalyticsCron();
  stopFeeReminderCron();
  stopSubscriptionCron();
  stopPlatformAnalyticsCron();
  stopEmailQueueCron();
  stopPasswordHistoryCron();
  closeReportCardBrowser().finally(() => server.close());
});
