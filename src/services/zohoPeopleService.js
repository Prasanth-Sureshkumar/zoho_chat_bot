const axios = require('axios');
const zohoAuthService = require('./zohoAuthService');

const tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function getPeopleBaseUrl() {
  return String(process.env.ZOHO_PEOPLE_BASE_URL || 'https://people.zoho.in').replace(/\/+$/, '');
}

function getCompensationBaseUrl() {
  return String(process.env.ZOHO_COMPENSATION_BASE_URL || getPeopleBaseUrl()).replace(/\/+$/, '');
}

function getAttendanceBaseUrl() {
  return getPeopleBaseUrl();
}

function getAttendanceTimeZone() {
  return String(process.env.ZOHO_ATTENDANCE_TIMEZONE || process.env.TZ || 'Asia/Kolkata');
}

function getAttendanceDateFormat() {
  return String(process.env.ZOHO_ATTENDANCE_DATE_FORMAT || 'dd/MM/yyyy HH:mm:ss');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function getFormattedDateParts(date = new Date(), timeZone = getAttendanceTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return {
    day: map.day || '01',
    month: map.month || 'Jan',
    year: map.year || '1970',
    hour: map.hour || '00',
    minute: map.minute || '00',
    second: map.second || '00',
  };
}

function formatAttendanceTimestamp(date = new Date(), format = getAttendanceDateFormat(), timeZone = getAttendanceTimeZone()) {
  const parts = getFormattedDateParts(date, timeZone);
  const monthNumber = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: '2-digit',
  })
    .format(date);
  const hour24 = Number(parts.hour) % 24;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 >= 12 ? 'PM' : 'AM';

  const replacements = {
    yyyy: parts.year,
    MMMM: new Intl.DateTimeFormat('en-GB', { timeZone, month: 'long' }).format(date),
    MMM: parts.month,
    MM: monthNumber,
    M: String(Number(monthNumber)),
    dd: parts.day,
    d: String(Number(parts.day)),
    HH: pad(hour24),
    H: String(hour24),
    hh: pad(hour12),
    h: String(hour12),
    mm: parts.minute,
    m: String(Number(parts.minute)),
    ss: parts.second,
    s: String(Number(parts.second)),
    a: ampm,
  };

  return format.replace(/yyyy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s|a/g, (token) => replacements[token] || token);
}

function hasZohoConfig() {
  return Boolean(
    process.env.ZOHO_REFRESH_TOKEN &&
      process.env.ZOHO_CLIENT_ID &&
      process.env.ZOHO_CLIENT_SECRET
  );
}

async function getServiceAccessToken() {
  if (!hasZohoConfig()) {
    throw new Error('Zoho credentials are not configured');
  }

  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60000) {
    return tokenCache.accessToken;
  }

  const response = await axios.post(`${zohoAuthService.getAccountsBaseUrl()}/oauth/v2/token`, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });

  const accessToken = response.data.access_token;
  const expiresIn = response.data.expires_in || 3600;

  tokenCache.accessToken = accessToken;
  tokenCache.expiresAt = now + expiresIn * 1000;

  return accessToken;
}

async function getAccessToken(authContext = null) {
  if (typeof authContext?.getAccessToken === 'function') {
    return authContext.getAccessToken();
  }

  const now = Date.now();

  if (authContext?.accessToken && now < authContext.expiresAt - 60000) {
    return authContext.accessToken;
  }

  if (authContext?.refreshToken) {
    const refreshed = await zohoAuthService.refreshAccessToken(
      authContext.refreshToken,
      authContext.accountsBaseUrl
    );
    const nextAuthContext = {
      ...authContext,
      ...refreshed,
      refreshToken: refreshed.refreshToken || authContext.refreshToken,
    };

    Object.assign(authContext, nextAuthContext);

    if (typeof authContext.onTokenRefresh === 'function') {
      await authContext.onTokenRefresh(nextAuthContext);
    }

    return nextAuthContext.accessToken;
  }

  return getServiceAccessToken();
}

async function zohoGet(url, params = {}, authContext = null) {
  const accessToken = await getAccessToken(authContext);

  const response = await axios.get(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
    params,
  });

  return response.data;
}

async function getEmployeesRaw(authContext = null) {
  return zohoGet(`${getPeopleBaseUrl()}/people/api/forms/employee/getRecords`, {}, authContext);
}

async function getLeaveReport(employeeId, authContext = null) {
  return zohoGet(
    `${getPeopleBaseUrl()}/people/api/v2/leavetracker/reports/user`,
    {
      employee: employeeId,
    },
    authContext
  );
}

