import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
import { closeReportCardBrowser } from './services/reportCardService';
import { startNotificationWorker, stopNotificationWorker } from './services/notificationWorker';
import { startAnalyticsCron, stopAnalyticsCron } from './services/analyticsService';
import { startFeeReminderCron, stopFeeReminderCron } from './services/feeReminderService';
import { startSubscriptionCron, stopSubscriptionCron } from './services/subscriptionService';
import { startPlatformAnalyticsCron, stopPlatformAnalyticsCron } from './services/platformAnalyticsService';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { validateEnv } from './config/env';
import { logger } from './config/logger';

const env = validateEnv();

const app = express();
const port = env.PORT;

const allowedOrigins = ['http://localhost:3000', ...(env.CORS_ORIGIN ? [env.CORS_ORIGIN] : [])];

app.use(cors({ origin: allowedOrigins }));
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
app.use('/api/auth',    authRoutes);

// Support session impersonation — must be before school-level routes
app.use('/api/schools', detectSupportSession);

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

app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok' });
});

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

process.on('SIGTERM', () => {
  stopNotificationWorker();
  stopAnalyticsCron();
  stopFeeReminderCron();
  stopSubscriptionCron();
  stopPlatformAnalyticsCron();
  closeReportCardBrowser().finally(() => server.close());
});
