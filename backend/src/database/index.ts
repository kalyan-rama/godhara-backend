// ============================================================
// GODHARA BACKEND — Optimized Database Layer
// Performance fixes:
//   1. reloadCache() removed from ALL request handlers
//   2. reloadCache() called ONLY at startup + scheduled cron
//   3. Per-entity targeted writes replace bulk flushToPostgres
//   4. PostgreSQL indexes ensured at startup
//   5. Settings/Categories/Products cached with TTL
//   6. connect-pg-simple session store prepared (export pool)
//   7. All sync is fire-and-forget from request path
// ============================================================

import fs from 'fs';
import path from 'path';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/godhara';

console.log("[PostgreSQL] Initializing pool with database connection string...");

export const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  // Pool tuning for performance
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ── In-memory cache ──────────────────────────────────────────
let cache: any = null;
export let isPostgresConnected = false;

// ── TTL caches for high-read, low-write data ─────────────────
let _settingsCache: { data: any; ts: number } | null = null;
let _categoriesCache: { data: any[]; ts: number } | null = null;
let _productsCache: { data: any[]; ts: number } | null = null;
const SETTINGS_TTL_MS   = 600_000;  // 10 min
const CATEGORIES_TTL_MS = 600_000;  // 10 min
const PRODUCTS_TTL_MS   = 300_000;  // 5 min

export function invalidateSettingsCache()   { _settingsCache   = null; }
export function invalidateCategoriesCache() { _categoriesCache = null; }
export function invalidateProductsCache()   { _productsCache   = null; }

// ── Performance logger ───────────────────────────────────────
export function logQueryTime(label: string, startMs: number) {
  const elapsed = Date.now() - startMs;
  if (elapsed > 500) {
    console.warn(`⚠️  [SLOW QUERY] ${label} took ${elapsed}ms (>500ms threshold)`);
  } else {
    console.log(`⏱️  [QUERY] ${label} → ${elapsed}ms`);
  }
}

