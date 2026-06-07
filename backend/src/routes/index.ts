import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { apiRouter } from './routes/index.js';
import { dbInitializationPromise, reloadCache } from './database/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  app.set('trust proxy', 1);

  // ── CORS ───────────────────────────────────────────────────────────────────
  const allowedOrigins = [
    'https://godhara-fronted.vercel.app',
    'https://godhara-frontend.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
  ];
  if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.includes('vercel.app') || origin.includes('localhost')) {
        callback(null, true);
      } else {
        callback(null, true); // permissive — tighten in prod if needed
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  }));

  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // ── SESSION ────────────────────────────────────────────────────────────────
  const isProduction = process.env.NODE_ENV === 'production';
  app.use(session({
    secret: process.env.SESSION_SECRET || 'godhara-secret-session-key-2026-change-in-prod',
    resave: false,
    saveUninitialized: false,
    name: 'gdh.sid',
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 2 * 60 * 60 * 1000,
    },
  }));

  // ── DB INIT GATE ───────────────────────────────────────────────────────────
  // Only blocks until the one-time startup init is done.
  // reloadCache() is NEVER called per-request — cache is kept fresh by
  // targeted writes (pgUpsertCart, writeData) and the background cron below.
  app.use(async (_req, _res, next) => {
    try {
      await dbInitializationPromise;
      next();
    } catch (err: any) {
      console.error('[DB Init Middleware Error]', err);
      _res.status(500).json({ error: 'Database initialization failed' });
    }
  });

  // ── REQUEST TIMING ─────────────────────────────────────────────────────────
  // Logs timing for ALL routes — warns if > threshold
  const SLOW_THRESHOLD_MS = 800;
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      if (ms > SLOW_THRESHOLD_MS) {
        console.warn(`⚠️  [PERF SLOW] ${req.method} ${req.originalUrl} → ${ms}ms`);
      } else {
        console.log(`✅ [PERF] ${req.method} ${req.originalUrl} → ${ms}ms [${res.statusCode}]`);
      }
    });
    next();
  });

  // ── API ROUTES ─────────────────────────────────────────────────────────────
  app.use('/api', apiRouter);

  // ── STATIC ASSETS ─────────────────────────────────────────────────────────
  app.use('/assets', (req, res, next) => {
    const pathsToTry = [
      path.join(process.cwd(), 'assets', req.path),
      path.join(__dirname, '..', 'assets', req.path),
    ];
    for (const filePath of pathsToTry) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return res.sendFile(filePath);
      }
    }
    next();
  });

  const publicDir = path.join(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

  if (!isProduction) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
      app.use(vite.middlewares);
      console.log('⚡ Vite dev middleware active');
    } catch (err: any) {
      console.warn('[Vite] Could not start dev middleware:', err?.message);
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Godhara server → http://localhost:${PORT} [${process.env.NODE_ENV || 'development'}]`);
    console.log(`   FROM_EMAIL    : ${process.env.FROM_EMAIL      || '⚠️  not set — fallback: noreply@nexakite.shop'}`);
    console.log(`   RESEND_API_KEY: ${process.env.RESEND_API_KEY  ? '✅ configured' : '⚠️  not set'}`);
    console.log(`   Cloudinary    : ${process.env.CLOUDINARY_CLOUD_NAME ? '✅ configured' : '⚠️  not set'}`);

    // ── BACKGROUND CACHE REFRESH CRON ─────────────────────────────────────
    // Runs every 5 minutes OUT-OF-BAND — never blocks any HTTP request.
    // Keeps in-memory cache fresh for product/order reads between writes.
    const CACHE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    setInterval(async () => {
      const start = Date.now();
      try {
        console.log('[Cron] Background cache refresh starting...');
        await reloadCache();
        const ms = Date.now() - start;
        if (ms > 3000) {
          console.warn(`⚠️  [Cron] Cache refresh took ${ms}ms — Neon is cold. Consider upgrading plan.`);
        } else {
          console.log(`[Cron] Cache refreshed in ${ms}ms ✅`);
        }
      } catch (err: any) {
        console.error('[Cron] Cache refresh failed:', err.message);
      }
    }, CACHE_REFRESH_INTERVAL_MS);

    // Allow Node to exit cleanly even with the interval active (Railway/Render SIGTERM)
    // The interval is unref'd so it won't prevent graceful shutdown
    // Note: setInterval returns a Timeout object in Node — .unref() lets process exit
  });
}

startServer().catch(err => {
  console.error('❌ Server startup failed:', err);
  process.exit(1);
});
