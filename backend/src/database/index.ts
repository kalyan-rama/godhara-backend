import fs from 'fs';
import path from 'path';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/godhara';

console.log("[PostgreSQL] Initializing pool with database connection string...");

export const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1') ? false : { rejectUnauthorized: false }
});

// Cache holding the dynamic database state in memory for blazing fast, 100% synchronous compatibility with Express routes
let cache: any = null;

// Connection validation flag defining if we should use PostgreSQL or local JSON file storage as a fallback
export let isPostgresConnected = false;

// Ensure tables exist in PostgreSQL
export async function ensureSchema() {
  if (!isPostgresConnected) return;
  let client;
  try {
    client = await pool.connect();
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

      -- Performance indexes
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
      CREATE INDEX IF NOT EXISTS idx_orders_userid ON orders("userId");
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

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

      -- OTP authentication logs table
      CREATE TABLE IF NOT EXISTS otp_logs (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        action TEXT NOT NULL,
        ip TEXT,
        success BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_otp_logs_email ON otp_logs(email);
    `);
    // Add imagePublicIds column if missing (migration for existing DBs)
    await client.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS "imagePublicIds" JSONB DEFAULT '[]'::jsonb;
    `).catch(() => {});

    // Fix: Add delivery charge columns to settings if missing on existing databases.
    // These columns were added in a schema update; existing DBs may not have them.
    await client.query(`
      ALTER TABLE settings ADD COLUMN IF NOT EXISTS "deliveryChargeTelangana" NUMERIC DEFAULT 70;
    `).catch(() => {});
    await client.query(`
      ALTER TABLE settings ADD COLUMN IF NOT EXISTS "deliveryChargeAP" NUMERIC DEFAULT 80;
    `).catch(() => {});
    await client.query(`
      ALTER TABLE settings ADD COLUMN IF NOT EXISTS "deliveryChargeOther" NUMERIC DEFAULT 100;
    `).catch(() => {});
    await client.query(`
      ALTER TABLE settings ADD COLUMN IF NOT EXISTS "freeDeliveryPincodes" TEXT DEFAULT '[]';
    `).catch(() => {});
    await client.query(`
      ALTER TABLE settings ADD COLUMN IF NOT EXISTS "storeLocations" TEXT DEFAULT '[]';
    `).catch(() => {});
    await client.query(`
      ALTER TABLE settings ADD COLUMN IF NOT EXISTS "storeServicePincodes" TEXT DEFAULT '[]';
    `).catch(() => {});

    console.log("[PostgreSQL] Schema verification successful");
  } catch (err) {
    console.error("[PostgreSQL] Error ensuring table schemas:", err);
  } finally {
    if (client) client.release();
  }
}

// Map prices from numeric strings to standard floats
function parseNumericFields(row: any) {
  if (!row) return row;
  const numericFields = [
    'price', 'discountPrice', 'subtotal', 'shippingCharge', 'total', 
    'value', 'minOrderValue', 'freeShippingThreshold', 'flatShippingCharge'
  ];
  for (const field of numericFields) {
    if (row[field] !== undefined && row[field] !== null) {
      row[field] = parseFloat(row[field]);
    }
  }
  return row;
}

// Convert DB dates to pure ISO format
function parseDateFields(row: any) {
  if (!row) return row;
  const dateFields = ['createdAt', 'updatedAt', 'timestamp', 'expiresAt', 'usedAt', 'deletedAt', 'lockUntil'];
  for (const field of dateFields) {
    if (row[field] instanceof Date) {
      row[field] = row[field].toISOString();
    }
  }
  return row;
}

// Load entire PostgreSQL database state into in-memory cache
export async function loadFromPostgres() {
  const data: any = {
    users: [],
    products: [],
    orders: [],
    carts: [],
    categories: [],
    coupons: [],
    settings: {},
    activity_logs: [],
    email_verifications: [],
    password_resets: []
  };

  if (!isPostgresConnected) return data;

  let client;
  try {
    client = await pool.connect();
    const resCategories = await client.query('SELECT * FROM categories');
    data.categories = resCategories.rows.map(r => r.name);

    const resSettings = await client.query('SELECT * FROM settings WHERE id = $1', ['global']);
    if (resSettings.rows.length > 0) {
      const s = parseNumericFields(resSettings.rows[0]);
      // Parse JSON string fields back to arrays
      if (typeof s.freeDeliveryPincodes === 'string') {
        try { s.freeDeliveryPincodes = JSON.parse(s.freeDeliveryPincodes); } catch { s.freeDeliveryPincodes = []; }
      }
      if (typeof s.storeLocations === 'string') {
        try { s.storeLocations = JSON.parse(s.storeLocations); } catch { s.storeLocations = []; }
      }
      if (typeof s.storeServicePincodes === 'string') {
        try { s.storeServicePincodes = JSON.parse(s.storeServicePincodes); } catch { s.storeServicePincodes = []; }
      }
      data.settings = s;
    } else {
      data.settings = {
        storeName: 'Godhara',
        logoUrl: '/assets/logo.png',
        founderImageUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=600',
        founderName: 'Kalyan V., Founder of Godhara',
        founderQuote: 'Godhara was founded with a simple yet powerful vision — to bring back the purity, wisdom, and sustainability of our Indian traditions. Inspired by our cultural roots and deep respect for nature, we work closely with local artisans and Gaushalas to create natural, eco-friendly products made using time-honored practices.',
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
        storeServicePincodes: []
      };
    }

    const resUsers = await client.query('SELECT * FROM users');
    data.users = resUsers.rows.map(r => parseDateFields(r));

    const resProducts = await client.query('SELECT * FROM products');
    data.products = resProducts.rows.map(r => parseDateFields(parseNumericFields(r)));

    const resOrders = await client.query('SELECT * FROM orders');
    data.orders = resOrders.rows.map(r => parseDateFields(parseNumericFields(r)));

    const resCarts = await client.query('SELECT * FROM carts');
    data.carts = resCarts.rows.map(r => parseDateFields(r));

    const resCoupons = await client.query('SELECT * FROM coupons');
    data.coupons = resCoupons.rows.map(r => parseDateFields(parseNumericFields(r)));

    const resActivity = await client.query('SELECT * FROM activity_logs');
    data.activity_logs = resActivity.rows.map(r => parseDateFields(r));

    const resEV = await client.query('SELECT * FROM email_verifications');
    data.email_verifications = resEV.rows.map(r => parseDateFields(r));

    const resPR = await client.query('SELECT * FROM password_resets');
    data.password_resets = resPR.rows.map(r => parseDateFields(r));

  } catch (err) {
    console.error("[PostgreSQL] Error loading database rows:", err);
  } finally {
    if (client) client.release();
  }
  return data;
}

