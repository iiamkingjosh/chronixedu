import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';

dotenv.config();

const app = express();
const port = process.env.PORT ?? '3001';

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);

app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok' });
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Chronix Edu API listening on http://localhost:${port}`);
});
