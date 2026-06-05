import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth';
import schoolsRoutes from './routes/schools';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();

const required = ['DATABASE_URL', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

const app = express();
const port = process.env.PORT ?? '3001';

app.use(cors());
app.use(express.json());

// Rate limiting (Agent File Rule S5: 5/min for auth, 100/min general)
app.use('/api/auth', rateLimit({ windowMs: 60_000, max: 5 }));
app.use('/api',      rateLimit({ windowMs: 60_000, max: 100 }));

// Routes
app.use('/api/auth',    authRoutes);
app.use('/api/schools', schoolsRoutes);

app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok' });
});

// Global error handler must be registered last
app.use(errorHandler);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Chronix Edu API listening on http://localhost:${port}`);
});
