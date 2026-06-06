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

  // Trust first proxy (Render/Railway proxy headers)
  app.set('trust proxy', 1);

  // CORS — allow Vercel frontend and localhost dev
  const allowedOrigins = [
    'https://godhara-fronted.vercel.app',
    'https://godhara-frontend.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
  ];
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
  }

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.includes('vercel.app') || origin.includes('localhost')) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Unknown origin allowed: ${origin}`);
        callback(null, true);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  }));

  // Body parsing
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // Session configuration
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

  // ============================================================
  // PERFORMANCE FIX: Auth routes skip reloadCache entirely.
  // reloadCache() (full DB round-trip) was the cause of 25+ second
  // OTP/login latency. Auth endpoints operate directly on dbObj
  // which always has up-to-date in-memory state — no cache refresh needed.
  //
  // REMOVED: getPendingFlushPromise() response interception.
  // That hook was blocking res.json() until the full flushToPostgres()
  // completed (~10-25 seconds), meaning users waited for the entire DB
  // bulk-sync before seeing any response. Writes now happen in background.
  // ============================================================
  const AUTH_PATHS = [
    '/auth/login',
    '/auth/register',
    '/auth/admin-otp-verify',
    '/auth/verify-otp',
    '/auth/send-otp',
    '/auth/forgot-password',
    '/auth/reset-password',
    '/auth/refresh-token',
    '/auth/google',
    '/auth/logout',
  ];

  // Routes that serve product/order data to customers — these benefit from a fresh cache
  const CACHE_REFRESH_PATHS = [
    '/products',
    '/orders',
    '/cart',
    '/categories',
    '/settings',
  ];

  app.use(async (req, res, next) => {
    try {
      await dbInitializationPromise;

      const isAuthPath = AUTH_PATHS.some(p => req.path.startsWith(p));
      const isCacheRefreshPath = CACHE_REFRESH_PATHS.some(p => req.path.includes(p));
      const needsCache = !isAuthPath && req.method === 'GET' && isCacheRefreshPath;

      // Only reload cache for non-auth data read paths
      if (needsCache) {
        await reloadCache();
      }

      // NOTE: We do NOT intercept res.json/res.send with getPendingFlushPromise().
      // Writes (createUser, updateUser, etc.) flush to PostgreSQL in the background
      // via writeData(). The response is returned immediately after the in-memory
      // cache update — no blocking on DB sync.

      next();
    } catch (err: any) {
      console.error('[DB Init Middleware Error]', err);
      res.status(500).json({ error: 'Database initialization failed' });
    }
  });

  // ============================================================
  // PERFORMANCE LOGGING — tracks all endpoints with detailed timing
  // ============================================================
  app.use((req, res, next) => {
    const start = Date.now();
    const dbQueryStart = Date.now(); // approximation — real DB timing is inside routes

    res.on('finish', () => {
      const totalMs = Date.now() - start;
      const route = req.originalUrl;
      const method = req.method;
      const status = res.statusCode;

      const isAuthRoute =
        route.includes('/auth/login') ||
        route.includes('/auth/register') ||
        route.includes('/auth/otp') ||
        route.includes('/auth/admin-otp') ||
        route.includes('/auth/verify') ||
        route.includes('/auth/refresh');

      const isProductRoute = route.includes('/products');
      const isCartRoute = route.includes('/cart');

      // Auth route targets: login < 1000ms, register < 1500ms, OTP < 1000ms
      if (isAuthRoute) {
        const threshold = route.includes('/register') && !route.includes('/verify') ? 1500 : 1000;
        if (totalMs > threshold) {
          console.warn(`⚠️  [PERF SLOW] ${method} ${route} → ${totalMs}ms (target: <${threshold}ms) [status: ${status}]`);
        } else {
          console.log(`✅ [PERF AUTH] ${method} ${route} → ${totalMs}ms [status: ${status}]`);
        }
      } else if (isProductRoute || isCartRoute) {
        if (totalMs > 2000) {
          console.warn(`⚠️  [PERF SLOW] ${method} ${route} → ${totalMs}ms (threshold: 2000ms) [status: ${status}]`);
        } else {
          console.log(`⏱️  [PERF DATA] ${method} ${route} → ${totalMs}ms [status: ${status}]`);
        }
      } else if (totalMs > 3000) {
        console.warn(`⚠️  [PERF SLOW] ${method} ${route} → ${totalMs}ms [status: ${status}]`);
      }
    });
    next();
  });

  // API routes
  app.use('/api', apiRouter);

  // Static assets
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
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  if (isProduction) {
    console.log('🚀 Backend API mode (production)');
  } else {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      console.log('⚡ Vite dev middleware active');
    } catch (err: any) {
      console.warn('[Vite] Could not start dev middleware:', err?.message);
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Godhara server running at http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   FROM_EMAIL: ${process.env.FROM_EMAIL || '⚠️  Not set — using noreply@nexakite.shop'}`);
    console.log(`   RESEND_API_KEY: ${process.env.RESEND_API_KEY ? '✅ Configured' : '⚠️  Not set — emails will be simulated'}`);
    console.log(`   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? '✅ Configured' : '⚠️  Not configured'}`);
  });
}

startServer().catch(err => {
  console.error('❌ Server startup failed:', err);
  process.exit(1);
});
