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

  // Trust first proxy (Render/Vercel proxy headers)
  app.set('trust proxy', 1);

  // CORS — allow Vercel frontend and localhost dev
  const allowedOrigins = [
    'https://godhara-fronted.vercel.app',
    'https://godhara-frontend.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
  ];
  // Also support any FRONTEND_URL env var set in Render dashboard
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(process.env.FRONTEND_URL);
  }

  app.use(cors({
    origin: (origin, callback) => {
      // Allow server-to-server (no origin) and all allowed origins
      if (!origin || allowedOrigins.includes(origin) || origin.includes('vercel.app') || origin.includes('localhost')) {
        callback(null, true);
      } else {
        // In production, still allow but log unknown origins
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

  // Session configuration — secure cookies for production
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
      maxAge: 2 * 60 * 60 * 1000, // 2 hours
    },
  }));

  // DB init middleware — wait for DB before handling traffic
  app.use(async (req, res, next) => {
    try {
      await dbInitializationPromise;

      // Reload cache for read paths
      if (req.method === 'GET' || req.path.includes('/products') || req.path.includes('/orders')) {
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

  // API routes
  app.use('/api', apiRouter);

  // Serve static assets (logo, etc.)
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

  // Serve public folder (logo.png etc.)
  const publicDir = path.join(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // Production: serve built frontend from dist/
  if (isProduction) {
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
      console.log('📦 Serving production build from dist/');
    }
  } else {
    // Dev: Vite middleware
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
    console.log(`   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? '✅ Configured' : '⚠️  Not configured (set CLOUDINARY_CLOUD_NAME)'}`);
  });
}

startServer().catch(err => {
  console.error('❌ Server startup failed:', err);
  process.exit(1);
});
