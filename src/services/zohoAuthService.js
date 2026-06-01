const axios = require('axios');

const DEFAULT_ZOHO_ACCOUNTS_BASE_URL = 'https://accounts.zoho.in';
const DEFAULT_ZOHO_OAUTH_SCOPES = [
  'ZOHOPEOPLE.employee.READ',
  'ZOHOPEOPLE.forms.READ',
  'ZOHOPEOPLE.attendance.ALL',
  'ZOHOPEOPLE.leave.READ',
  'ZOHOPEOPLE.leave.CREATE',
  'ZohoPeople.compensation.ALL',
  'AaaServer.profile.Read',
].join(',');

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_ZOHO_ACCOUNTS_BASE_URL).replace(/\/+$/, '');
}

function hasZohoOAuthConfig() {
  return Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET);
}

function assertZohoOAuthConfigured() {
  if (!hasZohoOAuthConfig()) {
    throw new Error('Zoho OAuth is not configured. Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env.');
  }
}

function getAccountsBaseUrl(accountsBaseUrl = null) {
  return normalizeBaseUrl(accountsBaseUrl || process.env.ZOHO_ACCOUNTS_BASE_URL);
}

function getOAuthScopes() {
  return process.env.ZOHO_OAUTH_SCOPES || DEFAULT_ZOHO_OAUTH_SCOPES;
}

function getRedirectUri(req) {
  if (process.env.ZOHO_REDIRECT_URI) {
    return process.env.ZOHO_REDIRECT_URI;
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${protocol}://${req.get('host')}/api/auth/zoho/callback`;
}

function buildAuthorizationUrl({ state, redirectUri }) {
  assertZohoOAuthConfigured();

  const url = new URL('/oauth/v2/auth', getAccountsBaseUrl());
  url.searchParams.set('scope', getOAuthScopes());
  url.searchParams.set('client_id', process.env.ZOHO_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', process.env.ZOHO_OAUTH_PROMPT || 'consent');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  return url.toString();
}

function normalizeTokenResponse(payload = {}, accountsBaseUrl = null, existingRefreshToken = null) {
  return {
    accessToken: payload.access_token || null,
    refreshToken: payload.refresh_token || existingRefreshToken || null,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
    tokenType: payload.token_type || 'Bearer',
    scope: payload.scope || null,
    accountsBaseUrl: getAccountsBaseUrl(accountsBaseUrl),
  };
}

async function exchangeCodeForTokens({ code, redirectUri, accountsBaseUrl = null }) {
  assertZohoOAuthConfigured();

  const response = await axios.post(`${getAccountsBaseUrl(accountsBaseUrl)}/oauth/v2/token`, null, {
    params: {
      code,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    },
  });

  return normalizeTokenResponse(response.data, accountsBaseUrl);
}

async function refreshAccessToken(refreshToken, accountsBaseUrl = null) {
  assertZohoOAuthConfigured();

  const response = await axios.post(`${getAccountsBaseUrl(accountsBaseUrl)}/oauth/v2/token`, null, {
    params: {
      refresh_token: refreshToken,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });

  return normalizeTokenResponse(response.data, accountsBaseUrl, refreshToken);
}

async function getUserInfo(accessToken, accountsBaseUrl = null) {
  const response = await axios.get(`${getAccountsBaseUrl(accountsBaseUrl)}/oauth/user/info`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  return response.data;
}

function toPublicUser(user = {}) {
  return {
    id: user.ZUID || user.zuid || user.sub || user.id || null,
    name: user.Display_Name || user.display_name || user.name || user.Full_Name || null,
    email: user.Email || user.email || user.Primary_Email || user.primary_email || null,
  };
}

module.exports = {
  DEFAULT_ZOHO_ACCOUNTS_BASE_URL,
  DEFAULT_ZOHO_OAUTH_SCOPES,
  hasZohoOAuthConfig,
  getAccountsBaseUrl,
  getOAuthScopes,
  getRedirectUri,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getUserInfo,
  toPublicUser,
};
