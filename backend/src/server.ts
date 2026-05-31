import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';

import { apiRouter } from './routes/index.js';
import { dbInitializationPromise } from './database/index.js';

async function startServer() {
  const app = express();

  const PORT = process.env.PORT || 3000;

  // Database initialization check
  app.use(async (req, res, next) => {
    try {
      await dbInitializationPromise;
      next();
    } catch (err: any) {
      console.error('[PostgreSQL Engine Initialization Error]', err);
      res.status(500).json({
        error: 'Database failed to initialize. Please check connection logs.',
      });
    }
  });

  app.set('trust proxy', 1);

  // CORS
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, PATCH, OPTIONS'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With'
    );

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }

    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Session
  app.use(
    session({
      secret:
        process.env.SESSION_SECRET ||
        'godhara-secret-session-key-2026',

      resave: false,
      saveUninitialized: true,

      name: 'gdh.sid',

      cookie: {
        secure: false,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 1000,
      },
    })
  );

  app.use((req, res, next) => {
    const isSecure =
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https';

    if (isSecure) {
      req.session.cookie.secure = true;
      req.session.cookie.sameSite = 'none';
    } else {
      req.session.cookie.secure = false;
      req.session.cookie.sameSite = 'lax';
    }

    next();
  });

  // API Routes
  app.use('/api', apiRouter);

  // Static Files
  app.use(
    '/api-docs',
    express.static(path.join(process.cwd(), 'data', 'documents'))
  );

  app.use(
    '/assets',
    express.static(path.join(process.cwd(), 'assets'))
  );

  // Uploads Directory
  const uploadsDir = path.join(
    process.cwd(),
    'data',
    'uploads'
  );

  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });

    console.log(
      '[Uploads] Created local image upload directory:',
      uploadsDir
    );
  }

  app.use('/uploads', express.static(uploadsDir));

  // Health Check
  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      app: 'Godhara Backend API',
      environment: process.env.NODE_ENV || 'development',
    });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Godhara Backend running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error(
    '❌ Failed to start Godhara backend:',
    err
  );
});