// ── Schema ───────────────────────────────────────────────────
export async function ensureSchema() {
  if (!isPostgresConnected) return;
  const t0 = Date.now();
  let client;
  try {
    client = await pool.connect();

    // Core tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(512) PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        "passwordHash" TEXT,
        role TEXT DEFAULT 'CUSTOMER',
        phone TEXT DEFAULT '',
        address JSONB DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "googleId" TEXT,
        "googleAvatar" TEXT,
        "authProvider" TEXT,
        "isVerified" BOOLEAN DEFAULT FALSE,
        "isBanned" BOOLEAN DEFAULT FALSE,
        "deletedAt" TIMESTAMP DEFAULT NULL,
        "passwordHistory" JSONB DEFAULT '[]'::jsonb,
        "failedLoginAttempts" INT DEFAULT 0,
        "lockUntil" TIMESTAMP DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(512) PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        price NUMERIC NOT NULL,
        "discountPrice" NUMERIC,
        stock INT DEFAULT 0,
        category TEXT NOT NULL,
        images JSONB DEFAULT '[]'::jsonb,
        "imagePublicIds" JSONB DEFAULT '[]'::jsonb,
        "isFeatured" BOOLEAN DEFAULT FALSE,
        "isActive" BOOLEAN DEFAULT TRUE,
        weight REAL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(512) PRIMARY KEY,
        "userId" VARCHAR(512) REFERENCES users(id) ON DELETE SET NULL,
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        subtotal NUMERIC NOT NULL,
        "shippingCharge" NUMERIC NOT NULL,
        total NUMERIC NOT NULL,
        status TEXT DEFAULT 'PENDING',
        "paymentStatus" TEXT DEFAULT 'PENDING',
        "shippingAddress" JSONB DEFAULT '{}'::jsonb,
        "invoiceUrl" TEXT DEFAULT '',
        "labelUrl" TEXT DEFAULT '',
        "trackingNumber" TEXT DEFAULT '',
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS carts (
        id VARCHAR(512) PRIMARY KEY,
        "userId" VARCHAR(512) UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS coupons (
        id VARCHAR(512) PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        value NUMERIC NOT NULL,
        "minOrderValue" NUMERIC NOT NULL DEFAULT 0,
        "maxUses" INT NOT NULL DEFAULT 0,
        "usageCount" INT NOT NULL DEFAULT 0,
        "expiryDate" TEXT,
        "isActive" BOOLEAN DEFAULT TRUE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS settings (
        id VARCHAR(512) PRIMARY KEY DEFAULT 'global',
        "storeName" TEXT,
        "logoUrl" TEXT,
        "founderImageUrl" TEXT,
        "founderName" TEXT,
        "founderQuote" TEXT,
        "contactEmail" TEXT,
        address TEXT,
        phone TEXT,
        "freeShippingThreshold" NUMERIC,
        "flatShippingCharge" NUMERIC,
        "announcementText" TEXT,
        "lowStockThreshold" INT,
        "deliveryChargeTelangana" NUMERIC DEFAULT 70,
        "deliveryChargeAP" NUMERIC DEFAULT 80,
        "deliveryChargeOther" NUMERIC DEFAULT 100,
        "freeDeliveryPincodes" TEXT DEFAULT '[]',
        "storeLocations" TEXT DEFAULT '[]',
        "storeServicePincodes" TEXT DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id VARCHAR(512) PRIMARY KEY,
        "userId" VARCHAR(512) REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        ip TEXT,
        "userAgent" TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS email_verifications (
        id SERIAL PRIMARY KEY,
        "userId" VARCHAR(512) REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        "expiresAt" TIMESTAMP NOT NULL,
        "usedAt" TIMESTAMP DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        "userId" VARCHAR(512) REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        "expiresAt" TIMESTAMP NOT NULL,
        "usedAt" TIMESTAMP DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        name TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS otp_logs (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        action TEXT NOT NULL,
        ip TEXT,
        success BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // ── TASK 5: Migration — add missing columns to existing DBs ──────────
    const migrations = [
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS "imagePublicIds" JSONB DEFAULT '[]'::jsonb`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS "deliveryChargeTelangana" NUMERIC DEFAULT 70`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS "deliveryChargeAP" NUMERIC DEFAULT 80`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS "deliveryChargeOther" NUMERIC DEFAULT 100`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS "freeDeliveryPincodes" TEXT DEFAULT '[]'`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS "storeLocations" TEXT DEFAULT '[]'`,
      `ALTER TABLE settings ADD COLUMN IF NOT EXISTS "storeServicePincodes" TEXT DEFAULT '[]'`,
    ];
    for (const sql of migrations) {
      await client.query(sql).catch(() => {});
    }

    // ── TASK 7: PostgreSQL Performance Indexes ────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email     ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);
      CREATE INDEX IF NOT EXISTS idx_products_slug   ON products(slug);
      CREATE INDEX IF NOT EXISTS idx_products_cat    ON products(category);
      CREATE INDEX IF NOT EXISTS idx_orders_userid   ON orders("userId");
      CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_otp_logs_email  ON otp_logs(email);
    `);

    logQueryTime('[ensureSchema]', t0);
    console.log("[PostgreSQL] Schema + indexes verified ✅");
  } catch (err) {
    console.error("[PostgreSQL] ensureSchema error:", err);
  } finally {
    if (client) client.release();
  }
}

// ── Field parsers ────────────────────────────────────────────
function parseNumericFields(row: any) {
  if (!row) return row;
  const numericFields = [
    'price','discountPrice','subtotal','shippingCharge','total',
    'value','minOrderValue','freeShippingThreshold','flatShippingCharge',
    'deliveryChargeTelangana','deliveryChargeAP','deliveryChargeOther',
  ];
  for (const f of numericFields) {
    if (row[f] !== undefined && row[f] !== null) row[f] = parseFloat(row[f]);
  }
  return row;
}

function parseDateFields(row: any) {
  if (!row) return row;
  const dateFields = ['createdAt','updatedAt','timestamp','expiresAt','usedAt','deletedAt','lockUntil'];
  for (const f of dateFields) {
    if (row[f] instanceof Date) row[f] = row[f].toISOString();
  }
  return row;
}

// ── Full load (startup only) ─────────────────────────────────
export async function loadFromPostgres() {
  const data: any = {
    users:[], products:[], orders:[], carts:[], categories:[],
    coupons:[], settings:{}, activity_logs:[], email_verifications:[], password_resets:[]
  };
  if (!isPostgresConnected) return data;

  const t0 = Date.now();
  try {
    // Fix: pool.query() gives each query its own connection from the pool,
    // preventing DeprecationWarning: "client.query() called while another query is running."
    const [rCats, rSettings, rUsers, rProds, rOrders, rCarts, rCoupons, rActivity, rEV, rPR] = await Promise.all([
      pool.query('SELECT * FROM categories'),
      pool.query('SELECT * FROM settings WHERE id = $1', ['global']),
      pool.query('SELECT * FROM users'),
      pool.query('SELECT * FROM products'),
      pool.query('SELECT * FROM orders'),
      pool.query('SELECT * FROM carts'),
      pool.query('SELECT * FROM coupons'),
      pool.query('SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 1000'),
      pool.query('SELECT * FROM email_verifications'),
      pool.query('SELECT * FROM password_resets'),
    ]);

    data.categories = rCats.rows.map((r: any) => r.name);

    if (rSettings.rows.length > 0) {
      const s = parseNumericFields(rSettings.rows[0]);
      for (const f of ['freeDeliveryPincodes','storeLocations','storeServicePincodes']) {
        if (typeof s[f] === 'string') {
          try { s[f] = JSON.parse(s[f]); } catch { s[f] = []; }
        }
      }
      data.settings = s;
    } else {
      data.settings = defaultSettings();
    }

    data.users              = rUsers.rows.map((r: any) => parseDateFields(r));
    data.products           = rProds.rows.map((r: any) => parseDateFields(parseNumericFields(r)));
    data.orders             = rOrders.rows.map((r: any) => parseDateFields(parseNumericFields(r)));
    data.carts              = rCarts.rows.map((r: any) => parseDateFields(r));
    data.coupons            = rCoupons.rows.map((r: any) => parseDateFields(parseNumericFields(r)));
    data.activity_logs      = rActivity.rows.map((r: any) => parseDateFields(r));
    data.email_verifications = rEV.rows.map((r: any) => parseDateFields(r));
    data.password_resets    = rPR.rows.map((r: any) => parseDateFields(r));

  } catch (err) {
    console.error("[PostgreSQL] loadFromPostgres error:", err);
  }
  logQueryTime('[loadFromPostgres]', t0);
  return data;
}

// ── TASK 3/4: Targeted write helpers — NO bulk sync in request path ──────────
// Each write goes directly to the relevant table only.

async function pgUpsertUser(u: any) {
  if (!isPostgresConnected) return;
  const t0 = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO users (
          id,name,email,"passwordHash",role,phone,address,"createdAt","updatedAt",
          "googleId","googleAvatar","authProvider","isVerified","isBanned","deletedAt","passwordHistory",
          "failedLoginAttempts","lockUntil"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (id) DO UPDATE SET
          name=EXCLUDED.name, email=EXCLUDED.email, "passwordHash"=EXCLUDED."passwordHash",
          role=EXCLUDED.role, phone=EXCLUDED.phone, address=EXCLUDED.address,
          "updatedAt"=EXCLUDED."updatedAt", "googleId"=EXCLUDED."googleId",
          "googleAvatar"=EXCLUDED."googleAvatar", "authProvider"=EXCLUDED."authProvider",
          "isVerified"=EXCLUDED."isVerified", "isBanned"=EXCLUDED."isBanned",
          "deletedAt"=EXCLUDED."deletedAt", "passwordHistory"=EXCLUDED."passwordHistory",
          "failedLoginAttempts"=EXCLUDED."failedLoginAttempts", "lockUntil"=EXCLUDED."lockUntil"`,
        [
          u.id, u.name, u.email, u.passwordHash||null, u.role, u.phone||'',
          JSON.stringify(u.address||{}), u.createdAt, u.updatedAt,
          u.googleId||null, u.googleAvatar||null, u.authProvider||null,
          !!u.isVerified, !!u.isBanned, u.deletedAt||null,
          JSON.stringify(u.passwordHistory||[]), u.failedLoginAttempts||0, u.lockUntil||null,
        ]
      );
    } finally { client.release(); }
    logQueryTime('[pgUpsertUser]', t0);
  } catch (err) { console.error('[pgUpsertUser] error:', err); }
}

async function pgUpsertProduct(p: any) {
  if (!isPostgresConnected) return;
  const t0 = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO products (
          id,name,slug,description,price,"discountPrice",stock,category,images,
          "imagePublicIds","isFeatured","isActive",weight,"createdAt","updatedAt"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (id) DO UPDATE SET
          name=EXCLUDED.name, slug=EXCLUDED.slug, description=EXCLUDED.description,
          price=EXCLUDED.price, "discountPrice"=EXCLUDED."discountPrice", stock=EXCLUDED.stock,
          category=EXCLUDED.category, images=EXCLUDED.images, "imagePublicIds"=EXCLUDED."imagePublicIds",
          "isFeatured"=EXCLUDED."isFeatured", "isActive"=EXCLUDED."isActive", weight=EXCLUDED.weight,
          "updatedAt"=EXCLUDED."updatedAt"`,
        [
          p.id, p.name, p.slug, p.description||'', p.price, p.discountPrice||null,
          p.stock||0, p.category, JSON.stringify(p.images||[]), JSON.stringify(p.imagePublicIds||[]),
          Boolean(p.isFeatured), Boolean(p.isActive), p.weight, p.createdAt, p.updatedAt,
        ]
      );
    } finally { client.release(); }
    invalidateProductsCache();
    logQueryTime('[pgUpsertProduct]', t0);
  } catch (err) { console.error('[pgUpsertProduct] error:', err); }
}

async function pgUpsertOrder(o: any) {
  if (!isPostgresConnected) return;
  const t0 = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO orders (
          id,"userId",items,subtotal,"shippingCharge",total,status,"paymentStatus",
          "shippingAddress","invoiceUrl","labelUrl","trackingNumber","createdAt","updatedAt"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET
          status=EXCLUDED.status, "paymentStatus"=EXCLUDED."paymentStatus",
          "invoiceUrl"=EXCLUDED."invoiceUrl", "labelUrl"=EXCLUDED."labelUrl",
          "trackingNumber"=EXCLUDED."trackingNumber", "updatedAt"=EXCLUDED."updatedAt"`,
        [
          o.id, o.userId, JSON.stringify(o.items||[]), o.subtotal, o.shippingCharge, o.total,
          o.status, o.paymentStatus, JSON.stringify(o.shippingAddress||{}),
          o.invoiceUrl||'', o.labelUrl||'', o.trackingNumber||'', o.createdAt, o.updatedAt,
        ]
      );
    } finally { client.release(); }
    logQueryTime('[pgUpsertOrder]', t0);
  } catch (err) { console.error('[pgUpsertOrder] error:', err); }
}

async function pgUpsertCart(c: any) {
  if (!isPostgresConnected) return;
  const t0 = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO carts (id,"userId",items,"updatedAt")
        VALUES ($1,$2,$3,$4)
        ON CONFLICT ("userId") DO UPDATE SET items=EXCLUDED.items,"updatedAt"=EXCLUDED."updatedAt"`,
        [c.id, c.userId, JSON.stringify(c.items||[]), c.updatedAt]
      );
    } finally { client.release(); }
    logQueryTime('[pgUpsertCart]', t0);
  } catch (err) { console.error('[pgUpsertCart] error:', err); }
}

async function pgUpsertSettings(s: any) {
  if (!isPostgresConnected) return;
  const t0 = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO settings (
          id,"storeName","logoUrl","founderImageUrl","founderName","founderQuote",
          "contactEmail",address,phone,"freeShippingThreshold","flatShippingCharge",
          "announcementText","lowStockThreshold",
          "deliveryChargeTelangana","deliveryChargeAP","deliveryChargeOther",
          "freeDeliveryPincodes","storeLocations","storeServicePincodes"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (id) DO UPDATE SET
          "storeName"=EXCLUDED."storeName","logoUrl"=EXCLUDED."logoUrl",
          "founderImageUrl"=EXCLUDED."founderImageUrl","founderName"=EXCLUDED."founderName",
          "founderQuote"=EXCLUDED."founderQuote","contactEmail"=EXCLUDED."contactEmail",
          address=EXCLUDED.address,phone=EXCLUDED.phone,
          "freeShippingThreshold"=EXCLUDED."freeShippingThreshold",
          "flatShippingCharge"=EXCLUDED."flatShippingCharge",
          "announcementText"=EXCLUDED."announcementText",
          "lowStockThreshold"=EXCLUDED."lowStockThreshold",
          "deliveryChargeTelangana"=EXCLUDED."deliveryChargeTelangana",
          "deliveryChargeAP"=EXCLUDED."deliveryChargeAP",
          "deliveryChargeOther"=EXCLUDED."deliveryChargeOther",
          "freeDeliveryPincodes"=EXCLUDED."freeDeliveryPincodes",
          "storeLocations"=EXCLUDED."storeLocations",
          "storeServicePincodes"=EXCLUDED."storeServicePincodes"`,
        [
          'global', s.storeName, s.logoUrl, s.founderImageUrl, s.founderName, s.founderQuote,
          s.contactEmail, s.address, s.phone, s.freeShippingThreshold, s.flatShippingCharge,
          s.announcementText, s.lowStockThreshold,
          s.deliveryChargeTelangana??70, s.deliveryChargeAP??80, s.deliveryChargeOther??100,
          JSON.stringify(s.freeDeliveryPincodes??[]),
          JSON.stringify(s.storeLocations??[]),
          JSON.stringify(s.storeServicePincodes??[]),
        ]
      );
    } finally { client.release(); }
    invalidateSettingsCache();
    logQueryTime('[pgUpsertSettings]', t0);
  } catch (err) { console.error('[pgUpsertSettings] error:', err); }
}

