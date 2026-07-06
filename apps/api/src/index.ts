import 'dotenv/config';
import { initSentry, Sentry } from './config/sentry';
initSentry(); // must be first
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pool from './db/client';
import { generalRateLimiter, authRateLimiter } from './middleware/rateLimit';
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
import analyticsRoutes from './routes/analytics';
import timetableRoutes from './routes/timetable';
import classCommentsRoutes from './routes/classComments';
import superAdminRoutes from './routes/superAdmin';
import { detectSupportSession } from './middleware/detectSupportSession';
import { verifyToken } from './middleware/auth';
import { requireActiveSchool } from './middleware/requireActiveSchool';
import { closeReportCardBrowser } from './services/reportCardService';
import { startNotificationWorker, stopNotificationWorker } from './services/notificationWorker';
import { startAnalyticsCron, stopAnalyticsCron } from './services/analyticsService';
import { startFeeReminderCron, stopFeeReminderCron } from './services/feeReminderService';
import { startSubscriptionCron, stopSubscriptionCron } from './services/subscriptionService';
import { startPlatformAnalyticsCron, stopPlatformAnalyticsCron } from './services/platformAnalyticsService';
import { startEmailQueueCron, stopEmailQueueCron } from './services/emailQueueService';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { validateEnv } from './config/env';
import { logger } from './config/logger';

const env = validateEnv();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === '') {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start.');
  process.exit(1);
}
if (!process.env.ROOT_ADMIN_EMAIL) {
  console.error('FATAL: ROOT_ADMIN_EMAIL is not set. Refusing to start.');
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
app.use(cors({
  origin: (origin, cb) => {
    // Disallowed origins get cb(null, false) — cors omits the Allow-Origin header
    // so browsers block the response, without throwing into a 500 that would
    // otherwise echo the rejected origin back in the error body.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as express.Request).rawBody = buf;
  },
}));
app.use(requestLogger);

// Rate limiting (Agent File Rule S5: 5/min for auth, 100/min general)
app.use('/api/auth', authRateLimiter);
app.use('/api',      generalRateLimiter);

// Routes
app.use('/api/auth', authRoutes);
logger.info('auth_router_mounted');

// Support session impersonation — must be before school-level routes
app.use('/api/schools', detectSupportSession);
// Authenticate once for all school routes; verifyToken is a no-op for
// requests already authenticated by detectSupportSession (fix #4).
app.use('/api/schools', verifyToken);
// Block non-super_admin access to any suspended school before any handler runs.
app.use('/api/schools', requireActiveSchool);

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
app.use('/api/schools', analyticsRoutes);
app.use('/api/schools', timetableRoutes);
app.use('/api/schools', classCommentsRoutes);

// Super admin platform routes — guarded by requireRole('super_admin'),
// must NOT have detectSupportSession applied.
app.use('/api/super-admin', superAdminRoutes);

app.get('/health', async (_req, res) => {
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    res.json({
      success: true,
      status: 'ok',
      db: 'ok',
      dbLatencyMs: Date.now() - dbStart,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch {
    res.status(503).json({
      success: false,
      status: 'degraded',
      db: 'error',
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }
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

startNotificationWorker();
startAnalyticsCron();
startFeeReminderCron();
startSubscriptionCron();
startPlatformAnalyticsCron();
startEmailQueueCron();

process.on('SIGTERM', () => {
  stopNotificationWorker();
  stopAnalyticsCron();
  stopFeeReminderCron();
  stopSubscriptionCron();
  stopPlatformAnalyticsCron();
  stopEmailQueueCron();
  closeReportCardBrowser().finally(() => server.close());
});
