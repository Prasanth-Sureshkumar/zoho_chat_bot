const express = require('express');
const hrDataService = require('../services/hrDataService');
const authSessionService = require('../services/authSessionService');
const zohoAuthService = require('../services/zohoAuthService');
const zohoTokenStore = require('../services/zohoTokenStore');
const { ChatService } = require('../services/chatService');
const { compactEmployee, findEmployeeByReference } = require('../utils/hrFormatters');
const { parseCookies, serializeCookie } = require('../utils/httpCookies');

const router = express.Router();
const chatService = new ChatService();
const AUTH_COOKIE = 'hr_auth_session';
const OAUTH_STATE_COOKIE = 'hr_oauth_state';

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');

  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }

  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}

function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function authCookieOptions(req, maxAge) {
  return {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(req),
    maxAge,
  };
}

function setAuthCookie(req, res, sessionId) {
  appendCookie(
    res,
    serializeCookie(AUTH_COOKIE, sessionId, {
      ...authCookieOptions(req, Math.floor(authSessionService.AUTH_SESSION_TTL_MS / 1000)),
    })
  );
}

function clearAuthCookie(req, res) {
  appendCookie(res, serializeCookie(AUTH_COOKIE, '', authCookieOptions(req, 0)));
}

function setOAuthStateCookie(req, res, state) {
  appendCookie(
    res,
    serializeCookie(OAUTH_STATE_COOKIE, state, {
      ...authCookieOptions(req, Math.floor(authSessionService.OAUTH_STATE_TTL_MS / 1000)),
    })
  );
}

function clearOAuthStateCookie(req, res) {
  appendCookie(res, serializeCookie(OAUTH_STATE_COOKIE, '', authCookieOptions(req, 0)));
}

function sanitizeReturnTo(returnTo) {
  const value = String(returnTo || '/');
  return value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function createAuthContext(session) {
  const email = session.email || zohoTokenStore.getEmailFromUser(session.user);

  return {
    email,
    getAccessToken: () => zohoTokenStore.getValidAccessToken(email),
  };
}

async function attachAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = await authSessionService.getSession(cookies[AUTH_COOKIE]);

  if (!session) {
    return null;
  }

  req.authSession = session;
  req.authContext = createAuthContext(session);
  return session;
}

async function authExpiredResponse(req, res, session, message = 'Zoho sign-in expired. Please sign in again.') {
  if (session?.id) {
    await authSessionService.deleteSession(session.id);
  }

  clearAuthCookie(req, res);
  res.status(401).json({
    success: false,
    error: message,
    loginUrl: '/api/auth/zoho/login',
  });
}

function requireAuth(handler) {
  return asyncRoute(async (req, res, next) => {
    const session = await attachAuth(req);

    if (!session) {
      res.status(401).json({
        success: false,
        error: 'Sign in with Zoho to continue.',
        loginUrl: '/api/auth/zoho/login',
      });
      return;
    }

    try {
      await handler(req, res, next);
    } catch (error) {
      if (zohoTokenStore.isAuthExpiredError(error)) {
        await authExpiredResponse(req, res, session, error.message);
        return;
      }

      throw error;
    }
  });
}

async function getCurrentEmployeeForRequest(req, res) {
  const employee = await hrDataService.getCurrentEmployee({
    authContext: req.authContext,
    currentUser: req.authSession.user,
  });

  if (!employee) {
    res.status(403).json({
      success: false,
      error: 'Your Zoho login could not be matched to an employee record.',
    });
    return null;
  }

  return employee;
}

function isCurrentEmployeeReference(employee, reference) {
  if (['me', 'my', 'self', 'current'].includes(String(reference || '').toLowerCase())) {
    return true;
  }

  return Boolean(findEmployeeByReference([employee], reference));
}

router.get('/status', asyncRoute(async (req, res) => {
  const session = await attachAuth(req);
  const tokenRecord = session?.email ? await zohoTokenStore.getTokenRecord(session.email) : null;

  res.json({
    status: 'Server running',
    dataSource: 'zoho-people',
    authenticated: Boolean(session),
    tokenStoredForUser: Boolean(tokenRecord),
    zohoOAuthConfigured: zohoAuthService.hasZohoOAuthConfig(),
    zohoSharedTokenConfigured: Boolean(
      process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET
    ),
  });
}));

router.get(
  '/auth/zoho/login',
  asyncRoute(async (req, res) => {
    const returnTo = sanitizeReturnTo(req.query.returnTo);
    const redirectUri = zohoAuthService.getRedirectUri(req);
    const state = await authSessionService.createOAuthState({ returnTo, redirectUri });

    setOAuthStateCookie(req, res, state);
    res.redirect(zohoAuthService.buildAuthorizationUrl({ state, redirectUri }));
  })
);