function formatBookedBalanceDate(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short' });
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function getCurrentLeaveYearRange() {
  const now = new Date();
  const year = now.getFullYear();

  return {
    from: `01-Jan-${year}`,
    to: formatBookedBalanceDate(now),
  };
}

async function getBookedAndBalanceReport(options = {}, authContext = null) {
  const range = getCurrentLeaveYearRange();
  const params = {
    from: options.from || range.from,
    to: options.to || range.to,
    unit: options.unit || 'Day',
    ...(options.employee ? { employee: JSON.stringify(Array.isArray(options.employee) ? options.employee : [options.employee]) } : {}),
    ...(options.leavetype ? { leavetype: JSON.stringify(Array.isArray(options.leavetype) ? options.leavetype : [options.leavetype]) } : {}),
    ...(options.department ? { department: JSON.stringify(Array.isArray(options.department) ? options.department : [options.department]) } : {}),
    ...(options.employeeStatus ? { employeeStatus: JSON.stringify(Array.isArray(options.employeeStatus) ? options.employeeStatus : [options.employeeStatus]) } : {}),
    ...(options.startIndex !== undefined ? { startIndex: options.startIndex } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  };

  return zohoGet(`${getPeopleBaseUrl()}/people/api/v2/leavetracker/reports/bookedAndBalance`, params, authContext);
}

async function getLeaveTypeDetails(authContext = null) {
  return zohoGet(`${getPeopleBaseUrl()}/people/api/leave/getLeaveTypeDetails`, {}, authContext);
}

async function getLeaveTypes(authContext) {
  return zohoGet(
    `${getPeopleBaseUrl()}/people/api/forms/LeaveType/getRecords`,
    authContext
  );
}

async function getForms(authContext) {
  return zohoGet(
    `${getPeopleBaseUrl()}/people/api/forms`,
    authContext
  );
}

async function getHolidays(employeeId, options = {}, authContext = null) {
  return zohoGet(
    `${getPeopleBaseUrl()}/people/api/leave/v2/holidays/get`,
    {
      employee: employeeId,
      from: options.from || '01-Jan-2026',
      to: options.to || '31-Dec-2026',
      upcoming: options.upcoming === 'true' || options.upcoming === true,
      dateFormat: options.dateFormat || 'dd-MMM-yyyy',
    },
    authContext
  );
}

async function getSalaryComponents(employeeRecordNumber, authContext = null) {
  return zohoGet(
    `${getCompensationBaseUrl()}/api/compensation/v1/salary/${encodeURIComponent(
      employeeRecordNumber
    )}`,
    {},
    authContext
  );
}

async function zohoPost(url, params = {}, authContext = null) {
  const accessToken = await getAccessToken(authContext);

  const response = await axios.post(url, null, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
    params,
  });

  return response.data;
}

async function recordAttendance(options = {}, authContext = null) {
  const {
    checkIn,
    checkOut,
    empId,
    emailId,
    mapId,
    latitude,
    longitude,
    accuracy,
    altitude,
    location,
    dateFormat,
  } = options;

  const params = {
    dateFormat: dateFormat || getAttendanceDateFormat(),
    ...(checkIn ? { checkIn: checkIn === 'now' ? formatAttendanceTimestamp(new Date(), dateFormat || getAttendanceDateFormat()) : checkIn } : {}),
    ...(checkOut ? { checkOut: checkOut === 'now' ? formatAttendanceTimestamp(new Date(), dateFormat || getAttendanceDateFormat()) : checkOut } : {}),
    ...(empId ? { empId } : {}),
    ...(emailId ? { emailId } : {}),
    ...(mapId ? { mapId } : {}),
    ...(latitude !== undefined && latitude !== null && latitude !== '' ? { latitude } : {}),
    ...(longitude !== undefined && longitude !== null && longitude !== '' ? { longitude } : {}),
    ...(accuracy !== undefined && accuracy !== null && accuracy !== '' ? { accuracy } : {}),
    ...(altitude !== undefined && altitude !== null && altitude !== '' ? { altitude } : {}),
    ...(location ? { location } : {}),
  };

  return zohoPost(`${getAttendanceBaseUrl()}/people/api/attendance`, params, authContext);
}

async function addLeaveRequest(options = {}, authContext = null) {
  const {
    employeeZohoId,
    leaveTypeId,
    fromDate,
    toDate,
    reason,
    unit = 'Days',
    days,
    approverId,
    ...customFields
  } = options;


  const numericApproverId =
    approverId === undefined || approverId === null || approverId === ''
      ? undefined
      : Number.parseInt(String(approverId), 10);

  const payload = {
    employee_zoho_id: employeeZohoId,
    leave_type_id: leaveTypeId,
    from_date: fromDate,
    to_date: toDate,
    unit,
    ...(reason ? { reason } : {}),
    ...(days ? { days } : {}),
    ...(numericApproverId ? { approver_id: numericApproverId } : {}),
    ...customFields,
  };

  console.log('Adding leave request with payload:', payload);

  return zohoPost(`${getPeopleBaseUrl()}/people/api/v3/leave-tracker/leaves`, payload, authContext);
}

module.exports = {
  hasZohoConfig,
  getPeopleBaseUrl,
  getCompensationBaseUrl,
  getAttendanceBaseUrl,
  getAttendanceDateFormat,
  getAttendanceTimeZone,
  formatAttendanceTimestamp,
  getAccessToken,
  getEmployeesRaw,
  getLeaveReport,
  getBookedAndBalanceReport,
  getLeaveTypeDetails,
  getHolidays,
  getSalaryComponents,
  recordAttendance,
  addLeaveRequest,
  getLeaveTypes,
  getForms,
};