async function pgUpsertCategory(name: string) {
  if (!isPostgresConnected) return;
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]
      );
    } finally { client.release(); }
    invalidateCategoriesCache();
  } catch (err) { console.error('[pgUpsertCategory] error:', err); }
}

async function pgUpsertCoupon(c: any) {
  if (!isPostgresConnected) return;
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO coupons (id,code,type,value,"minOrderValue","maxUses","usageCount","expiryDate","isActive","createdAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET
          code=EXCLUDED.code,type=EXCLUDED.type,value=EXCLUDED.value,
          "minOrderValue"=EXCLUDED."minOrderValue","maxUses"=EXCLUDED."maxUses",
          "usageCount"=EXCLUDED."usageCount","expiryDate"=EXCLUDED."expiryDate",
          "isActive"=EXCLUDED."isActive"`,
        [c.id,c.code,c.type,c.value,c.minOrderValue,c.maxUses,c.usageCount,c.expiryDate,!!c.isActive,c.createdAt]
      );
    } finally { client.release(); }
  } catch (err) { console.error('[pgUpsertCoupon] error:', err); }
}

async function pgDeleteCoupon(id: string) {
  if (!isPostgresConnected) return;
  try {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM coupons WHERE id=$1', [id]);
    } finally { client.release(); }
  } catch (err) { console.error('[pgDeleteCoupon] error:', err); }
}

async function pgUpsertActivityLog(log: any) {
  if (!isPostgresConnected) return;
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO activity_logs (id,"userId",action,ip,"userAgent",metadata,timestamp)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [log.id,log.userId,log.action,log.ip,log.userAgent,JSON.stringify(log.metadata||{}),log.timestamp]
      );
    } finally { client.release(); }
  } catch (err) { console.error('[pgUpsertActivityLog] error:', err); }
}

async function pgUpsertEmailVerification(ev: any) {
  if (!isPostgresConnected) return;
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO email_verifications ("userId",token,"expiresAt","usedAt")
        VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET "usedAt"=EXCLUDED."usedAt"`,
        [ev.userId, ev.token, ev.expiresAt, ev.usedAt]
      );
    } finally { client.release(); }
  } catch (err) { console.error('[pgUpsertEmailVerification] error:', err); }
}

