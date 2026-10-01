import winston from 'winston';
import { alertFormat } from './alerts';

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    // Sends the events listed in config/alerts.ts to Sentry, and nothing else.
    alertFormat(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});
