const crypto = require('crypto');
const localDb = require('./localDbService');

const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const SESSION_COLLECTION = 'sessions';
const OAUTH_STATE_COLLECTION = 'oauthStates';

function randomId() {
  return crypto.randomBytes(32).toString('base64url');
}

function isExpired(record) {
  return !record || (record.expiresAt && Date.now() > record.expiresAt);
}

async function createOAuthState(data = {}) {
  const state = randomId();

  await localDb.setRecord(OAUTH_STATE_COLLECTION, state, {
    ...data,
    state,
    createdAt: Date.now(),
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  });

  return state;
}

async function consumeOAuthState(state) {
  const record = state ? await localDb.getRecord(OAUTH_STATE_COLLECTION, state) : null;

  if (state) {
    await localDb.deleteRecord(OAUTH_STATE_COLLECTION, state);
  }

  if (isExpired(record)) {
    return null;
  }

  return record;
}

async function createSession(data = {}) {
  const id = randomId();
  const now = Date.now();
  const session = {
    id,
    ...data,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + AUTH_SESSION_TTL_MS,
  };

  await localDb.setRecord(SESSION_COLLECTION, id, session);
  return session;
}

async function getSession(id) {
  const session = id ? await localDb.getRecord(SESSION_COLLECTION, id) : null;

  if (isExpired(session)) {
    if (id) {
      await localDb.deleteRecord(SESSION_COLLECTION, id);
    }
    return null;
  }

  return session || null;
}

async function updateSession(id, updates = {}) {
  const session = await getSession(id);

  if (!session) {
    return null;
  }

  Object.assign(session, updates, {
    updatedAt: Date.now(),
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
  });

  await localDb.setRecord(SESSION_COLLECTION, id, session);
  return session;
}

async function deleteSession(id) {
  if (id) {
    await localDb.deleteRecord(SESSION_COLLECTION, id);
  }
}

module.exports = {
  AUTH_SESSION_TTL_MS,
  OAUTH_STATE_TTL_MS,
  createOAuthState,
  consumeOAuthState,
  createSession,
  getSession,
  updateSession,
  deleteSession,
};
