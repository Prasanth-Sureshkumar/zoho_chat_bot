const zohoPeopleService = require('./zohoPeopleService');
const {
  normalizeEmployeesResponse,
  findEmployeeByReference,
} = require('../utils/hrFormatters');

function assertZohoConfigured(options = {}) {
  if (!options.authContext && !zohoPeopleService.hasZohoConfig()) {
    throw new Error(
      'Zoho People credentials are not configured. Sign in with Zoho or set ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, and ZOHO_CLIENT_SECRET in .env.'
    );
  }
}

function getUserEmails(user = {}) {
  return [
    user.Email,
    user.email,
    user.Primary_Email,
    user.primary_email,
    user.email_id,
    user.EmailID,
  ]
    .filter(Boolean)
    .map((email) => String(email).trim().toLowerCase());
}

function getUserNames(user = {}) {
  return [
    user.Display_Name,
    user.display_name,
    user.name,
    user.Full_Name,
    user.full_name,
    [user.First_Name || user.first_name, user.Last_Name || user.last_name].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .map((name) => String(name).trim().toLowerCase());
}

async function getEmployeesRaw(options = {}) {
  assertZohoConfigured(options);
  return zohoPeopleService.getEmployeesRaw(options.authContext);
}

async function getEmployees(options = {}) {
  const rawResponse = await getEmployeesRaw(options);  
  return normalizeEmployeesResponse(rawResponse);
}

async function getEmployeeById(employeeId, options = {}) {
  const employees = await getEmployees(options);
  return findEmployeeByReference(employees, employeeId);
}

async function getCurrentEmployee(options = {}) {
  const employees = await getEmployees(options);
  const userEmails = getUserEmails(options.currentUser || options.user);
  const userNames = getUserNames(options.currentUser || options.user);

  const emailMatch = employees.find((employee) =>
    userEmails.includes(String(employee.email || '').trim().toLowerCase())
  );

  console.log(emailMatch, "i get");
  

  if (emailMatch) {
    return emailMatch;
  }

  const nameMatch = employees.find((employee) =>
    userNames.includes(String(employee.name || '').trim().toLowerCase())
  );

  if (nameMatch) {
    return nameMatch;
  }

  if (employees.length === 1) {
    return employees[0];
  }

  return null;
}

function getEmployeeApiCandidates(employeeOrId) {
  if (typeof employeeOrId === 'string') {
    return [employeeOrId];
  }

  if (!employeeOrId || typeof employeeOrId !== 'object') {
    return [];
  }

  const preferredField = process.env.ZOHO_EMPLOYEE_IDENTIFIER_FIELD || 'employeeId';
  const orderedFields = [
    preferredField,
    'employeeId',
    'zohoId',
    'recordId',
    'email',
  ];

  return [...new Set(orderedFields.map((field) => employeeOrId[field]).filter(Boolean))];
}

function getSalaryApiCandidates(employeeOrId) {
  if (typeof employeeOrId === 'string') {
    return [employeeOrId];
  }

  if (!employeeOrId || typeof employeeOrId !== 'object') {
    return [];
  }

  const preferredField = process.env.ZOHO_SALARY_IDENTIFIER_FIELD || 'recordId';
  const orderedFields = [preferredField, 'recordId'];

  return [...new Set(orderedFields.map((field) => employeeOrId[field]).filter(Boolean))];
}

async function tryWithEmployeeCandidates(employeeOrId, apiCall, options = {}, getCandidates = getEmployeeApiCandidates) {
  assertZohoConfigured(options);

  const candidates = getCandidates(employeeOrId);

  if (!candidates.length) {
    throw new Error('Employee identifier is required for Zoho People API request.');
  }

  let lastError;

  for (const candidate of candidates) {
    try {
      return await apiCall(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function getLeaveReport(employeeOrId, options = {}) {
  return tryWithEmployeeCandidates(
    employeeOrId,
    (employeeId) => zohoPeopleService.getLeaveReport(employeeId, options.authContext),
    options
  );
}

async function getHolidays(employeeOrId, options = {}) {
  return tryWithEmployeeCandidates(employeeOrId, (employeeId) =>
    zohoPeopleService.getHolidays(employeeId, options, options.authContext),
    options
  );
}

async function getSalaryComponents(employeeOrId, options = {}) {
  return tryWithEmployeeCandidates(
    employeeOrId,
    (employeeRecordNumber) => zohoPeopleService.getSalaryComponents(employeeRecordNumber, options.authContext),
    options,
    getSalaryApiCandidates
  );
}

async function recordAttendance(employeeOrId, options = {}) {
  return tryWithEmployeeCandidates(
    employeeOrId,
    (employeeId) =>
      zohoPeopleService.recordAttendance(
        {
          ...options,
          empId: options.empId || employeeId,
        },
        options.authContext
      ),
    options
  );
}

function stripOrdinalSuffix(input) {
  return String(input || '').replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
}

function formatDateForZoho(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short' });
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function parseLeaveDates(message) {
  const text = stripOrdinalSuffix(message);
  const rangeMatch = text.match(/\bfrom\s+(.+?)\s+(?:to|-)\s+(.+?)(?:\s+as\s+|\s+for\s+|\s+because|\s+reason\b|$)/i);

  if (rangeMatch) {
    const fromDate = formatDateForZoho(rangeMatch[1]);
    const toDate = formatDateForZoho(rangeMatch[2]);
    if (fromDate && toDate) {
      return { fromDate, toDate };
    }
  }

  const onMatch = text.match(/\bon\s+(.+?)(?:\s+as\s+|\s+for\s+|\s+because|\s+reason\b|$)/i);

  if (onMatch) {
    const date = formatDateForZoho(onMatch[1]);
    if (date) {
      return { fromDate: date, toDate: date };
    }
  }

  return null;
}

function parseLeaveTypeHint(message) {
  const text = String(message || '').toLowerCase();
  const asMatch = text.match(/\bas\s+([a-z\s-]+?)(?:\s+leave\b|$)/i);
  if (asMatch) {
    return asMatch[1].trim();
  }

  const forMatch = text.match(/\bfor\s+([a-z\s-]+?)\s+leave\b/i);
  if (forMatch) {
    return forMatch[1].trim();
  }

  const directMatch = text.match(/\b(casual|sick|earned|annual|vacation|maternity|paternity|bereavement|compensatory|loss of pay|without pay|lwp)\b/i);
  return directMatch ? directMatch[1].trim() : null;
}

function parseLeaveReason(message) {
  const text = String(message || '');
  const reasonMatch = text.match(/\b(?:because|reason\s*[:\-])\s*(.+)$/i);
  return reasonMatch ? reasonMatch[1].trim() : null;
}

function normalizeLeaveType(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getLeaveTypeId(value = {}) {
  return (
    value.leavetypeID ||
    value.leaveTypeId ||
    value.leave_type_id ||
    value.id ||
    value.LeavetypeID ||
    value.Leavetype_ID ||
    null
  );
}

function getLeaveTypeName(value = {}) {
  return (
    value.leavetypeName ||
    value.leaveTypeName ||
    value.Leavetype ||
    value.name ||
    value.title ||
    ''
  );
}

function resolveLeaveType(leaveReport, leaveTypeHint) {
  const leaveTypes = leaveReport?.leavetypes || leaveReport?.leaveTypes || [];

  if (!leaveTypes.length) {
    return null;
  }

  if (!leaveTypeHint) {
    return leaveTypes[0];
  }

  const normalizedHint = normalizeLeaveType(leaveTypeHint);
  const exact = leaveTypes.find((item) => {
    const name = normalizeLeaveType(getLeaveTypeName(item));
    const code = normalizeLeaveType(item.code);
    return name === normalizedHint || code === normalizedHint;
  });

  if (exact) {
    return exact;
  }

  return leaveTypes.find((item) => {
    const name = normalizeLeaveType(getLeaveTypeName(item));
    return name.includes(normalizedHint) || normalizedHint.includes(name);
  }) || null;
}

function flattenLeaveTypeDetails(payload = {}) {
  const buckets = [payload?.response?.result, payload?.result, payload?.data].filter(Boolean);
  const flattened = [];

  for (const bucket of buckets) {
    if (Array.isArray(bucket)) {
      flattened.push(...bucket);
      continue;
    }

    if (bucket && typeof bucket === 'object') {
      for (const value of Object.values(bucket)) {
        if (Array.isArray(value)) {
          flattened.push(...value);
        } else if (value && typeof value === 'object') {
          flattened.push(value);
        }
      }
    }
  }

  return flattened.filter((item) => getLeaveTypeId(item));
}

function findMatchingLeaveTypeFromMaster(masterTypes, leaveTypeHint, fallbackCode = null) {
  if (!Array.isArray(masterTypes) || !masterTypes.length) {
    return null;
  }

  const normalizedHint = normalizeLeaveType(leaveTypeHint);
  const normalizedCode = normalizeLeaveType(fallbackCode);

  if (normalizedHint) {
    const exact = masterTypes.find((item) => {
      const name = normalizeLeaveType(getLeaveTypeName(item));
      const code = normalizeLeaveType(item.code || item.leaveCode || item.leave_type_code);
      return name === normalizedHint || code === normalizedHint;
    });
    if (exact) {
      return exact;
    }

    const fuzzy = masterTypes.find((item) => {
      const name = normalizeLeaveType(getLeaveTypeName(item));
      return name.includes(normalizedHint) || normalizedHint.includes(name);
    });
    if (fuzzy) {
      return fuzzy;
    }
  }

  if (normalizedCode) {
    return (
      masterTypes.find((item) => {
        const code = normalizeLeaveType(item.code || item.leaveCode || item.leave_type_code);
        return code === normalizedCode;
      }) || null
    );
  }

  return null;
}

function getLeaveTypesFromBookedAndBalance(report = {}) {
  const map = report?.leavetypes || {};

  if (!map || typeof map !== 'object') {
    return [];
  }

  return Object.entries(map).map(([id, value]) => ({
    leavetypeID: id,
    leavetypeName: value?.name || value?.leavetypeName || '',
    code: value?.code || '',
    unit: value?.unit || '',
    type: value?.type || '',
  }));
}

async function applyLeaveFromMessage(employeeOrId, message, options = {}) {
  const employee = typeof employeeOrId === 'object' ? employeeOrId : await getEmployeeById(employeeOrId, options);
  if (!employee) {
    throw new Error('Employee not found for leave request.');
  }

  const parsedDates = parseLeaveDates(message);
  if (!parsedDates) {
    throw new Error('Please include a leave date, for example: apply leave on 26 June 2026 as casual leave.');
  }

  const leaveTypeHint = parseLeaveTypeHint(message);
  const leaveReport = await getLeaveReport(employee, options);
  let leaveType = resolveLeaveType(leaveReport, leaveTypeHint);

  const employeeZohoId = employee.recordId || employee.zohoId || employee.employeeId;

  if (!employeeZohoId) {
    throw new Error('Could not find employee Zoho ID for leave request.');
  }

  // Prefer IDs from bookedAndBalance API as requested by business logic.
  try {
    const bookedAndBalance = await zohoPeopleService.getBookedAndBalanceReport(
      {
        employee: employeeZohoId,
        unit: 'Day',
        limit: 1,
      },
      options.authContext
    );
    console.log('Booked and Balance API response:', bookedAndBalance);
    
    const catalog = getLeaveTypesFromBookedAndBalance(bookedAndBalance);
    const mappedFromBookedBalance = findMatchingLeaveTypeFromMaster(catalog, leaveTypeHint, leaveType?.code);


    if (mappedFromBookedBalance && getLeaveTypeId(mappedFromBookedBalance)) {
      leaveType = {
        ...leaveType,
        ...mappedFromBookedBalance,
      };
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '[Leave] bookedAndBalance lookup failed, continuing with leave report type:',
        error?.response?.data || error?.message
      );
    }
  }

  if (!getLeaveTypeId(leaveType)) {
    throw new Error('Could not match leave type. Please mention one from your leave report.');
  }

  const payload = {
    employeeZohoId,
    leaveTypeId: getLeaveTypeId(leaveType),
    fromDate: parsedDates.fromDate,
    toDate: parsedDates.toDate,
    reason: parseLeaveReason(message) || options.reason || 'Leave request from HR assistant chat',
    unit: options.unit || 'Days',
    approverId: options.approverId,
  };

  let result;

  try {
    result = await zohoPeopleService.addLeaveRequest(payload, options.authContext);
  } catch (error) {
    const responseData = error?.response?.data || {};
    const errorCode = String(responseData.code || error.code || '').toUpperCase();
    const errorMessage = String(responseData.message || error.message || '');
    const isLeaveTypeError = errorCode === 'INVALIDINPUT' && /leave_type_id/i.test(errorMessage);

    if (!isLeaveTypeError) {
      throw error;
    }

    const leaveTypeDetails = await zohoPeopleService.getLeaveTypeDetails(options.authContext);
    const masterTypes = flattenLeaveTypeDetails(leaveTypeDetails);
    const remapped = findMatchingLeaveTypeFromMaster(masterTypes, leaveTypeHint, leaveType?.code);

    if (!remapped || !getLeaveTypeId(remapped)) {
      throw error;
    }

    payload.leaveTypeId = getLeaveTypeId(remapped);
    result = await zohoPeopleService.addLeaveRequest(payload, options.authContext);
  }

  return {
    result,
    request: payload,
    leaveType,
  };
}

module.exports = {
  getEmployeesRaw,
  getEmployees,
  getEmployeeById,
  getCurrentEmployee,
  getLeaveReport,
  getHolidays,
  getSalaryComponents,
  recordAttendance,
  applyLeaveFromMessage,
};
