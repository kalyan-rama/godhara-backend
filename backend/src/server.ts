import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { apiRouter } from './routes/index.js';
import { dbInitializationPromise, reloadCache, getPendingFlushPromise } from './database/index.js';

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

  // Await active database schema and caches check before handling traffic
  app.use(async (req, res, next) => {
    try {
      await dbInitializationPromise;

      // Reload cache for read paths to ensure multi-instance writes are fetched fresh from Postgres
      if (req.method === 'GET' || req.path.includes('/products') || req.path.includes('/orders')) {
        await reloadCache();
      }

      // Intercept response methods to ensure pending database flushes complete before response completes.
      // This is vital for serverless (like Vercel) where background threads freeze immediately when request finishes!
      const originalJson = res.json;
      const originalSend = res.send;
      const originalSendStatus = res.sendStatus;

      res.json = function (body: any) {
        getPendingFlushPromise().then(() => {
          originalJson.call(res, body);
        }).catch((err) => {
          console.error('[PostgreSQL Interceptor] Delay flush failed:', err);
          originalJson.call(res, body);
        });
        return res;
      };

      res.send = function (body: any) {
        getPendingFlushPromise().then(() => {
          originalSend.call(res, body);
        }).catch((err) => {
          console.error('[PostgreSQL Interceptor] Delay flush failed:', err);
          originalSend.call(res, body);
        });
        return res;
      };

      res.sendStatus = function (statusCode: number) {
        getPendingFlushPromise().then(() => {
          originalSendStatus.call(res, statusCode);
        }).catch((err) => {
          console.error('[PostgreSQL Interceptor] Delay flush failed:', err);
          originalSendStatus.call(res, statusCode);
        });
        return res;
      };

      next();
    } catch (err: any) {
      console.error("[PostgreSQL Engine Initialization/Sync Middleware Error] Logging trace:", err);
      res.status(500).json({ error: "Database failed to process cache sync. Please inspect connection logs." });
    }
  });

  // Trust first proxy for secure cookie delivery on proxy headers
  app.set('trust proxy', 1);

  // Robust CORS and Cross-Origin Sharing Policy Middleware for iframe and deployment compatibility
  app.use(cors({
    origin: (origin, callback) => {
      // If no origin (such as server-side requests, curl, or standard iframe sandboxes), allow it
      if (!origin || 
          origin === 'https://godhara-fronted.vercel.app' || 
          origin === 'https://godhara-frontend.vercel.app' ||
          origin.includes('localhost') || 
          origin.includes('127.0.0.1') || 
          origin.includes('run.app') ||
          origin.includes('aistudio')) {
        callback(null, true);
      } else {
        // Fallback to allow connection with credentials for safety, but log it
        callback(null, true);
      }
    },
    credentials: true
  }));

  // Middleware for parsing requests
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Configure express-session for robust state persistence and secure cookies
  app.use(session({
    secret: process.env.SESSION_SECRET || 'godhara-secret-session-key-2026',
    resave: false,
    saveUninitialized: true,
    name: 'gdh.sid',
    cookie: {
      secure: false, // Default fallback
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 1000 // 1 hour active lifetime
    }
  }));

  // Dynamically configure session cookies based on SSL termination to support iframe embedding
  app.use((req, res, next) => {
    const isSec = req.secure || req.headers['x-forwarded-proto'] === 'https';
    if (isSec) {
      req.session.cookie.secure = true;
      req.session.cookie.sameSite = 'none';
    } else {
      req.session.cookie.secure = false;
      req.session.cookie.sameSite = 'lax';
    }
    next();
  });

  // API router goes FIRST
  app.use('/api', apiRouter);

  // Serve static assets / public files (e.g. barcode results, files)
  app.use('/api-docs', express.static(path.join(process.cwd(), 'data', 'documents')));
  app.use('/assets', express.static(path.join(process.cwd(), 'assets')));

  // Ensure and serve static uploaded product images directory
  const uploadsDir = path.join(process.cwd(), 'data', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('[Uploads] Created local image upload directory at:', uploadsDir);
  }
  app.use('/uploads', express.static(uploadsDir));

  // Vite middleware integration for asset pipelines
  if (process.env.NODE_ENV !== 'production') {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      console.log('⚡ Running development server with active Vite middleware');
    } catch (err: any) {
      console.error('❌ Failed to integrate Vite development middleware:', err?.message || err);
    }
  } else {
    // Production serving from client dist directory
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('📦 Running production build server');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Godhara server started at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('❌ Failed to boot Godhara full-stack cluster server:', err);
});