router.get(
  '/auth/zoho/callback',
  asyncRoute(async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const state = String(req.query.state || '');

    if (req.query.error) {
      throw new Error(`Zoho login failed: ${req.query.error}`);
    }

    if (!state || state !== cookies[OAUTH_STATE_COOKIE]) {
      throw new Error('Invalid Zoho OAuth state.');
    }

    if (!req.query.code) {
      throw new Error('Zoho did not return an authorization code.');
    }

    const oauthState = await authSessionService.consumeOAuthState(state);

    if (!oauthState) {
      throw new Error('Zoho OAuth state expired.');
    }

    const accountsBaseUrl = req.query['accounts-server'] || req.query.accounts_server || null;
    const tokens = await zohoAuthService.exchangeCodeForTokens({
      code: req.query.code,
      redirectUri: oauthState.redirectUri,
      accountsBaseUrl,
    });

    if (!tokens.accessToken) {
      throw new Error('Zoho did not return an access token.');
    }

    let user = {};

    try {
      user = await zohoAuthService.getUserInfo(tokens.accessToken, tokens.accountsBaseUrl);
    } catch (error) {
      user = {};
    }

    const email = zohoTokenStore.getEmailFromUser(user);

    if (!email) {
      throw new Error('Zoho login did not return an email address. Add AaaServer.profile.Read scope and sign in again.');
    }

    await zohoTokenStore.upsertUserTokens({
      email,
      tokens,
      user,
    });

    const session = await authSessionService.createSession({
      email,
      user,
    });

    clearOAuthStateCookie(req, res);
    setAuthCookie(req, res, session.id);
    res.redirect(oauthState.returnTo || '/');
  })
);

router.get(
  '/auth/me',
  asyncRoute(async (req, res) => {
    const session = await attachAuth(req);

    if (!session) {
      res.json({
        authenticated: false,
        loginUrl: '/api/auth/zoho/login',
      });
      return;
    }

    let employee = null;
    let employeeLookupError = null;

    try {
      employee = await hrDataService.getCurrentEmployee({
        authContext: req.authContext,
        currentUser: session.user,
      });
    } catch (error) {
      if (zohoTokenStore.isAuthExpiredError(error)) {
        await authExpiredResponse(req, res, session, error.message);
        return;
      }

      employeeLookupError = error.response?.data || error.message;
    }

    res.json({
      authenticated: true,
      user: zohoAuthService.toPublicUser(session.user),
      employee: employee ? compactEmployee(employee) : null,
      employeeLookupError,
    });
  })
);

router.post(
  '/auth/logout',
  asyncRoute(async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const session = await authSessionService.getSession(cookies[AUTH_COOKIE]);

    if (session?.email) {
      await zohoTokenStore.deleteUserTokens(session.email);
    }

    await authSessionService.deleteSession(cookies[AUTH_COOKIE]);
    clearAuthCookie(req, res);
    res.json({ success: true });
  })
);

router.get(
  '/employees',
  requireAuth(async (req, res) => {
    const employee = await getCurrentEmployeeForRequest(req, res);

    if (!employee) {
      return;
    }

    res.json({
      data: [compactEmployee(employee)],
      count: 1,
    });
  })
);

router.get(
  '/employees/raw',
  requireAuth(async (req, res) => {
    res.status(403).json({
      success: false,
      error: 'Raw employee lists are disabled in personal mode. Use /api/auth/me.',
    });
  })
);

router.get(
  '/leave-report/:employeeId',
  requireAuth(async (req, res) => {
    const employee = await getCurrentEmployeeForRequest(req, res);

    if (!employee) {
      return;
    }

    if (!isCurrentEmployeeReference(employee, req.params.employeeId)) {
      res.status(403).json({ success: false, error: 'You can only fetch your own leave report.' });
      return;
    }

    const report = await hrDataService.getLeaveReport(employee, {
      authContext: req.authContext,
    });

    if (!report) {
      res.status(404).json({ success: false, error: 'Leave report not found' });
      return;
    }

    res.json(report);
  })
);

router.get(
  '/holidays/:employeeId',
  requireAuth(async (req, res) => {
    const employee = await getCurrentEmployeeForRequest(req, res);

    if (!employee) {
      return;
    }

    if (!isCurrentEmployeeReference(employee, req.params.employeeId)) {
      res.status(403).json({ success: false, error: 'You can only fetch your own holidays.' });
      return;
    }

    res.json(
      await hrDataService.getHolidays(employee, {
        ...req.query,
        authContext: req.authContext,
      })
    );
  })
);

router.get(
  '/salary/:employeeId',
  requireAuth(async (req, res) => {
    const employee = await getCurrentEmployeeForRequest(req, res);

    if (!employee) {
      return;
    }

    if (!isCurrentEmployeeReference(employee, req.params.employeeId)) {
      res.status(403).json({ success: false, error: 'You can only fetch your own salary details.' });
      return;
    }

    res.json(
      await hrDataService.getSalaryComponents(employee, {
        authContext: req.authContext,
      })
    );
  })
);

router.post(
  '/attendance',
  requireAuth(async (req, res) => {
    const employee = await getCurrentEmployeeForRequest(req, res);

    if (!employee) {
      return;
    }

    const punchType = String(req.body.action || req.body.type || req.body.punchType || '').toLowerCase();
    const when = req.body.when || 'now';

    const attendancePayload = {
      ...req.body,
      checkIn: req.body.checkIn || (punchType === 'checkout' ? null : when),
      checkOut: req.body.checkOut || (punchType === 'checkout' ? when : null),
    };

    const result = await hrDataService.recordAttendance(employee, {
      ...attendancePayload,
      authContext: req.authContext,
    });

    res.json({
      success: true,
      action: punchType === 'checkout' ? 'checkout' : 'checkin',
      employee: compactEmployee(employee),
      result,
    });
  })
);

router.post(
  '/chat',
  requireAuth(async (req, res) => {
    const response = await chatService.handleMessage({
      sessionId: req.body.sessionId,
      message: req.body.message,
      action: req.body.action,
      authContext: req.authContext,
      currentUser: req.authSession.user,
      personalMode: true,
    });

    res.json(response);
  })
);

module.exports = router;