async function pgUpsertPasswordReset(pr: any) {
  if (!isPostgresConnected) return;
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO password_resets ("userId",token,"expiresAt","usedAt")
        VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET "usedAt"=EXCLUDED."usedAt"`,
        [pr.userId, pr.token, pr.expiresAt, pr.usedAt]
      );
    } finally { client.release(); }
  } catch (err) { console.error('[pgUpsertPasswordReset] error:', err); }
}

// ── Legacy bulk flush (startup/migration only) ───────────────
export async function flushToPostgres(data: any) {
  if (!isPostgresConnected) return;
  console.log('[Database Sync] Starting full bulk sync (startup/migration only)...');
  const t0 = Date.now();

  const promises: Promise<any>[] = [];
  if (data.categories) for (const c of data.categories) promises.push(pgUpsertCategory(c));
  if (data.settings) promises.push(pgUpsertSettings(data.settings));
  if (data.users) for (const u of data.users) promises.push(pgUpsertUser(u));
  if (data.products) for (const p of data.products) promises.push(pgUpsertProduct(p));
  if (data.orders) for (const o of data.orders) promises.push(pgUpsertOrder(o));
  if (data.carts) for (const c of data.carts) promises.push(pgUpsertCart(c));
  if (data.coupons) for (const c of data.coupons) promises.push(pgUpsertCoupon(c));
  if (data.activity_logs) for (const l of data.activity_logs) promises.push(pgUpsertActivityLog(l));
  if (data.email_verifications) for (const ev of data.email_verifications) promises.push(pgUpsertEmailVerification(ev));
  if (data.password_resets) for (const pr of data.password_resets) promises.push(pgUpsertPasswordReset(pr));

  await Promise.allSettled(promises);
  logQueryTime('[flushToPostgres bulk]', t0);
  console.log('[Database Sync] Bulk sync complete ✅');
}

// ── Default settings seed ────────────────────────────────────
function defaultSettings() {
  return {
    storeName: 'Godhara',
    logoUrl: '/assets/logo.png',
    founderImageUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=600',
    founderName: 'Kalyan V., Founder of Godhara',
    founderQuote: 'Godhara was founded with a simple yet powerful vision — to bring back the purity, wisdom, and sustainability of our Indian traditions.',
    contactEmail: 'godhara.2026@gmail.com',
    address: 'Pocharam Apartment, Banswada, Telangana 503187',
    phone: '+91 8978038932',
    freeShippingThreshold: 1000,
    flatShippingCharge: 50,
    announcementText: 'Shop ₹1000 to Get Free Shipping',
    lowStockThreshold: 10,
    deliveryChargeTelangana: 70,
    deliveryChargeAP: 80,
    deliveryChargeOther: 100,
    freeDeliveryPincodes: [],
    storeLocations: [],
    storeServicePincodes: [],
  };
}

// ── Startup initializer ──────────────────────────────────────
async function startupInit() {
  const dbJsonPath = path.join(process.cwd(), 'data', 'db.json');

  if (!process.env.DATABASE_URL) {
    isPostgresConnected = false;
    console.log("[Database] No DATABASE_URL — using local JSON fallback.");
  } else {
    console.log("[Database] Probing PostgreSQL...");
    try {
      const testPool = new pg.Pool({
        connectionString,
        ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 4000,
      });
      const c = await testPool.connect();
      await c.query('SELECT 1');
      c.release();
      await testPool.end();
      isPostgresConnected = true;
      console.log("[PostgreSQL] ✅ Connection established.");
    } catch {
      isPostgresConnected = false;
      console.log("[Database] PostgreSQL unreachable — using JSON fallback.");
    }
  }

  if (isPostgresConnected) {
    await ensureSchema();

    // Check if tables are empty (first-run migration)
    let mustMigrate = false;
    let client;
    try {
      client = await pool.connect();
      const res = await client.query('SELECT COUNT(*) FROM users');
      mustMigrate = parseInt(res.rows[0].count) === 0;
    } catch { mustMigrate = true; }
    finally { if (client) client.release(); }

    if (mustMigrate) {
      if (fs.existsSync(dbJsonPath)) {
        try {
          const legacyData = JSON.parse(fs.readFileSync(dbJsonPath, 'utf8'));
          await flushToPostgres(legacyData);
          console.log("[PostgreSQL] Migrated db.json → PostgreSQL ✅");
        } catch (err) { console.error("[PostgreSQL] Migration error:", err); }
      } else {
        await flushToPostgres({ ...getDefaultSeedData() });
        console.log("[PostgreSQL] Seeded default data ✅");
      }
    }

    cache = await loadFromPostgres();
    console.log("[PostgreSQL] In-memory cache loaded ✅");
  } else {
    // JSON fallback
    console.log("[Database_Fallback] Loading data/db.json...");
    try {
      const dir = path.dirname(dbJsonPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(dbJsonPath)) {
        const raw = fs.readFileSync(dbJsonPath, 'utf8');
        cache = JSON.parse(raw);
        if (!cache?.users?.length) cache = getDefaultSeedData();
      } else {
        cache = getDefaultSeedData();
        fs.writeFileSync(dbJsonPath, JSON.stringify(cache, null, 2), 'utf8');
      }
      console.log("[Database_Fallback] JSON cache initialized ✅");
    } catch (fsErr) {
      console.error("[Database_Fallback] Error:", fsErr);
      cache = { users:[], products:[], orders:[], carts:[], coupons:[], categories:[], settings:{} };
    }
  }
}

function getDefaultSeedData() {
  const now = new Date().toISOString();
  return {
    users: [
      {
        id:'admin-1', name:'Godhara Admin', email:'godhara.2026@gmail.com',
        passwordHash:'$2b$10$HLXZBH8Est4SUosKQiX1/uEZPuhj/hiZ4bFkZdgu7ZPPI.Z7E2h4W',
        role:'ADMIN', phone:'+91 8978038932',
        address:{street:'Pocharam Apartment',city:'Banswada',state:'Telangana',pincode:'503187'},
        createdAt:now, updatedAt:now,
      },
    ],
    products: [],
    orders: [],
    carts: [],
    categories: ['Dairy Products','Personal Care','Spiritual','Ayurvedic Remedies'],
    coupons: [
      {
        id:'coupon-1', code:'GODHARA10', type:'PERCENTAGE', value:10,
        minOrderValue:500, maxUses:100, usageCount:0, expiryDate:'2027-12-31',
        isActive:true, createdAt:now,
      },
    ],
    settings: defaultSettings(),
  };
}

export const dbInitializationPromise = startupInit();

// ── TASK 4: reloadCache — ONLY called at startup/scheduled cron ──
// NEVER called inside request handlers.
// Single-flight lock: prevents concurrent reloads from piling up.
let _reloadInFlight: Promise<void> | null = null;

export function reloadCache(): Promise<void> {
  if (_reloadInFlight) {
    console.log('[reloadCache] Already in-flight — returning existing promise (single-flight)');
    return _reloadInFlight;
  }

  _reloadInFlight = (async () => {
    if (!isPostgresConnected) return;
    const t0 = Date.now();
    try {
      cache = await loadFromPostgres();
      // Bust all TTL caches on full reload
      invalidateSettingsCache();
      invalidateCategoriesCache();
      invalidateProductsCache();
      logQueryTime('[reloadCache]', t0);
    } catch (err) {
      console.error("[PostgreSQL] reloadCache error:", err);
    } finally {
      _reloadInFlight = null;
    }
  })();

  return _reloadInFlight;
}

// ── In-memory read ───────────────────────────────────────────
function readData() {
  if (!cache) return { users:[], products:[], orders:[], carts:[], categories:[], coupons:[], settings:{} };
  return cache;
}

// ── In-memory write + targeted DB write (fire-and-forget) ────
function writeData(data: any, dirtyEntities?: { type: string; payload: any }[]) {
  cache = data;

  if (!isPostgresConnected) {
    // JSON fallback write
    const dbJsonPath = path.join(process.cwd(), 'data', 'db.json');
    try {
      fs.writeFileSync(dbJsonPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error("[Database_Fallback] JSON write error:", err);
    }
    return;
  }

  // Fire-and-forget: only write the changed entity(ies), not the whole DB
  if (!dirtyEntities) return;
  for (const e of dirtyEntities) {
    switch (e.type) {
      case 'user':           pgUpsertUser(e.payload).catch(console.error); break;
      case 'product':        pgUpsertProduct(e.payload).catch(console.error); break;
      case 'order':          pgUpsertOrder(e.payload).catch(console.error); break;
      case 'cart':           pgUpsertCart(e.payload).catch(console.error); break;
      case 'settings':       pgUpsertSettings(e.payload).catch(console.error); break;
      case 'category':       pgUpsertCategory(e.payload).catch(console.error); break;
      case 'coupon':         pgUpsertCoupon(e.payload).catch(console.error); break;
      case 'coupon_delete':  pgDeleteCoupon(e.payload).catch(console.error); break;
      case 'activity_log':   pgUpsertActivityLog(e.payload).catch(console.error); break;
      case 'email_verification': pgUpsertEmailVerification(e.payload).catch(console.error); break;
      case 'password_reset': pgUpsertPasswordReset(e.payload).catch(console.error); break;
    }
  }
}

// ── TASK 8: TTL-cached getters ────────────────────────────────
function getCachedSettings() {
  const now = Date.now();
  if (_settingsCache && (now - _settingsCache.ts) < SETTINGS_TTL_MS) {
    return _settingsCache.data;
  }
  const s = readData().settings;
  _settingsCache = { data: s, ts: now };
  return s;
}

function getCachedCategories() {
  const now = Date.now();
  if (_categoriesCache && (now - _categoriesCache.ts) < CATEGORIES_TTL_MS) {
    return _categoriesCache.data;
  }
  const c = readData().categories;
  _categoriesCache = { data: c, ts: now };
  return c;
}

function getCachedProducts() {
  const now = Date.now();
  if (_productsCache && (now - _productsCache.ts) < PRODUCTS_TTL_MS) {
    return _productsCache.data;
  }
  const p = readData().products;
  _productsCache = { data: p, ts: now };
  return p;
}

// ── dbObj public API ─────────────────────────────────────────
export const dbObj = {

  // SETTINGS (Task 8: cached)
  getSettings() { return getCachedSettings(); },
  updateSettings(newSettings: any) {
    const data = readData();
    data.settings = { ...data.settings, ...newSettings };
    _settingsCache = null;
    writeData(data, [{ type:'settings', payload: data.settings }]);
    return data.settings;
  },

  // USERS
  getUsers() { return readData().users; },
  findUserByEmail(email: string) {
    return readData().users.find((u: any) => u.email.toLowerCase() === email.toLowerCase());
  },
  findUserById(id: string) { return readData().users.find((u: any) => u.id === id); },
  createUser(user: any) {
    const data = readData();
    const newUser = {
      id: `usr-${Date.now()}`,
      role: 'CUSTOMER',
      address: { street:'', city:'', state:'', pincode:'' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...user,
    };
    data.users.push(newUser);
    writeData(data, [{ type:'user', payload: newUser }]);
    return newUser;
  },
  updateUser(id: string, updates: any) {
    const data = readData();
    const idx = data.users.findIndex((u: any) => u.id === id);
    if (idx === -1) return null;
    data.users[idx] = { ...data.users[idx], ...updates, updatedAt: new Date().toISOString() };
    writeData(data, [{ type:'user', payload: data.users[idx] }]);
    return data.users[idx];
  },
  softDeleteUser(id: string) {
    const data = readData();
    const idx = data.users.findIndex((u: any) => u.id === id);
    if (idx === -1) return false;
    data.users[idx].deletedAt = new Date().toISOString();
    writeData(data, [{ type:'user', payload: data.users[idx] }]);
    return true;
  },

  // PRODUCTS (Task 8: cached)
  getProducts() { return getCachedProducts(); },
  findProductById(id: string) { return readData().products.find((p: any) => p.id === id); },
  findProductBySlug(slug: string) { return readData().products.find((p: any) => p.slug === slug); },
  createProduct(prod: any) {
    const data = readData();
    const slug = prod.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)+/g,'');
    const newProduct = {
      id: `prod-${Date.now()}`,
      slug,
      isActive: true,
      isFeatured: false,
      images: prod.images || [],
      imagePublicIds: prod.imagePublicIds || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...prod,
    };
    data.products.push(newProduct);
    _productsCache = null;
    writeData(data, [{ type:'product', payload: newProduct }]);
    return newProduct;
  },
  updateProduct(id: string, updates: any) {
    const data = readData();
    const idx = data.products.findIndex((p: any) => p.id === id);
    if (idx === -1) return null;
    if (updates.name) updates.slug = updates.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)+/g,'');
    data.products[idx] = { ...data.products[idx], ...updates, updatedAt: new Date().toISOString() };
    _productsCache = null;
    writeData(data, [{ type:'product', payload: data.products[idx] }]);
    return data.products[idx];
  },
  deleteProduct(id: string) {
    const data = readData();
    const idx = data.products.findIndex((p: any) => p.id === id);
    if (idx === -1) return false;
    data.products[idx].isActive = false;
    _productsCache = null;
    writeData(data, [{ type:'product', payload: data.products[idx] }]);
    return true;
  },

  // CATEGORIES (Task 8: cached)
  getCategories() { return getCachedCategories(); },
  addCategory(category: string) {
    const data = readData();
    if (!data.categories.includes(category)) {
      data.categories.push(category);
      _categoriesCache = null;
      writeData(data, [{ type:'category', payload: category }]);
    }
    return data.categories;
  },

  // CARTS
  getCart(userId: string) {
    const data = readData();
    const cart = data.carts.find((c: any) => c.userId === userId);
    if (!cart) {
      const newCart = { id:`cart-${Date.now()}`, userId, items:[], updatedAt: new Date().toISOString() };
      data.carts.push(newCart);
      writeData(data, [{ type:'cart', payload: newCart }]);
      return newCart;
    }
    return cart;
  },
  saveCart(userId: string, items: any[]) {
    const data = readData();
    let cart = data.carts.find((c: any) => c.userId === userId);
    if (!cart) {
      cart = { id:`cart-${Date.now()}`, userId, items:[], updatedAt: new Date().toISOString() };
      data.carts.push(cart);
    }
    cart.items = items;
    cart.updatedAt = new Date().toISOString();
    writeData(data, [{ type:'cart', payload: cart }]);
    return cart;
  },

  // ORDERS
  getOrders() { return readData().orders; },
  getUserOrders(userId: string) { return readData().orders.filter((o: any) => o.userId === userId); },
  findOrderById(id: string) { return readData().orders.find((o: any) => o.id === id); },
  createOrder(orderData: any) {
    const data = readData();
    for (const item of orderData.items) {
      const prod = data.products.find((p: any) => p.id === item.productId);
      if (!prod) throw new Error(`Product ${item.name} not found`);
      if (prod.stock < item.qty) throw new Error(`Insufficient stock for ${item.name}. Available: ${prod.stock}`);
    }
    for (const item of orderData.items) {
      const prod = data.products.find((p: any) => p.id === item.productId);
      if (prod) { prod.stock -= item.qty; }
    }
    const dirty: { type: string; payload: any }[] = [];
    for (const item of orderData.items) {
      const prod = data.products.find((p: any) => p.id === item.productId);
      if (prod) dirty.push({ type:'product', payload: prod });
    }
    const newOrder = {
      id: orderData.id || `GDH-${Date.now().toString().slice(-6)}`,
      userId: orderData.userId,
      items: orderData.items,
      subtotal: orderData.subtotal,
      shippingCharge: orderData.shippingCharge,
      total: orderData.total,
      status: 'PENDING',
      paymentStatus: orderData.paymentStatus || 'PENDING',
      shippingAddress: orderData.shippingAddress,
      invoiceUrl: '', labelUrl: '', trackingNumber: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.orders.push(newOrder);
    dirty.push({ type:'order', payload: newOrder });
    _productsCache = null;
    writeData(data, dirty);
    return newOrder;
  },
  updateOrder(id: string, updates: any) {
    const data = readData();
    const idx = data.orders.findIndex((o: any) => o.id === id);
    if (idx === -1) return null;
    data.orders[idx] = { ...data.orders[idx], ...updates, updatedAt: new Date().toISOString() };
    writeData(data, [{ type:'order', payload: data.orders[idx] }]);
    return data.orders[idx];
  },

  // COUPONS
  getCoupons() { return readData().coupons || []; },
  findCouponByCode(code: string) {
    return (readData().coupons||[]).find((c: any) => c.code.toUpperCase() === code.toUpperCase());
  },
  createCoupon(coupon: any) {
    const data = readData();
    if (!data.coupons) data.coupons = [];
    const newCoupon = {
      id: `coupon-${Date.now()}`,
      code: coupon.code.toUpperCase(),
      type: coupon.type,
      value: parseFloat(coupon.value),
      minOrderValue: parseFloat(coupon.minOrderValue||0),
      maxUses: parseInt(coupon.maxUses||0),
      usageCount: 0,
      expiryDate: coupon.expiryDate,
      isActive: coupon.isActive !== false,
      createdAt: new Date().toISOString(),
    };
    data.coupons.push(newCoupon);
    writeData(data, [{ type:'coupon', payload: newCoupon }]);
    return newCoupon;
  },
  updateCoupon(id: string, updates: any) {
    const data = readData();
    if (!data.coupons) data.coupons = [];
    const idx = data.coupons.findIndex((c: any) => c.id === id);
    if (idx === -1) return null;
    if (updates.code) updates.code = updates.code.toUpperCase();
    if (updates.value !== undefined) updates.value = parseFloat(updates.value);
    if (updates.minOrderValue !== undefined) updates.minOrderValue = parseFloat(updates.minOrderValue);
    if (updates.maxUses !== undefined) updates.maxUses = parseInt(updates.maxUses);
    data.coupons[idx] = { ...data.coupons[idx], ...updates };
    writeData(data, [{ type:'coupon', payload: data.coupons[idx] }]);
    return data.coupons[idx];
  },
  deleteCoupon(id: string) {
    const data = readData();
    if (!data.coupons) data.coupons = [];
    const idx = data.coupons.findIndex((c: any) => c.id === id);
    if (idx === -1) return false;
    data.coupons.splice(idx, 1);
    writeData(data, [{ type:'coupon_delete', payload: id }]);
    return true;
  },

  // PAGINATION
  getPaginatedUsers(options: { cursor?: string; limit?: number; search?: string; role?: string; status?: string; authProvider?: string }) {
    const data = readData();
    const limit = options.limit || 50;
    let filtered = data.users.filter((u: any) => !u.deletedAt);
    if (options.role && options.role !== 'ALL') filtered = filtered.filter((u: any) => u.role === options.role);
    if (options.status && options.status !== 'ALL') {
      if (options.status === 'BANNED')     filtered = filtered.filter((u: any) => u.isBanned);
      else if (options.status === 'UNVERIFIED') filtered = filtered.filter((u: any) => !u.isVerified);
      else if (options.status === 'ACTIVE')     filtered = filtered.filter((u: any) => u.isVerified && !u.isBanned);
    }
    if (options.search) {
      const q = options.search.toLowerCase();
      filtered = filtered.filter((u: any) =>
        (u.name&&u.name.toLowerCase().includes(q)) ||
        (u.email&&u.email.toLowerCase().includes(q)) ||
        (u.phone&&u.phone.includes(q))
      );
    }
    let mapped = filtered.map((u: any) => {
      let provider = u.authProvider;
      if (!provider) {
        if (u.googleId && u.passwordHash) provider = 'both';
        else if (u.googleId) provider = 'google';
        else provider = 'email';
      }
      return { ...u, authProvider: provider };
    });
    if (options.authProvider && options.authProvider !== 'ALL') {
      mapped = mapped.filter((u: any) => u.authProvider.toUpperCase() === options.authProvider!.toUpperCase());
    }
    mapped.sort((a: any, b: any) => b.id.localeCompare(a.id));
    let startIndex = 0;
    if (options.cursor) {
      const idx = mapped.findIndex((u: any) => u.id === options.cursor);
      if (idx !== -1) startIndex = idx + 1;
    }
    const items = mapped.slice(startIndex, startIndex + limit);
    const nextCursor = (items.length > 0 && startIndex + limit < mapped.length) ? items[items.length-1].id : null;
    return { items, nextCursor, totalCount: mapped.length };
  },

  // ACTIVITY LOGS
  getActivityLogs(userId?: string) {
    const data = readData();
    if (!data.activity_logs) { data.activity_logs = []; writeData(data); }
    if (userId) return data.activity_logs.filter((l: any) => l.userId === userId).sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
    return data.activity_logs.sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
  },
  logActivity(userId: string|null, action: string, ip: string, userAgent: string, metadata: any = {}) {
    const data = readData();
    if (!data.activity_logs) data.activity_logs = [];
    const newLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2,9)}`,
      userId, action, ip, userAgent, metadata,
      timestamp: new Date().toISOString(),
    };
    data.activity_logs.push(newLog);
    if (data.activity_logs.length > 1000) data.activity_logs.shift();
    writeData(data, [{ type:'activity_log', payload: newLog }]);
    return newLog;
  },

  // EMAIL VERIFICATIONS
  createEmailVerification(userId: string, token: string, expiresAt: string) {
    const data = readData();
    if (!data.email_verifications) data.email_verifications = [];
    const entry = { userId, token, expiresAt, usedAt: null };
    data.email_verifications.push(entry);
    writeData(data, [{ type:'email_verification', payload: entry }]);
    return entry;
  },
  getEmailVerification(token: string) {
    const data = readData();
    if (!data.email_verifications) return null;
    return data.email_verifications.find((ev: any) => ev.token === token);
  },
  useEmailVerification(token: string) {
    const data = readData();
    if (!data.email_verifications) return false;
    const ev = data.email_verifications.find((x: any) => x.token === token);
    if (!ev) return false;
    ev.usedAt = new Date().toISOString();
    const user = data.users.find((u: any) => u.id === ev.userId);
    if (user) { user.isVerified = true; }
    writeData(data, [{ type:'email_verification', payload: ev }, ...(user ? [{ type:'user', payload: user }] : [])]);
    return true;
  },

  // PASSWORD RESETS
  createPasswordReset(userId: string, token: string, expiresAt: string) {
    const data = readData();
    if (!data.password_resets) data.password_resets = [];
    const entry = { userId, token, expiresAt, usedAt: null };
    data.password_resets.push(entry);
    writeData(data, [{ type:'password_reset', payload: entry }]);
    return entry;
  },
  getPasswordReset(token: string) {
    const data = readData();
    if (!data.password_resets) return null;
    return data.password_resets.find((pr: any) => pr.token === token);
  },
  usePasswordReset(token: string, newPasswordHash: string) {
    const data = readData();
    if (!data.password_resets) return false;
    const pr = data.password_resets.find((x: any) => x.token === token);
    if (!pr) return false;
    pr.usedAt = new Date().toISOString();
    const user = data.users.find((u: any) => u.id === pr.userId);
    if (user) {
      if (!user.passwordHistory) user.passwordHistory = [];
      user.passwordHistory.push(user.passwordHash);
      if (user.passwordHistory.length > 3) user.passwordHistory.shift();
      user.passwordHash = newPasswordHash;
    }
    writeData(data, [
      { type:'password_reset', payload: pr },
      ...(user ? [{ type:'user', payload: user }] : []),
    ]);
    return true;
  },

  recordPasswordHistory(userId: string, oldPasswordHash: string) {
    const data = readData();
    const user = data.users.find((u: any) => u.id === userId);
    if (user) {
      if (!user.passwordHistory) user.passwordHistory = [];
      user.passwordHistory.push(oldPasswordHash);
      if (user.passwordHistory.length > 3) user.passwordHistory.shift();
      writeData(data, [{ type:'user', payload: user }]);
    }
  },
};
