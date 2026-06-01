function normalizeEmployeeRecord(record = {}, recordId = '') {
  const firstName = record.FirstName || record.firstName || '';
  const lastName = record.LastName || record.lastName || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

  return {
    recordId: recordId || record.recordId || '',
    zohoId: String(record.Zoho_ID || record.zohoId || ''),
    employeeId: record.EmployeeID || record.employeeId || '',
    firstName,
    lastName,
    name: fullName || record.EmployeeName || record.Name || record.name || 'Unknown employee',
    email: record.EmailID || record.email || '',
    photo: record.Photo_downloadUrl || record.Photo || record.photo || '',
    status: record.Employeestatus || record.status || '',
    role: record.Role || record.role || '',
    department: record.Department || record.department || '',
    designation: record.Designation || record.designation || '',
    location: record.LocationName || record.location || '',
    workLocation: record.Work_location || record.workLocation || '',
    reportingTo: record.Reporting_To || record.reportingTo || '',
    dateOfJoining: record.Dateofjoining || record.dateOfJoining || '',
    employeeType: record.Employee_type || record.employeeType || '',
    experience: record.Experience || record.experience || '',
    mobile: record.Mobile || record.mobile || '',
    UAN: record.UAN || record.UAN_Number || record.uan || record.uan_number || '',
  };
}

function normalizeEmployeesResponse(payload = {}) {
  const result = payload.response?.result || payload.result || [];

  if (!Array.isArray(result)) {
    return [];
  }

  return result.flatMap((recordGroup) =>
    Object.entries(recordGroup).flatMap(([recordId, records]) => {
      if (!Array.isArray(records)) {
        return [];
      }

      return records.map((record) => normalizeEmployeeRecord(record, recordId));
    })
  );
}

function compactEmployee(employee) {
  return {
    id: employee.employeeId,
    name: employee.name,
    email: employee.email,
    department: employee.department,
    designation: employee.designation,
    status: employee.status,
    uan: employee.UAN,
  };
}

function formatEmployeeDetails(employee) {
  const rows = [
    ['Name', employee.name],
    ['Employee ID', employee.employeeId],
    ['Email', employee.email],
    ['Status', employee.status],
    ['Role', employee.role],
    ['Department', employee.department],
    ['Designation', employee.designation],
    ['Location', employee.location || employee.workLocation],
    ['Reporting To', employee.reportingTo],
    ['Joining Date', employee.dateOfJoining],
    ['Employee Type', employee.employeeType],
    ['Experience', employee.experience ? `${employee.experience} year(s)` : ''],
    ['Mobile', employee.mobile],
    ['UAN Number', employee.UAN],
  ].filter(([, value]) => value);

  return rows.map(([label, value]) => `${label}: ${value}`).join('\n');
}

function formatEmployeeList(employees) {
  return employees
    .map((employee, index) => {
      const designation = employee.designation ? `, ${employee.designation}` : '';
      return `${index + 1}. ${employee.name} (${employee.employeeId}${designation})`;
    })
    .join('\n');
}

function formatLeaveReport(report) {
  const leaveTypes = report.leavetypes || report.leaveTypes || [];
  const rows = leaveTypes.map((leave) => {
    const code = leave.code ? ` (${leave.code})` : '';
    const type = leave.type ? `, ${leave.type}` : '';
    return `${leave.leavetypeName || leave.name}${code}: available ${leave.available}, taken ${leave.taken}${type}`;
  });

  return [
    `Leave report for ${report.employeeName || report.name || 'employee'} (${report.employeeId || 'ID not available'})`,
    ...rows,
  ].join('\n');
}

function formatHolidayReport(employee, holidayResponse) {
  const holidays = Array.isArray(holidayResponse) ? holidayResponse : holidayResponse.data || [];
  const rows = holidays.map((holiday) => {
    const session = holiday.isHalfday ? 'Half day' : 'Full day';
    return `${holiday.Date}: ${holiday.Name} (${session})`;
  });

  return [
    `Holidays for ${employee.name} (${employee.employeeId})`,
    rows.length ? rows.join('\n') : 'No holidays found for this employee.',
  ].join('\n');
}

function getSalaryComponents(salaryResponse) {
  const result = salaryResponse?.response?.result || salaryResponse?.result || {};

  if (Array.isArray(result)) {
    return [];
  }

  return result.ctcComponents || result.components || result.data || [];
}

function getSalarySummaries(salaryResponse) {
  const result = salaryResponse?.response?.result || salaryResponse?.result || [];
  return Array.isArray(result) ? result : [];
}

