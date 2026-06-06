import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { apiRouter } from './routes/index.js';
import { dbInitializationPromise, reloadCache, getPendingFlushPromise } from './database/index.js';

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
  // PERFORMANCE: Only await DB init, skip cache reload on AUTH routes
  // Auth endpoints (login/register/OTP) do NOT need a full cache reload
  // — they operate directly on dbObj methods which are always up-to-date.
  // ============================================================
  const AUTH_PATHS = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/admin-otp-verify',
    '/api/auth/verify-otp',
    '/api/auth/send-otp',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/auth/refresh-token',
    '/api/auth/google',
    '/api/auth/logout',
  ];

  app.use(async (req, res, next) => {
    try {
      await dbInitializationPromise;

      const isAuthPath = AUTH_PATHS.some(p => req.path.startsWith(p.replace('/api', '')));
      const needsCache = !isAuthPath && (req.method === 'GET' || req.path.includes('/products') || req.path.includes('/orders'));

      // Only reload cache for non-auth read paths
      if (needsCache) {
        await reloadCache();
      }

      // Intercept response to flush DB before sending
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      res.json = function (body: any) {
        getPendingFlushPromise()
          .then(() => originalJson(body))
          .catch(() => originalJson(body));
        return res;
      };

      res.send = function (body: any) {
        getPendingFlushPromise()
          .then(() => originalSend(body))
          .catch(() => originalSend(body));
        return res;
      };

      next();
    } catch (err: any) {
      console.error('[DB Init Middleware Error]', err);
      res.status(500).json({ error: 'Database initialization failed' });
    }
  });

  // Request timing middleware (dev + production — helps spot bottlenecks)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const route = req.originalUrl;
      const isSlowAuth = (
        route.includes('/auth/login') ||
        route.includes('/auth/register') ||
        route.includes('/auth/otp') ||
        route.includes('/auth/admin-otp')
      );
      if (isSlowAuth && ms > 1500) {
        console.warn(`⚠️  [PERF SLOW] ${req.method} ${route} → ${ms}ms (threshold: 1500ms)`);
      } else if (isSlowAuth) {
        console.log(`⏱️  [PERF] ${req.method} ${route} → ${ms}ms`);
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
