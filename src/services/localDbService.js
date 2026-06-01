const { Pool } = require('pg');

const DEFAULT_TABLE_NAME = 'app_kv_records';
const COLLECTIONS = {
  sessions: 'sessions',
  oauthStates: 'oauthStates',
  zohoTokensByEmail: 'zohoTokensByEmail',
  vectorDocuments: 'vectorDocuments',
};

function getProvider() {
  if (process.env.NODE_ENV === 'test') {
    return 'memory';
  }

  return String(process.env.DB_PROVIDER || 'postgres').toLowerCase();
}

function getTableName() {
  return String(process.env.DB_TABLE_NAME || DEFAULT_TABLE_NAME)
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .slice(0, 63) || DEFAULT_TABLE_NAME;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

const memoryDb = {
  sessions: {},
  oauthStates: {},
  zohoTokensByEmail: {},
  vectorDocuments: {},
};

let pool = null;
let initPromise = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || undefined,
      ssl:
        process.env.PGSSLMODE === 'require'
          ? {
              rejectUnauthorized: false,
            }
          : undefined,
    });
  }

  return pool;
}

function getCollectionStore(collectionName) {
  if (!Object.prototype.hasOwnProperty.call(memoryDb, collectionName)) {
    memoryDb[collectionName] = {};
  }

  return memoryDb[collectionName];
}

function isMemoryProvider() {
  return getProvider() === 'memory';
}

async function ensureReady() {
  if (isMemoryProvider()) {
    return;
  }

  if (!initPromise) {
    const table = quoteIdentifier(getTableName());

    initPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        collection_name TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (collection_name, record_key)
      )
    `);
  }

  await initPromise;
}

async function getCollection(collectionName) {
  if (isMemoryProvider()) {
    return clone(getCollectionStore(collectionName));
  }

  await ensureReady();
  const table = quoteIdentifier(getTableName());
  const result = await getPool().query(
    `SELECT record_key, record_value FROM ${table} WHERE collection_name = $1`,
    [collectionName]
  );

  return result.rows.reduce((accumulator, row) => {
    accumulator[row.record_key] = row.record_value;
    return accumulator;
  }, {});
}

async function getRecord(collectionName, key) {
  if (isMemoryProvider()) {
    const store = getCollectionStore(collectionName);
    return store[key] ? clone(store[key]) : null;
  }

  await ensureReady();
  const table = quoteIdentifier(getTableName());
  const result = await getPool().query(
    `SELECT record_value FROM ${table} WHERE collection_name = $1 AND record_key = $2 LIMIT 1`,
    [collectionName, key]
  );

  return result.rows[0] ? clone(result.rows[0].record_value) : null;
}

async function setRecord(collectionName, key, value) {
  if (isMemoryProvider()) {
    const store = getCollectionStore(collectionName);
    store[key] = clone(value);
    return clone(store[key]);
  }

  await ensureReady();
  const table = quoteIdentifier(getTableName());
  await getPool().query(
    `
      INSERT INTO ${table} (collection_name, record_key, record_value, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (collection_name, record_key)
      DO UPDATE SET record_value = EXCLUDED.record_value, updated_at = NOW()
    `,
    [collectionName, key, JSON.stringify(value)]
  );

  return clone(value);
}

async function deleteRecord(collectionName, key) {
  if (isMemoryProvider()) {
    const store = getCollectionStore(collectionName);
    delete store[key];
    return;
  }

  await ensureReady();
  const table = quoteIdentifier(getTableName());
  await getPool().query(`DELETE FROM ${table} WHERE collection_name = $1 AND record_key = $2`, [
    collectionName,
    key,
  ]);
}

async function replaceCollection(collectionName, nextCollection) {
  if (isMemoryProvider()) {
    memoryDb[collectionName] = clone(nextCollection);
    return clone(memoryDb[collectionName]);
  }

  await ensureReady();
  const table = quoteIdentifier(getTableName());
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${table} WHERE collection_name = $1`, [collectionName]);

    for (const [key, value] of Object.entries(nextCollection || {})) {
      await client.query(
        `
          INSERT INTO ${table} (collection_name, record_key, record_value, updated_at)
          VALUES ($1, $2, $3::jsonb, NOW())
        `,
        [collectionName, key, JSON.stringify(value)]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return clone(nextCollection);
}

async function reload() {
  if (isMemoryProvider()) {
    memoryDb.sessions = {};
    memoryDb.oauthStates = {};
    memoryDb.zohoTokensByEmail = {};
    memoryDb.vectorDocuments = {};
    return clone(memoryDb);
  }

  if (pool) {
    await pool.end();
    pool = null;
    initPromise = null;
  }
}

function getBackendInfo() {
  return {
    provider: getProvider(),
    tableName: getTableName(),
    databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
  };
}

module.exports = {
  COLLECTIONS,
  getCollection,
  getRecord,
  setRecord,
  deleteRecord,
  replaceCollection,
  reload,
  getBackendInfo,
};
