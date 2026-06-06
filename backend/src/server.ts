import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { apiRouter } from './routes/index.js';
import { dbInitializationPromise, pool, isPostgresConnected, reloadCache } from './database/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

async function startServer() {
  const app  = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  app.set('trust proxy', 1);

  // ── CORS ────────────────────────────────────────────────────
  const allowedOrigins = [
    'https://godhara-fronted.vercel.app',
    'https://godhara-frontend.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
  ];
  if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin) || origin.includes('vercel.app') || origin.includes('localhost')) {
        cb(null, true);
      } else {
        console.warn(`[CORS] Allowing unknown origin: ${origin}`);
        cb(null, true);
      }
    },
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
  }));

  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // ── TASK 9: Session store — PostgreSQL via connect-pg-simple ─
  // Falls back to memory store when DB is not available.
  const isProduction = process.env.NODE_ENV === 'production';
  let sessionStore: any = undefined;

  await dbInitializationPromise; // ensure DB is ready before configuring session store

  if (isPostgresConnected) {
    try {
      // Dynamic import so the server still boots if package is missing
      const connectPgSimple = (await import('connect-pg-simple')).default;
      const PgStore = connectPgSimple(session);
      // Ensure the session table exists
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS "session" (
            "sid"    VARCHAR NOT NULL COLLATE "default",
            "sess"   JSON NOT NULL,
            "expire" TIMESTAMP(6) NOT NULL,
            CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
          );
          CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
        `);
      } finally { client.release(); }

      sessionStore = new PgStore({ pool, tableName: 'session', createTableIfMissing: false });
      console.log('✅ [Session] PostgreSQL session store active (connect-pg-simple)');
    } catch (err: any) {
      console.warn(`⚠️  [Session] connect-pg-simple unavailable (${err.message}). Using MemoryStore — add connect-pg-simple to dependencies for production.`);
    }
  } else {
    console.warn('⚠️  [Session] No DB connection — using MemoryStore (acceptable for local dev only)');
  }

  app.use(session({
    store: sessionStore,
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

  // ── TASK 3/4: DB init guard — NO reloadCache() in request path ──
  // reloadCache() runs ONLY at startup (above) and in scheduled cron.
  // Auth + data routes serve directly from in-memory cache.
  app.use(async (req, res, next) => {
    try {
      await dbInitializationPromise;
      next();
    } catch (err: any) {
      console.error('[DB Init Middleware Error]', err);
      res.status(500).json({ error: 'Database initialization failed' });
    }
  });

  // ── TASK 6: Performance logging middleware ───────────────────
  app.use((req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const totalMs = Date.now() - start;
      const route   = req.originalUrl;
      const method  = req.method;
      const status  = res.statusCode;

      const isAuth    = route.includes('/auth/');
      const isProduct = route.includes('/products');
      const isCart    = route.includes('/cart');
      const isOrder   = route.includes('/orders');
      const isAdmin   = route.includes('/admin/');

      // Slow query warning threshold per endpoint type
      let threshold = 3000;
      if (isAuth)    threshold = route.includes('/register') && !route.includes('/verify') ? 1500 : 1000;
      else if (isProduct || isCart) threshold = 200;
      else if (isOrder)  threshold = 500;
      else if (isAdmin)  threshold = 1000;

      if (totalMs > 500) {
        console.warn(`⚠️  [PERF SLOW] ${method} ${route} → ${totalMs}ms (threshold: ${threshold}ms) [${status}]`);
      } else {
        console.log(`✅ [PERF] ${method} ${route} → ${totalMs}ms [${status}]`);
      }
    });

    next();
  });

  // ── TASK 4: Scheduled cache refresh (cron-style) ─────────────
  // Reloads in-memory cache every 5 minutes from PostgreSQL.
  // This is the ONLY place reloadCache() is called after startup.
  setInterval(async () => {
    try {
      console.log('[Cron] Refreshing in-memory cache from PostgreSQL...');
      await reloadCache();
      console.log('[Cron] Cache refreshed ✅');
    } catch (err) {
      console.error('[Cron] Cache refresh failed:', err);
    }
  }, 5 * 60 * 1000); // every 5 minutes

  app.use('/api', apiRouter);

  // Static assets
  app.use('/assets', (req, res, next) => {
    const pathsToTry = [
      path.join(process.cwd(), 'assets', req.path),
      path.join(__dirname, '..', 'assets', req.path),
    ];
    for (const p of pathsToTry) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return res.sendFile(p);
    }
    next();
  });

  const publicDir = path.join(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

  if (isProduction) {
    console.log('🚀 Backend API mode (production)');
  } else {
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
    console.log(`🚀 Godhara server running at http://localhost:${PORT}`);
    console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Session store: ${sessionStore ? 'PostgreSQL (connect-pg-simple)' : 'MemoryStore'}`);
    console.log(`   FROM_EMAIL  : ${process.env.FROM_EMAIL || '⚠️  Not set'}`);
    console.log(`   RESEND_KEY  : ${process.env.RESEND_API_KEY ? '✅' : '⚠️  Not set'}`);
    console.log(`   Cloudinary  : ${process.env.CLOUDINARY_CLOUD_NAME ? '✅' : '⚠️  Not configured'}`);
  });
}

startServer().catch(err => {
  console.error('❌ Server startup failed:', err);
  process.exit(1);
});