function formatCurrencyAmount(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const numericValue = Number(String(value).replace(/,/g, ''));

  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return numericValue.toLocaleString('en-IN', {
    maximumFractionDigits: 2,
  });
}

function formatSalaryComponents(employee, salaryResponse) {
  const components = getSalaryComponents(salaryResponse);
  const summaries = getSalarySummaries(salaryResponse);

  if (!components.length) {
    if (summaries.length) {
      const rows = summaries.map((summary) => {
        const ctc = formatCurrencyAmount(summary.CTC);
        const currency = summary.Currency ? `${summary.Currency} ` : '';
        const effectiveFrom = summary.Effective_From ? `, effective from ${summary.Effective_From}` : '';
        const paySchedule = summary.Pay_Schedule ? `, ${summary.Pay_Schedule}` : '';
        const salaryId = summary.Salary_Id ? `, salary ID ${summary.Salary_Id}` : '';
        const packageText = summary.Salary_Package ? `, package ${summary.Salary_Package}` : '';

        return `CTC: ${currency}${ctc || 'not available'}${paySchedule}${effectiveFrom}${packageText}${salaryId}`;
      });

      return [
        `Salary details for ${employee.name} (${employee.employeeId})`,
        ...rows,
      ].join('\n');
    }

    return `Salary components for ${employee.name} (${employee.employeeId})\nNo salary components found.`;
  }

  const rows = components.map((component) => {
    const monthly = formatCurrencyAmount(component.Monthly);
    const annually = formatCurrencyAmount(component.Annually);
    const category = component.Component_Category ? `, ${component.Component_Category}` : '';
    const payment = [component.Payment_Type, component.Payment_Frequency].filter(Boolean).join(' ');
    const paymentText = payment ? `, ${payment}` : '';
    const monthlyText = monthly ? `monthly ${monthly}` : 'monthly not available';
    const annualText = annually ? `annual ${annually}` : 'annual not available';

    return `${component.Component_Name || 'Component'}: ${monthlyText}, ${annualText}${category}${paymentText}`;
  });

  return [
    `Salary components for ${employee.name} (${employee.employeeId})`,
    ...rows,
  ].join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldAppearsInReference(fieldValue, normalizedReference) {
  const normalizedValue = String(fieldValue || '').trim().toLowerCase();

  if (!normalizedValue) {
    return false;
  }

  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedValue)}($|[^a-z0-9])`, 'i');
  return pattern.test(normalizedReference);
}

function findEmployeeByReference(employees, reference, options = {}) {
  const normalizedReference = String(reference || '').trim().toLowerCase();
  const { allowIndexSelection = false, preferIndexSelection = false } = options;

  if (!normalizedReference) {
    return null;
  }

  const isPlainNumber = /^\d+$/.test(normalizedReference);
  const numberSelection = Number.parseInt(normalizedReference, 10);
  if (allowIndexSelection && preferIndexSelection && isPlainNumber) {
    return employees[numberSelection - 1] || null;
  }

  const value = (input) => String(input || '').trim().toLowerCase();

  const directMatch =
    employees.find((employee) => value(employee.employeeId) === normalizedReference) ||
    employees.find((employee) => value(employee.zohoId) === normalizedReference) ||
    employees.find((employee) => value(employee.recordId) === normalizedReference) ||
    employees.find((employee) => value(employee.email) === normalizedReference) ||
    employees.find((employee) => value(employee.name) === normalizedReference) ||
    employees.find((employee) => fieldAppearsInReference(employee.employeeId, normalizedReference)) ||
    employees.find((employee) => fieldAppearsInReference(employee.zohoId, normalizedReference)) ||
    employees.find((employee) => fieldAppearsInReference(employee.recordId, normalizedReference)) ||
    employees.find((employee) => fieldAppearsInReference(employee.email, normalizedReference)) ||
    employees.find((employee) => fieldAppearsInReference(employee.name, normalizedReference)) ||
    employees.find((employee) => fieldAppearsInReference(employee.firstName, normalizedReference));

  
  if (directMatch) {
    return directMatch;
  }

  if (allowIndexSelection && isPlainNumber) {
    return employees[numberSelection - 1] || null;
  }

  return null;
}

module.exports = {
  normalizeEmployeeRecord,
  normalizeEmployeesResponse,
  compactEmployee,
  formatEmployeeDetails,
  formatEmployeeList,
  formatLeaveReport,
  formatHolidayReport,
  getSalaryComponents,
  getSalarySummaries,
  formatSalaryComponents,
  findEmployeeByReference,
};
