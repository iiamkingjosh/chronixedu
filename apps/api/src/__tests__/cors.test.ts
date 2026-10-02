/**
 * The API is a second origin, so every JSON request from the web app preflights. Without
 * Access-Control-Max-Age, Chrome keeps a preflight for 5 seconds, and the preflight was most of a
 * sign-in's browser-side wait (config/cors.ts has the measurements). These pin the 2-hour cache and
 * that caching changed nothing about who is allowed.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { corsOptions, CORS_PREFLIGHT_MAX_AGE_SECONDS } from '../config/cors';

const WEB = 'https://edu.chronixtechnology.com';
const app = express();
app.use(cors(corsOptions(['http://localhost:3000', WEB])));
app.post('/api/auth/login', (_req, res) => res.json({ ok: true }));

const preflight = (origin: string) => request(app)
  .options('/api/auth/login')
  .set('Origin', origin)
  .set('Access-Control-Request-Method', 'POST')
  .set('Access-Control-Request-Headers', 'content-type');

describe('CORS preflight', () => {
  it("lets the web app's browser keep a preflight for 2 hours, Chrome's cap", async () => {
    expect(CORS_PREFLIGHT_MAX_AGE_SECONDS).toBe(7200);
    const res = await preflight(WEB);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-max-age']).toBe('7200');
  });

  it('still allows no other origin (the header above shows this check can see one)', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('is the configuration the server actually mounts', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    expect(source).toMatch(/app\.use\(cors\(corsOptions\(allowedOrigins\)\)\)/);
    expect(source.match(/app\.use\(cors\(/g)).toHaveLength(1);
  });
});
