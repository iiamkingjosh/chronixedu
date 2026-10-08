import { Router, Request, Response, NextFunction } from 'express';
import { channelsFor, loadNotificationConfig } from '../services/notificationSettings';
import { sendEmail } from '../services/emailService';
import { appBaseUrl } from '../config/appUrls';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { logger } from '../config/logger';
import { verifyToken } from '../middleware/auth';
import { requireCapability } from '../middleware/requireCapability';
import { findUserById } from '../db/queries/users';
import { createNotification } from '../db/queries/notifications';
import { redis, rateLimitStoreLogger } from '../middleware/rateLimit';
import { clientIp } from '../middleware/clientIp';
import {
  getMessageContacts,
  createMessage,
  isThreadParticipant,
  getInbox,
  getThreadMessages,
  markThreadRead,
} from '../db/queries/messages';

const router = Router();

// 10 messages per user per minute — prevents spam flooding and SendGrid exhaustion.
const messageLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req: Request) => (req.user?.user_id ? `msg:${req.user.user_id}` : `msg:${ipKeyGenerator(clientIp(req) ?? '')}`),
  store: redis
    ? new RedisStore({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sendCommand: (...args: string[]) => (redis as any).call(...args),
      })
    : undefined,
  passOnStoreError: true, // Redis is best-effort — SECURITY.md Round 19
  logger: rateLimitStoreLogger,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) =>
    res.status(options.statusCode).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Message limit reached. Try again in a minute.' },
    }),
});


// ── Schemas ────────────────────────────────────────────────────────────────────

const sendSchema = z.object({
  recipient_id: z.string().uuid(),
  subject: z.string().max(200).optional().nullable(),
  body: z.string().min(1).max(5000),
  thread_id: z.string().uuid().optional(),
});

// ── GET /:schoolId/messages/contacts — valid recipients for the current user ───

router.get(
  '/:schoolId/messages/contacts',
  verifyToken,
  requireCapability('school.member'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const user = req.user!;
      const contacts = await getMessageContacts(user.user_id, user.role!, schoolId);
      return res.json({ success: true, data: contacts });
    } catch (err) {
      return next(err);
    }
  }
);

// ── POST /:schoolId/messages — send a message ───────────────────────────────────

router.post(
  '/:schoolId/messages',
  verifyToken,
  requireCapability('school.member'),
  messageLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const { schoolId } = req.params;
      const user = req.user!;
      const { recipient_id, subject, body, thread_id } = parsed.data;

      if (recipient_id === user.user_id) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_RECIPIENT', message: 'Cannot message yourself' } });
      }

      // Role-pair enforcement: recipient must be a valid contact for the sender's role
      // (e.g. a parent may only message their child's teacher(s) or the principal).
      const contacts = await getMessageContacts(user.user_id, user.role!, schoolId);
      if (!contacts.some(c => c.id === recipient_id)) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You cannot message this recipient' } });
      }

      if (thread_id) {
        const participant = await isThreadParticipant(thread_id, user.user_id, schoolId);
        if (!participant) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You are not part of this conversation' } });
        }
        // A reply goes to someone already in the conversation. Otherwise a reply could pull anyone
        // in the sender's contacts into a thread, and being in it lets them read all of it.
        if (!(await isThreadParticipant(thread_id, recipient_id, schoolId))) {
          return res.status(403).json({
            success: false,
            error: { code: 'NOT_IN_THREAD', message: 'A reply can only go to someone in this conversation. Start a new message instead.' },
          });
        }
      }

      const message = await createMessage({
        school_id: schoolId,
        sender_id: user.user_id,
        recipient_id,
        subject: subject ?? null,
        body,
        thread_id,
      });

      const sender = await findUserById(user.user_id, schoolId);
      const senderName = sender ? `${sender.first_name} ${sender.last_name}` : 'A school user';
      const notificationTitle = `New message from ${senderName}`;
      const notificationBody = subject ? subject : body.slice(0, 140);

      // Each channel only if the school keeps it on (Settings → Notifications; audit, 8 Oct 2026). An
      // email says who wrote, never what: the message stays in the app.
      const channels = channelsFor(await loadNotificationConfig(schoolId), 'message');
      if (channels.in_app) {
        createNotification({
          user_id: recipient_id,
          type: 'message',
          title: notificationTitle,
          body: notificationBody,
          payload: { thread_id: message.thread_id, message_id: message.id },
        // The message is saved and answered; a lost notification is logged and alerted, not swallowed.
        }).catch(err => logger.error('message_notification_failed', { school_id: schoolId, thread_id: message.thread_id, error: err instanceof Error ? err.message : String(err) }));
      }
      if (channels.email) {
        const recipient = await findUserById(recipient_id, schoolId);
        if (recipient?.email) {
          // sendEmail never throws; it logs and queues a refused send itself.
          await sendEmail(recipient.email, notificationTitle,
            `${senderName} sent you a message on Chronix Edu. Sign in to read it and reply.\n\n${appBaseUrl()}/login`);
        }
      }

      return res.status(201).json({ success: true, data: message });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/messages/inbox — threaded inbox ──────────────────────────────

router.get(
  '/:schoolId/messages/inbox',
  verifyToken,
  requireCapability('school.member'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId } = req.params;
      const user = req.user!;
      const inbox = await getInbox(user.user_id, schoolId);
      return res.json({ success: true, data: inbox });
    } catch (err) {
      return next(err);
    }
  }
);

// ── GET /:schoolId/messages/thread/:threadId — full thread ──────────────────────

router.get(
  '/:schoolId/messages/thread/:threadId',
  verifyToken,
  requireCapability('school.member'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { schoolId, threadId } = req.params;
      const user = req.user!;

      const participant = await isThreadParticipant(threadId, user.user_id, schoolId);
      if (!participant) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You are not part of this conversation' } });
      }

      const messages = await getThreadMessages(threadId, schoolId);
      await markThreadRead(threadId, user.user_id, schoolId);

      return res.json({ success: true, data: messages });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