// Bulk flush/sync in-memory state to PostgreSQL relational tables
export async function flushToPostgres(data: any) {
  if (!isPostgresConnected) return;
  let client;
  try {
    client = await pool.connect();
    
    // 1. Categories
    try {
      if (data.categories) {
        for (const cat of data.categories) {
          await client.query(
            `INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
            [cat]
          );
        }
        console.log(`[Database Sync] Synchronized ${data.categories.length} categories.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing categories table:', e.message);
    }

    // 2. Settings
    try {
      if (data.settings) {
        await client.query(
          `INSERT INTO settings (
            id, "storeName", "logoUrl", "founderImageUrl", "founderName", "founderQuote", 
            "contactEmail", address, phone, "freeShippingThreshold", "flatShippingCharge", 
            "announcementText", "lowStockThreshold",
            "deliveryChargeTelangana", "deliveryChargeAP", "deliveryChargeOther",
            "freeDeliveryPincodes", "storeLocations", "storeServicePincodes"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          ON CONFLICT (id) DO UPDATE SET
            "storeName" = EXCLUDED."storeName",
            "logoUrl" = EXCLUDED."logoUrl",
            "founderImageUrl" = EXCLUDED."founderImageUrl",
            "founderName" = EXCLUDED."founderName",
            "founderQuote" = EXCLUDED."founderQuote",
            "contactEmail" = EXCLUDED."contactEmail",
            address = EXCLUDED.address,
            phone = EXCLUDED.phone,
            "freeShippingThreshold" = EXCLUDED."freeShippingThreshold",
            "flatShippingCharge" = EXCLUDED."flatShippingCharge",
            "announcementText" = EXCLUDED."announcementText",
            "lowStockThreshold" = EXCLUDED."lowStockThreshold",
            "deliveryChargeTelangana" = EXCLUDED."deliveryChargeTelangana",
            "deliveryChargeAP" = EXCLUDED."deliveryChargeAP",
            "deliveryChargeOther" = EXCLUDED."deliveryChargeOther",
            "freeDeliveryPincodes" = EXCLUDED."freeDeliveryPincodes",
            "storeLocations" = EXCLUDED."storeLocations",
            "storeServicePincodes" = EXCLUDED."storeServicePincodes"`,
          [
            'global',
            data.settings.storeName,
            data.settings.logoUrl,
            data.settings.founderImageUrl,
            data.settings.founderName,
            data.settings.founderQuote,
            data.settings.contactEmail,
            data.settings.address,
            data.settings.phone,
            data.settings.freeShippingThreshold,
            data.settings.flatShippingCharge,
            data.settings.announcementText,
            data.settings.lowStockThreshold,
            data.settings.deliveryChargeTelangana ?? 70,
            data.settings.deliveryChargeAP ?? 80,
            data.settings.deliveryChargeOther ?? 100,
            JSON.stringify(data.settings.freeDeliveryPincodes ?? []),
            JSON.stringify(data.settings.storeLocations ?? []),
            JSON.stringify(data.settings.storeServicePincodes ?? [])
          ]
        );
        console.log('[Database Sync] Synchronized settings.');
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing settings table:', e.message);
    }

    // 3. Users
    try {
      if (data.users) {
        for (const u of data.users) {
          await client.query(
            `INSERT INTO users (
              id, name, email, "passwordHash", role, phone, address, "createdAt", "updatedAt",
              "googleId", "googleAvatar", "authProvider", "isVerified", "isBanned", "deletedAt", "passwordHistory",
              "failedLoginAttempts", "lockUntil"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              email = EXCLUDED.email,
              "passwordHash" = EXCLUDED."passwordHash",
              role = EXCLUDED.role,
              phone = EXCLUDED.phone,
              address = EXCLUDED.address,
              "updatedAt" = EXCLUDED."updatedAt",
              "googleId" = EXCLUDED."googleId",
              "googleAvatar" = EXCLUDED."googleAvatar",
              "authProvider" = EXCLUDED."authProvider",
              "isVerified" = EXCLUDED."isVerified",
              "isBanned" = EXCLUDED."isBanned",
              "deletedAt" = EXCLUDED."deletedAt",
              "passwordHistory" = EXCLUDED."passwordHistory",
              "failedLoginAttempts" = EXCLUDED."failedLoginAttempts",
              "lockUntil" = EXCLUDED."lockUntil"`,
            [
              u.id, u.name, u.email, u.passwordHash || null, u.role, u.phone || '',
              JSON.stringify(u.address || {}), u.createdAt, u.updatedAt,
              u.googleId || null, u.googleAvatar || null, u.authProvider || null,
              !!u.isVerified, !!u.isBanned, u.deletedAt || null,
              JSON.stringify(u.passwordHistory || []), u.failedLoginAttempts || 0, u.lockUntil || null
            ]
          );
        }
        console.log(`[Database Sync] Synchronized ${data.users.length} users successfully.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing users table:', e.message);
    }

    // 4. Products
    try {
      if (data.products) {
        let insertCount = 0;
        let updateCount = 0;
        for (const p of data.products) {
          const res = await client.query(
            `INSERT INTO products (
              id, name, slug, description, price, "discountPrice", stock, category, images,
              "imagePublicIds", "isFeatured", "isActive", weight, "createdAt", "updatedAt"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              slug = EXCLUDED.slug,
              description = EXCLUDED.description,
              price = EXCLUDED.price,
              "discountPrice" = EXCLUDED."discountPrice",
              stock = EXCLUDED.stock,
              category = EXCLUDED.category,
              images = EXCLUDED.images,
              "imagePublicIds" = EXCLUDED."imagePublicIds",
              "isFeatured" = EXCLUDED."isFeatured",
              "isActive" = EXCLUDED."isActive",
              weight = EXCLUDED.weight,
              "updatedAt" = EXCLUDED."updatedAt"
            RETURNING (xmax = 0) AS is_insert`,
           [
  p.id,
  p.name,
  p.slug,
  p.description || '',
  p.price,
  p.discountPrice,
  p.stock || 0,
  p.category,
  JSON.stringify(p.images || []),
  JSON.stringify(p.imagePublicIds || []),
  Boolean(p.isFeatured),
  Boolean(p.isActive),
  p.weight,
  p.createdAt,
  p.updatedAt
]
          );
          if (res.rows && res.rows[0] && res.rows[0].is_insert) {
            insertCount++;
          } else {
            updateCount++;
          }
        }
        console.log(`[Database Sync] Synchronized products: ${insertCount} created/inserted, ${updateCount} updated.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing products table:', e.message);
    }

    // 5. Orders
    try {
      if (data.orders) {
        for (const o of data.orders) {
          await client.query(
            `INSERT INTO orders (
              id, "userId", items, subtotal, "shippingCharge", total, status, "paymentStatus",
              "shippingAddress", "invoiceUrl", "labelUrl", "trackingNumber", "createdAt", "updatedAt"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (id) DO UPDATE SET
              status = EXCLUDED.status,
              "paymentStatus" = EXCLUDED."paymentStatus",
              "invoiceUrl" = EXCLUDED."invoiceUrl",
              "labelUrl" = EXCLUDED."labelUrl",
              "trackingNumber" = EXCLUDED."trackingNumber",
              "updatedAt" = EXCLUDED."updatedAt"`,
            [
              o.id, o.userId, JSON.stringify(o.items || []), o.subtotal, o.shippingCharge, o.total,
              o.status, o.paymentStatus, JSON.stringify(o.shippingAddress || {}),
              o.invoiceUrl || '', o.labelUrl || '', o.trackingNumber || '',
              o.createdAt, o.updatedAt
            ]
          );
        }
        console.log(`[Database Sync] Synchronized ${data.orders.length} orders successfully.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing orders table:', e.message);
    }

    // 6. Carts
    try {
      if (data.carts) {
        for (const c of data.carts) {
          await client.query(
            `INSERT INTO carts (id, "userId", items, "updatedAt")
            VALUES ($1, $2, $3, $4)
            ON CONFLICT ("userId") DO UPDATE SET
              items = EXCLUDED.items,
              "updatedAt" = EXCLUDED."updatedAt"`,
            [c.id, c.userId, JSON.stringify(c.items || []), c.updatedAt]
          );
        }
        console.log(`[Database Sync] Synchronized ${data.carts.length} carts successfully.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing carts table:', e.message);
    }

    // 7. Coupons
    try {
      if (data.coupons) {
        const currentIds = data.coupons.map((c: any) => c.id);
        if (currentIds.length > 0) {
          await client.query(`DELETE FROM coupons WHERE id NOT IN (${currentIds.map((_: any, i: number) => `$${i + 1}`).join(',')})`, currentIds);
        } else {
          await client.query('DELETE FROM coupons');
        }

        for (const c of data.coupons) {
          await client.query(
            `INSERT INTO coupons (
              id, code, type, value, "minOrderValue", "maxUses", "usageCount", "expiryDate", "isActive", "createdAt"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
              code = EXCLUDED.code,
              type = EXCLUDED.type,
              value = EXCLUDED.value,
              "minOrderValue" = EXCLUDED."minOrderValue",
              "maxUses" = EXCLUDED."maxUses",
              "usageCount" = EXCLUDED."usageCount",
              "expiryDate" = EXCLUDED."expiryDate",
              "isActive" = EXCLUDED."isActive"`,
            [
              c.id, c.code, c.type, c.value, c.minOrderValue, c.maxUses, c.usageCount,
              c.expiryDate, !!c.isActive, c.createdAt
            ]
          );
        }
        console.log(`[Database Sync] Synchronized ${data.coupons.length} coupons successfully.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing coupons table:', e.message);
    }

    // 8. Activity Logs
    try {
      if (data.activity_logs) {
        for (const log of data.activity_logs) {
          await client.query(
            `INSERT INTO activity_logs (id, "userId", action, ip, "userAgent", metadata, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO NOTHING`,
            [
              log.id, log.userId, log.action, log.ip, log.userAgent,
              JSON.stringify(log.metadata || {}), log.timestamp
            ]
          );
        }
        console.log(`[Database Sync] Synchronized ${data.activity_logs.length} activity logs.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing activity logs table:', e.message);
    }

    // 9. Email Verifications
    try {
      if (data.email_verifications) {
        for (const ev of data.email_verifications) {
          await client.query(
            `INSERT INTO email_verifications ("userId", token, "expiresAt", "usedAt")
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (token) DO UPDATE SET
              "usedAt" = EXCLUDED."usedAt"`,
            [ev.userId, ev.token, ev.expiresAt, ev.usedAt]
          );
        }
        console.log(`[Database Sync] Synchronized email verifications.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing email verifications table:', e.message);
    }

    // 10. Password Resets
    try {
      if (data.password_resets) {
        for (const pr of data.password_resets) {
          await client.query(
            `INSERT INTO password_resets ("userId", token, "expiresAt", "usedAt")
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (token) DO UPDATE SET
              "usedAt" = EXCLUDED."usedAt"`,
            [pr.userId, pr.token, pr.expiresAt, pr.usedAt]
          );
        }
        console.log(`[Database Sync] Synchronized password resets.`);
      }
    } catch (e: any) {
      console.error('[Database Sync Error] Failed syncing password resets table:', e.message);
    }

  } catch (err: any) {
    console.error("[PostgreSQL] Error during connection or synchronization block:", err.message || err);
    throw err;
  } finally {
    if (client) client.release();
  }
}

// Global initialization sequence on start
async function startupInit() {
  const dbJsonPath = path.join(process.cwd(), 'data', 'db.json');

  if (!process.env.DATABASE_URL) {
    isPostgresConnected = false;
    console.log("[Database] Using high-performance JSON database fallback to guarantee 100% server uptime and zero startup crashing.");
  } else {
    console.log("[Database] Probe testing PostgreSQL connection at:", connectionString.replace(/:[^:@/]+@/, ':***@'));
    try {
      const testPool = new pg.Pool({
        connectionString,
        ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 4000
      });
      const testClient = await testPool.connect();
      await testClient.query('SELECT 1');
      testClient.release();
      await testPool.end();
      isPostgresConnected = true;
      console.log("[PostgreSQL] Live PostgreSQL connection established successfully.");
    } catch (err: any) {
      isPostgresConnected = false;
      console.log("[Database] Remote database probe returned offline. Operating gracefully with high-uptime local JSON file storage fallback.");
    }
  }

  if (isPostgresConnected) {
    await ensureSchema();
    
    // Try to load any existing users to check if database is empty
    let mustMigrate = false;
    let client;
    try {
      client = await pool.connect();
      const res = await client.query('SELECT COUNT(*) FROM users');
      mustMigrate = parseInt(res.rows[0].count) === 0;
    } catch (e) {
      mustMigrate = true;
    } finally {
      if (client) client.release();
    }

    if (mustMigrate) {
      console.log("[PostgreSQL] Tables are empty. Check if a local db.json exists to migrate...");
      if (fs.existsSync(dbJsonPath)) {
        try {
          const raw = fs.readFileSync(dbJsonPath, 'utf8');
          const legacyData = JSON.parse(raw);
          await flushToPostgres(legacyData);
          console.log("[PostgreSQL] Successfully imported existing data from db.json into PostgreSQL!");
        } catch (err) {
          console.error("[PostgreSQL] Failed migrating local db.json data:", err);
        }
      } else {
        console.log("[PostgreSQL] No db.json found. Creating default seed stores...");
        const defaultData = {
          users: [
            {
              id: 'admin-1',
              name: 'Godhara Admin',
              email: 'godhara.2026@gmail.com',
              passwordHash: '$2b$10$HLXZBH8Est4SUosKQiX1/uEZPuhj/hiZ4bFkZdgu7ZPPI.Z7E2h4W', // hashed "admin123"
              role: 'ADMIN',
              phone: '+91 8978038932',
              address: {
                street: 'Pocharam Apartment',
                city: 'Banswada',
                state: 'Telangana',
                pincode: '503187'
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'customer-1',
              name: 'Vedic Seeker',
              email: 'seeker@vedic.com',
              passwordHash: '$2b$10$HLXZBH8Est4SUosKQiX1/uEZPuhj/hiZ4bFkZdgu7ZPPI.Z7E2h4W', // hashed "admin123"
              role: 'CUSTOMER',
              phone: '+91 9999999999',
              address: {
                street: '108 Temple Street',
                city: 'Hyderabad',
                state: 'Telangana',
                pincode: '500001'
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ],
          products: [
            {
              id: 'prod-1',
              name: 'Godhara Pure Desi Gir Cow A2 Ghee (Bilona)',
              slug: 'godhara-pure-desi-gir-cow-a2-ghee-bilona',
              description: 'Made using the sacred ancient Vedic Bilona method from hand-churned curd. Rooted in traditional Indian cow worship (Gau Seva), this golden nectar offers unparalleled taste, brain nutrition, and overall health benefit.',
              price: 1200,
              discountPrice: 1050,
              stock: 45,
              category: 'Dairy Products',
              images: ['https://images.unsplash.com/photo-1589927986089-35812388d1f4?auto=format&fit=crop&q=80&w=600'],
              isFeatured: true,
              isActive: true,
              weight: 500,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-2',
              name: 'Ganga Jal Ayurvedic Panchagavya Soap',
              slug: 'ganga-jal-ayurvedic-panchagavya-soap',
              description: 'A traditional skincare bar loaded with five sacred cow offerings: Ghee, Milk, Curd, Gomay (dung), and Ark (distilled urine), blended with authentic Ganga Jal, neem oil, and organic tulsi extracts.',
              price: 180,
              discountPrice: 145,
              stock: 120,
              category: 'Personal Care',
              images: ['https://images.unsplash.com/photo-1607006342411-9a336340f1a9?auto=format&fit=crop&q=80&w=600'],
              isFeatured: true,
              isActive: true,
              weight: 125,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-3',
              name: 'Pure Bhimseni Camphor crystals (Kafur)',
              slug: 'pure-bhimseni-camphor-crystals-kafur',
              description: '100% pure organic camphor crystals for pujas, spiritual energy clearing, and respiratory relief. Burning Godhara Bhimseni camphor fills your space with divine positive vibrations and repels insects naturally.',
              price: 320,
              discountPrice: 280,
              stock: 8,
              category: 'Spiritual',
              images: ['https://images.unsplash.com/photo-1628135015378-2fe27017701e?auto=format&fit=crop&q=80&w=600'],
              isFeatured: true,
              isActive: true,
              weight: 100,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-4',
              name: 'Godhara Organic Agnihotra Dhoop Cups',
              slug: 'godhara-organic-agnihotra-dhoop-cups',
              description: 'Earthy cups handmade from pure desi cow dung and powdered charcoal, filled with highly curated havan samagri, premium loban dhoop, and pure guggul. Just light the rim to start your morning wellness ritual.',
              price: 350,
              discountPrice: 299,
              stock: 35,
              category: 'Spiritual',
              images: ['https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&q=80&w=600'],
              isFeatured: true,
              isActive: true,
              weight: 250,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-5',
              name: 'Godhara Gomutra Ark (Double Distilled)',
              slug: 'godhara-gomutra-ark-double-distilled',
              description: 'Highly concentrated medicinal cow urine distilled with pristine herbs. Gomutra is a cornerstone of classical Ayurvedic medicine and Panchagavya therapy, supporting detoxification and liver health.',
              price: 250,
              discountPrice: 210,
              stock: 65,
              category: 'Ayurvedic Remedies',
              images: ['https://images.unsplash.com/photo-1540340061722-9293d5163008?auto=format&fit=crop&q=80&w=600'],
              isFeatured: false,
              isActive: true,
              weight: 500,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-6',
              name: 'Desi Cow Dung Havan Wood Cakes (Gobar Opala)',
              slug: 'desi-cow-dung-havan-wood-cakes-gobar-opala',
              description: 'Perfect circular sun-dried desi cow dung cakes, handcrafted at Gaushalas for authentic spiritual fire altars, havans, and environment purification. Releases sweet herbal smoke when lit.',
              price: 150,
              discountPrice: 120,
              stock: 300,
              category: 'Spiritual',
              images: ['https://images.unsplash.com/photo-1601004890684-d8cbf643f5f2?auto=format&fit=crop&q=80&w=600'],
              isFeatured: false,
              isActive: true,
              weight: 1000,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ],
          orders: [],
          carts: [],
          categories: ['Dairy Products', 'Personal Care', 'Spiritual', 'Ayurvedic Remedies'],
          coupons: [
            {
              id: 'coupon-1',
              code: 'GODHARA10',
              type: 'PERCENTAGE',
              value: 10,
              minOrderValue: 500,
              maxUses: 100,
              usageCount: 0,
              expiryDate: '2027-12-31',
              isActive: true,
              createdAt: new Date().toISOString()
            }
          ],
          settings: {
            storeName: 'Godhara',
            logoUrl: '/assets/logo.png',
            founderImageUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=600',
            founderName: 'Kalyan V., Founder of Godhara',
            founderQuote: 'Godhara was founded with a simple yet powerful vision — to bring back the purity, wisdom, and sustainability of our Indian traditions. Inspired by our cultural roots and deep respect for nature, we work closely with local artisans and Gaushalas to create natural, eco-friendly products made using time-honored practices.',
            contactEmail: 'godhara.2026@gmail.com',
            address: 'Pocharam Apartment, Banswada, Telangana 503187',
            phone: '+91 8978038932',
            freeShippingThreshold: 1000,
            flatShippingCharge: 50,
            announcementText: 'Shop ₹1000 to Get Free Shipping',
            lowStockThreshold: 10
          }
        };
        try {
          await flushToPostgres(defaultData);
          console.log("[PostgreSQL] Saved seeded data rows to PostgreSQL.");
        } catch (err) {
          console.error("[PostgreSQL] Failed seeding default tables:", err);
        }
      }
    }

    cache = await loadFromPostgres();
    console.log("[PostgreSQL] Data elements cached. Initial loading ready!");
  } else {
    // Graceful Fallback: read directly from data/db.json
    console.log("[Database_Fallback] Loading local JSON file data/db.json...");
    try {
      const dirOfJson = path.dirname(dbJsonPath);
      if (!fs.existsSync(dirOfJson)) {
        fs.mkdirSync(dirOfJson, { recursive: true });
      }

      const createSeed = () => {
        const defaultData = {
          users: [
            {
              id: 'admin-1',
              name: 'Godhara Admin',
              email: 'godhara.2026@gmail.com',
              passwordHash: '$2b$10$HLXZBH8Est4SUosKQiX1/uEZPuhj/hiZ4bFkZdgu7ZPPI.Z7E2h4W', // hashed "admin123"
              role: 'ADMIN',
              phone: '+91 8978038932',
              address: {
                street: 'Pocharam Apartment',
                city: 'Banswada',
                state: 'Telangana',
                pincode: '503187'
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'customer-1',
              name: 'Vedic Seeker',
              email: 'seeker@vedic.com',
              passwordHash: '$2b$10$HLXZBH8Est4SUosKQiX1/uEZPuhj/hiZ4bFkZdgu7ZPPI.Z7E2h4W', // hashed "admin123"
              role: 'CUSTOMER',
              phone: '+91 9999999999',
              address: {
                street: '108 Temple Street',
                city: 'Hyderabad',
                state: 'Telangana',
                pincode: '500001'
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ],
          products: [
            {
              id: 'prod-1',
              name: 'Godhara Pure Desi Gir Cow A2 Ghee (Bilona)',
              slug: 'godhara-pure-desi-gir-cow-a2-ghee-bilona',
              description: 'Made using the sacred ancient Vedic Bilona method from hand-churned curd. Rooted in traditional Indian cow worship (Gau Seva), this golden nectar offers unparalleled taste, brain nutrition, and overall health benefit.',
              price: 1200,
              discountPrice: 1050,
              stock: 45,
              category: 'Dairy Products',
              images: ['https://images.unsplash.com/photo-1589927986089-35812388d1f4?auto=format&fit=crop&q=80&w=600'],
              isFeatured: true,
              isActive: true,
              weight: 500,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-2',
              name: 'Ganga Jal Ayurvedic Panchagavya Soap',
              slug: 'ganga-jal-ayurvedic-panchagavya-soap',
              description: 'A traditional skincare bar loaded with five sacred cow offerings: Ghee, Milk, Curd, Gomay (dung), and Ark (distilled urine), blended with authentic Ganga Jal, neem oil, and organic tulsi extracts.',
              price: 180,
              discountPrice: 145,
              stock: 120,
              category: 'Personal Care',
              images: ['https://images.unsplash.com/photo-1607006342411-9a336340f1a9?auto=format&fit=crop&q=80&w=600'],
              isFeatured: true,
              isActive: true,
              weight: 125,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-3',
              name: 'Pure Bhimseni Camphor crystals (Kafur)',
              slug: 'pure-bhimseni-camphor-crystals-kafur',
              description: '100% pure organic camphor crystals for pujas, spiritual energy clearing, and respiratory relief. Burning Godhara Bhimseni camphor fills your space with divine positive vibrations and repels insects naturally.',
              price: 320,
              discountPrice: 280,
              stock: 8,
              category: 'Spiritual',
              images: ['https://images.unsplash.com/photo-1628135015378-2fe27017701e?auto=format&fit=crop&q=80&w=600'],
              isFeatured: true,
              isActive: true,
              weight: 100,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-4',
              name: 'Godhara Organic Agnihotra Dhoop Cups',
              slug: 'godhara-organic-agnihotra-dhoop-cups',
              description: 'Earthy cups handmade from pure desi cow dung and powdered charcoal, filled with highly curated havan samagri, premium loban dhoop, and pure guggul. Just light the rim to start your morning wellness ritual.',
              price: 350,
              discountPrice: 299,
              stock: 35,
              category: 'Spiritual',
              images: ['https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&q=80&w=600'],
              isFeatured: true,
              isActive: true,
              weight: 250,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-5',
              name: 'Godhara Gomutra Ark (Double Distilled)',
              slug: 'godhara-gomutra-ark-double-distilled',
              description: 'Highly concentrated medicinal cow urine distilled with pristine herbs. Gomutra is a cornerstone of classical Ayurvedic medicine and Panchagavya therapy, supporting detoxification and liver health.',
              price: 250,
              discountPrice: 210,
              stock: 65,
              category: 'Ayurvedic Remedies',
              images: ['https://images.unsplash.com/photo-1540340061722-9293d5163008?auto=format&fit=crop&q=80&w=600'],
              isFeatured: false,
              isActive: true,
              weight: 500,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            },
            {
              id: 'prod-6',
              name: 'Desi Cow Dung Havan Wood Cakes (Gobar Opala)',
              slug: 'desi-cow-dung-havan-wood-cakes-gobar-opala',
              description: 'Perfect circular sun-dried desi cow dung cakes, handcrafted at Gaushalas for authentic spiritual fire altars, havans, and environment purification. Releases sweet herbal smoke when lit.',
              price: 150,
              discountPrice: 120,
              stock: 300,
              category: 'Spiritual',
              images: ['https://images.unsplash.com/photo-1601004890684-d8cbf643f5f2?auto=format&fit=crop&q=80&w=600'],
              isFeatured: false,
              isActive: true,
              weight: 1000,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ],
          orders: [],
          carts: [],
          categories: ['Dairy Products', 'Personal Care', 'Spiritual', 'Ayurvedic Remedies'],
          coupons: [
            {
              id: 'coupon-1',
              code: 'GODHARA10',
              type: 'PERCENTAGE',
              value: 10,
              minOrderValue: 500,
              maxUses: 100,
              usageCount: 0,
              expiryDate: '2027-12-31',
              isActive: true,
              createdAt: new Date().toISOString()
            }
          ],
          settings: {
            storeName: 'Godhara',
            logoUrl: '/assets/logo.png',
            founderImageUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=600',
            founderName: 'Kalyan V., Founder of Godhara',
            founderQuote: 'Godhara was founded with a simple yet powerful vision — to bring back the purity, wisdom, and sustainability of our Indian traditions. Inspired by our cultural roots and deep respect for nature, we work closely with local artisans and Gaushalas to create natural, eco-friendly products made using time-honored practices.',
            contactEmail: 'godhara.2026@gmail.com',
            address: 'Pocharam Apartment, Banswada, Telangana 503187',
            phone: '+91 8978038932',
            freeShippingThreshold: 1000,
            flatShippingCharge: 50,
            announcementText: 'Shop ₹1000 to Get Free Shipping',
            lowStockThreshold: 10
          }
        };
        fs.writeFileSync(dbJsonPath, JSON.stringify(defaultData, null, 2), 'utf8');
        return defaultData;
      };

      if (fs.existsSync(dbJsonPath)) {
        const raw = fs.readFileSync(dbJsonPath, 'utf8');
        cache = JSON.parse(raw);
        if (!cache || !cache.users || cache.users.length === 0) {
          cache = createSeed();
        }
      } else {
        cache = createSeed();
      }
      console.log("[Database_Fallback] Dynamic cache initialized with local fallback database.");
    } catch (fsErr) {
      console.error("[Database_Fallback] Error during file reading/writing sequence:", fsErr);
      cache = { users: [], products: [], orders: [], carts: [], coupons: [], categories: [], settings: {} };
    }
  }
}

// Export a background database initialization promise to comply with standard ES/CommonJS bundling modules without top-level block limits
export const dbInitializationPromise = startupInit();

// ============================================================
// PERFORMANCE FIX: writeData is fully fire-and-forget.
// The in-memory cache is updated synchronously and immediately.
// The PostgreSQL flush runs in the background and NEVER blocks
// the HTTP response. This eliminates the 25+ second OTP delay.
// ============================================================

export async function reloadCache() {
  if (isPostgresConnected) {
    try {
      cache = await loadFromPostgres();
    } catch (err) {
      console.error("[PostgreSQL] Error during reloadCache query:", err);
    }
  }
}

// Local JSON Replacement Loader & Writer (Reads/Writes directly to PostgreSQL backend)
function readData() {
  if (!cache) {
    return { users: [], products: [], orders: [], carts: [], categories: [], coupons: [], settings: {} };
  }
  return cache;
}

function writeData(data: any) {
  // Update in-memory cache synchronously — instant, zero I/O cost
  cache = data;

  if (isPostgresConnected) {
    // Fire-and-forget: flush to PostgreSQL in the background.
    // HTTP response is returned immediately; the cache is already updated
    // so all subsequent reads see the new state without waiting for DB sync.
    flushToPostgres(data).catch((err) => {
      console.error("[PostgreSQL] Background flush failed:", err);
    });
  } else {
    // Flush to local JSON fallback database
    const dbJsonPath = path.join(process.cwd(), 'data', 'db.json');
    try {
      fs.writeFileSync(dbJsonPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error("[Database_Fallback] Failed syncing cache update to data/db.json:", err);
    }
  }
}

export const dbObj = {
  // Config / Admin settings
  getSettings() {
    return readData().settings;
  },
  updateSettings(newSettings: any) {
    const data = readData();
    data.settings = { ...data.settings, ...newSettings };
    writeData(data);
    return data.settings;
  },

  // USERS
  getUsers() {
    return readData().users;
  },
  findUserByEmail(email: string) {
    return readData().users.find((u: any) => u.email.toLowerCase() === email.toLowerCase());
  },
  findUserById(id: string) {
    return readData().users.find((u: any) => u.id === id);
  },
  createUser(user: any) {
    const data = readData();
    const newUser = {
      id: `usr-${Date.now()}`,
      role: 'CUSTOMER',
      address: { street: '', city: '', state: '', pincode: '' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...user
    };
    data.users.push(newUser);
    writeData(data);
    return newUser;
  },

  // PRODUCTS
  getProducts() {
    return readData().products;
  },
  findProductById(id: string) {
    return readData().products.find((p: any) => p.id === id);
  },
  findProductBySlug(slug: string) {
    return readData().products.find((p: any) => p.slug === slug);
  },
  createProduct(prod: any) {
    const data = readData();
    const slug = prod.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const newProduct = {
      id: `prod-${Date.now()}`,
      slug,
      isActive: true,
      isFeatured: false,
      images: prod.images || [],
      imagePublicIds: prod.imagePublicIds || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...prod
    };
    data.products.push(newProduct);
    writeData(data);
    return newProduct;
  },
  updateProduct(id: string, updates: any) {
    const data = readData();
    const idx = data.products.findIndex((p: any) => p.id === id);
    if (idx === -1) return null;
    
    if (updates.name) {
      updates.slug = updates.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    }

    data.products[idx] = {
      ...data.products[idx],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    writeData(data);
    return data.products[idx];
  },
  deleteProduct(id: string) {
    const data = readData();
    const idx = data.products.findIndex((p: any) => p.id === id);
    if (idx === -1) return false;
    data.products[idx].isActive = false;
    writeData(data);
    return true;
  },

  // CATEGORIES
  getCategories() {
    return readData().categories;
  },
  addCategory(category: string) {
    const data = readData();
    if (!data.categories.includes(category)) {
      data.categories.push(category);
      writeData(data);
    }
    return data.categories;
  },

  // CARTS
  getCart(userId: string) {
    const data = readData();
    const cart = data.carts.find((c: any) => c.userId === userId);
    if (!cart) {
      const newCart = { id: `cart-${Date.now()}`, userId, items: [], updatedAt: new Date().toISOString() };
      data.carts.push(newCart);
      writeData(data);
      return newCart;
    }
    return cart;
  },
  saveCart(userId: string, items: any[]) {
    const data = readData();
    let cart = data.carts.find((c: any) => c.userId === userId);
    if (!cart) {
      cart = { id: `cart-${Date.now()}`, userId, items: [], updatedAt: new Date().toISOString() };
      data.carts.push(cart);
    }
    cart.items = items;
    cart.updatedAt = new Date().toISOString();
    writeData(data);
    return cart;
  },

  // ORDERS
  getOrders() {
    return readData().orders;
  },
  getUserOrders(userId: string) {
    return readData().orders.filter((o: any) => o.userId === userId);
  },
  findOrderById(id: string) {
    return readData().orders.find((o: any) => o.id === id);
  },
  createOrder(orderData: any) {
    const data = readData();

    for (const item of orderData.items) {
      const prod = data.products.find((p: any) => p.id === item.productId);
      if (!prod) {
        throw new Error(`Product ${item.name} not found`);
      }
      if (prod.stock < item.qty) {
        throw new Error(`Insufficient stock for ${item.name}. Available: ${prod.stock}`);
      }
    }

    for (const item of orderData.items) {
      const prod = data.products.find((p: any) => p.id === item.productId);
      if (prod) {
        prod.stock -= item.qty;
      }
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
      invoiceUrl: '',
      labelUrl: '',
      trackingNumber: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    data.orders.push(newOrder);
    writeData(data);
    return newOrder;
  },
  updateOrder(id: string, updates: any) {
    const data = readData();
    const idx = data.orders.findIndex((o: any) => o.id === id);
    if (idx === -1) return null;
    data.orders[idx] = {
      ...data.orders[idx],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    writeData(data);
    return data.orders[idx];
  },

  // COUPONS
  getCoupons() {
    return readData().coupons || [];
  },
  findCouponByCode(code: string) {
    return (readData().coupons || []).find((c: any) => c.code.toUpperCase() === code.toUpperCase());
  },
  createCoupon(coupon: any) {
    const data = readData();
    if (!data.coupons) data.coupons = [];
    const newCoupon = {
      id: `coupon-${Date.now()}`,
      code: coupon.code.toUpperCase(),
      type: coupon.type,
      value: parseFloat(coupon.value),
      minOrderValue: parseFloat(coupon.minOrderValue || 0),
      maxUses: parseInt(coupon.maxUses || 0),
      usageCount: 0,
      expiryDate: coupon.expiryDate,
      isActive: coupon.isActive !== false,
      createdAt: new Date().toISOString()
    };
    data.coupons.push(newCoupon);
    writeData(data);
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
    data.coupons[idx] = {
      ...data.coupons[idx],
      ...updates
    };
    writeData(data);
    return data.coupons[idx];
  },
  deleteCoupon(id: string) {
    const data = readData();
    if (!data.coupons) data.coupons = [];
    const idx = data.coupons.findIndex((c: any) => c.id === id);
    if (idx === -1) return false;
    data.coupons.splice(idx, 1);
    writeData(data);
    return true;
  },
  updateUser(id: string, updates: any) {
    const data = readData();
    const idx = data.users.findIndex((u: any) => u.id === id);
    if (idx === -1) return null;
    data.users[idx] = {
      ...data.users[idx],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    writeData(data);
    return data.users[idx];
  },

  // SOFT DELETES, PAGINATION & ROLES FOR MEMBERS
  getPaginatedUsers(options: { cursor?: string; limit?: number; search?: string; role?: string; status?: string; authProvider?: string }) {
    const data = readData();
    const limit = options.limit || 50;
    
    let filtered = data.users.filter((u: any) => !u.deletedAt);

    if (options.role && options.role !== 'ALL') {
      filtered = filtered.filter((u: any) => u.role === options.role);
    }

    if (options.status && options.status !== 'ALL') {
      if (options.status === 'BANNED') {
        filtered = filtered.filter((u: any) => u.isBanned);
      } else if (options.status === 'UNVERIFIED') {
        filtered = filtered.filter((u: any) => !u.isVerified);
      } else if (options.status === 'ACTIVE') {
        filtered = filtered.filter((u: any) => u.isVerified && !u.isBanned);
      }
    }

    if (options.search) {
      const q = options.search.toLowerCase();
      filtered = filtered.filter((u: any) => 
        (u.name && u.name.toLowerCase().includes(q)) || 
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.phone && u.phone.includes(q))
      );
    }

    let mapped = filtered.map((u: any) => {
      let provider = u.authProvider;
      if (!provider) {
        if (u.googleId && u.passwordHash) {
          provider = 'both';
        } else if (u.googleId) {
          provider = 'google';
        } else {
          provider = 'email';
        }
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
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    const items = mapped.slice(startIndex, startIndex + limit);
    const nextCursor = (items.length > 0 && startIndex + limit < mapped.length)
      ? items[items.length - 1].id
      : null;

    return {
      items,
      nextCursor,
      totalCount: mapped.length
    };
  },

  softDeleteUser(id: string) {
    const data = readData();
    const idx = data.users.findIndex((u: any) => u.id === id);
    if (idx === -1) return false;
    data.users[idx].deletedAt = new Date().toISOString();
    writeData(data);
    return true;
  },

  // ACTIVITY LOGS
  getActivityLogs(userId?: string) {
    const data = readData();
    if (!data.activity_logs) {
      data.activity_logs = [];
      writeData(data);
    }
    if (userId) {
      return data.activity_logs.filter((l: any) => l.userId === userId).sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
    }
    return data.activity_logs.sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
  },

  logActivity(userId: string | null, action: string, ip: string, userAgent: string, metadata: any = {}) {
    const data = readData();
    if (!data.activity_logs) {
      data.activity_logs = [];
    }
    const newLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      userId,
      action,
      ip,
      userAgent,
      metadata,
      timestamp: new Date().toISOString()
    };
    data.activity_logs.push(newLog);
    if (data.activity_logs.length > 1000) {
      data.activity_logs.shift();
    }
    writeData(data);
    return newLog;
  },

  // EMAIL VERIFICATIONS
  createEmailVerification(userId: string, token: string, expiresAt: string) {
    const data = readData();
    if (!data.email_verifications) {
      data.email_verifications = [];
    }
    const entry = { userId, token, expiresAt, usedAt: null };
    data.email_verifications.push(entry);
    writeData(data);
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
    if (user) {
      user.isVerified = true;
    }
    writeData(data);
    return true;
  },

  // PASSWORD RESETS
  createPasswordReset(userId: string, token: string, expiresAt: string) {
    const data = readData();
    if (!data.password_resets) {
      data.password_resets = [];
    }
    const entry = { userId, token, expiresAt, usedAt: null };
    data.password_resets.push(entry);
    writeData(data);
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
      if (user.passwordHistory.length > 3) {
        user.passwordHistory.shift();
      }
      user.passwordHash = newPasswordHash;
    }
    writeData(data);
    return true;
  },

  recordPasswordHistory(userId: string, oldPasswordHash: string) {
    const data = readData();
    const user = data.users.find((u: any) => u.id === userId);
    if (user) {
      if (!user.passwordHistory) user.passwordHistory = [];
      user.passwordHistory.push(oldPasswordHash);
      if (user.passwordHistory.length > 3) {
        user.passwordHistory.shift();
      }
      writeData(data);
    }
  }
};
