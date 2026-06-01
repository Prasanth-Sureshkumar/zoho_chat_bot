const localDb = require('./localDbService');
const zohoAuthService = require('./zohoAuthService');

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const COLLECTION = 'zohoTokensByEmail';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getEmailFromUser(user = {}) {
  return normalizeEmail(
    user.Email ||
      user.email ||
      user.Primary_Email ||
      user.primary_email ||
      user.email_id ||
      user.EmailID
  );
}

function createAuthExpiredError(message, cause = null) {
  const error = new Error(message);
  error.code = 'ZOHO_TOKEN_EXPIRED';
  error.statusCode = 401;
  error.cause = cause;
  return error;
}

function isAuthExpiredError(error) {
  return error?.code === 'ZOHO_TOKEN_EXPIRED' || error?.statusCode === 401;
}

async function getTokenRecord(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return null;
  }

  return localDb.getRecord(COLLECTION, normalizedEmail);
}

async function saveTokenRecord(email, record) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error('Cannot store Zoho OAuth token without an email address.');
  }

  return localDb.setRecord(COLLECTION, normalizedEmail, {
    ...record,
    email: normalizedEmail,
    updatedAt: Date.now(),
  });
}

async function upsertUserTokens({ email, tokens, user = null }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error('Zoho login did not return an email address for token storage.');
  }

  const existing = (await getTokenRecord(normalizedEmail)) || {};
  const nextRecord = {
    ...existing,
    accessToken: tokens.accessToken || existing.accessToken || null,
    refreshToken: tokens.refreshToken || existing.refreshToken || null,
    expiresAt: tokens.expiresAt || existing.expiresAt || 0,
    tokenType: tokens.tokenType || existing.tokenType || 'Bearer',
    scope: tokens.scope || existing.scope || null,
    accountsBaseUrl: tokens.accountsBaseUrl || existing.accountsBaseUrl || zohoAuthService.getAccountsBaseUrl(),
    user: user || existing.user || {},
  };

  return saveTokenRecord(normalizedEmail, nextRecord);
}

async function deleteUserTokens(email) {
  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail) {
    await localDb.deleteRecord(COLLECTION, normalizedEmail);
  }
}

async function getValidAccessToken(email) {
  const normalizedEmail = normalizeEmail(email);
  const record = await getTokenRecord(normalizedEmail);

  if (!record) {
    throw createAuthExpiredError('Zoho sign-in expired. Please sign in again.');
  }

  const now = Date.now();

  if (record.accessToken && now < Number(record.expiresAt || 0) - TOKEN_REFRESH_BUFFER_MS) {
    return record.accessToken;
  }

  if (!record.refreshToken) {
    await deleteUserTokens(normalizedEmail);
    throw createAuthExpiredError('Zoho access expired and no refresh token is available. Please sign in again.');
  }

  try {
    const refreshed = await zohoAuthService.refreshAccessToken(record.refreshToken, record.accountsBaseUrl);
    const saved = await upsertUserTokens({
      email: normalizedEmail,
      tokens: {
        ...refreshed,
        refreshToken: refreshed.refreshToken || record.refreshToken,
      },
      user: record.user,
    });

    return saved.accessToken;
  } catch (error) {
    await deleteUserTokens(normalizedEmail);
    throw createAuthExpiredError('Zoho refresh token expired or was revoked. Please sign in again.', error);
  }
}

module.exports = {
  normalizeEmail,
  getEmailFromUser,
  getTokenRecord,
  upsertUserTokens,
  deleteUserTokens,
  getValidAccessToken,
  createAuthExpiredError,
  isAuthExpiredError,
};
