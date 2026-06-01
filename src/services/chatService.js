const crypto = require('crypto');
const defaultHrDataService = require('./hrDataService');
const defaultPolicyService = require('./policyService');
const defaultLlmService = require('./llmService');
const {
  compactEmployee,
  findEmployeeByReference,
  formatEmployeeDetails,
  formatEmployeeList,
  formatHolidayReport,
  formatLeaveReport,
  formatSalaryComponents,
} = require('../utils/hrFormatters');

const INTENTS = {
  DETAILS: 'details',
  LEAVE: 'leave',
  HOLIDAY: 'holiday',
  SALARY: 'salary',
  ATTENDANCE: 'attendance',
  POLICY: 'policy',
};

const QUICK_ACTION_OPTIONS = [
  {
    label: 'Employee details',
    description: 'View your Zoho employee profile',
    action: {
      type: 'quick_intent',
      intent: INTENTS.DETAILS,
    },
  },
  {
    label: 'Leave report',
    description: 'Check balances and leave taken',
    action: {
      type: 'quick_intent',
      intent: INTENTS.LEAVE,
    },
  },
  {
    label: 'Salary components',
    description: 'View compensation breakup',
    action: {
      type: 'quick_intent',
      intent: INTENTS.SALARY,
    },
  },
  {
    label: 'Check in',
    description: 'Mark your attendance entry',
    action: {
      type: 'quick_intent',
      intent: INTENTS.ATTENDANCE,
      attendanceAction: 'checkin',
    },
  },
  {
    label: 'Check out',
    description: 'Mark your attendance exit',
    action: {
      type: 'quick_intent',
      intent: INTENTS.ATTENDANCE,
      attendanceAction: 'checkout',
    },
  },
  {
    label: 'Holidays',
    description: 'See your holiday calendar',
    action: {
      type: 'quick_intent',
      intent: INTENTS.HOLIDAY,
    },
  },
  {
    label: 'HR policies',
    description: 'Ask from the policy vector DB',
    action: {
      type: 'quick_intent',
      intent: 'policies',
    },
  },
];

class ChatService {
  constructor({
    hrDataService = defaultHrDataService,
    policyService = defaultPolicyService,
    llmService = defaultLlmService,
  } = {}) {
    this.hrDataService = hrDataService;
    this.policyService = policyService;
    this.llmService = llmService;
    this.sessions = new Map();
  }

  async handleMessage({
    sessionId,
    message = '',
    action = null,
    authContext = null,
    currentUser = null,
    personalMode = false,
  }) {
    const activeSessionId = sessionId || crypto.randomUUID();
    const session = this.getSession(activeSessionId);
    const cleanMessage = String(message || '').trim();
    const requestContext = {
      authContext,
      currentUser,
      personalMode,
    };

    if (action) {
      const response = await this.handleAction(session, action, cleanMessage, requestContext);
      return this.withSession(activeSessionId, response);
    }

    if (!cleanMessage) {
      return this.withSession(activeSessionId, this.greeting());
    }

    const pendingResponse = await this.tryPendingSelection(session, cleanMessage, requestContext);
    if (pendingResponse) {
      return this.withSession(activeSessionId, pendingResponse);
    }

    const route = await this.resolveRoute(cleanMessage);
    const intent = route.intent;

    if (intent === 'policy-list') {
      return this.withSession(activeSessionId, this.policyListResponse());
    }

    if (intent === INTENTS.POLICY) {
      return this.withSession(activeSessionId, await this.policyResponse(cleanMessage, route.target));
    }

    if (intent === INTENTS.ATTENDANCE) {
      return this.withSession(activeSessionId, await this.attendanceResponse(cleanMessage, requestContext));
    }

    if ([INTENTS.DETAILS, INTENTS.LEAVE, INTENTS.HOLIDAY, INTENTS.SALARY].includes(intent)) {
      return this.withSession(
        activeSessionId,
        await this.employeeIntentResponse(intent, cleanMessage, requestContext)
      );
    }

    return this.withSession(activeSessionId, this.fallbackResponse());
  }

  getSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {});
    }

    return this.sessions.get(sessionId);
  }

  withSession(sessionId, response) {
    const session = this.getSession(sessionId);

    if (response.state) {
      Object.assign(session, response.state);
    }

    const { state, ...publicResponse } = response;

    return {
      sessionId,
      ...publicResponse,
    };
  }

  bot(text, extra = {}) {
    return {
      role: 'assistant',
      text,
      ...extra,
    };
  }

  greeting() {
    return {
      messages: [
        this.bot(
          'Hi, I can help with employee details, leave reports, salary components, check-in/out, holidays, and HR policies.',
          {
            options: QUICK_ACTION_OPTIONS,
          }
        ),
      ],
    };
  }

  fallbackResponse() {
    return {
      messages: [
        this.bot(
          'I can help with employee details, leave reports, holidays, salary components, check-in/out, and HR policies. Try "my details", "leave report", "salary", "check in", "check out", "holidays", or "payroll policy".'
        ),
      ],
    };
  }

  detectIntent(message) {
    const text = message.toLowerCase();

    if (text.includes('list policies') || text.includes('show policies') || text === 'policies') {
      return 'policy-list';
    }

    if (this.isSalaryQuestion(text)) {
      return INTENTS.SALARY;
    }

    if (this.isAttendancePunch(text)) {
      return INTENTS.ATTENDANCE;
    }

    if (this.policyService.isPolicyQuestion(message)) {
      return INTENTS.POLICY;
    }

    if (
      text.includes('leave') ||
      text.includes('balance') ||
      text.includes('time off') ||
      text.includes('vacation')
    ) {
      return INTENTS.LEAVE;
    }

    if (text.includes('holiday') || text.includes('holidays')) {
      return INTENTS.HOLIDAY;
    }

    if (
      text.includes('get details') ||
      text.includes('details') ||
      this.isEmployeeProfileQuestion(text) ||
      text.includes('users') ||
      text.includes('employees') ||
      text.includes('employee list')
    ) {
      return INTENTS.DETAILS;
    }

    return null;
  }

  isSalaryQuestion(text) {
    if (text.includes('policy') || text.includes('rule')) {
      return false;
    }

    return (
      text.includes('salary') ||
      text.includes('ctc') ||
      text.includes('compensation') ||
      text.includes('pay structure') ||
      text.includes('salary component')
    );
  }

  isEmployeeProfileQuestion(text) {
    return (
      /^who\s+(is|are)\s+[\w\s.'-]+$/.test(text) ||
      /^who's\s+[\w\s.'-]+$/.test(text) ||
      /^tell me about\s+[\w\s.'-]+$/.test(text) ||
      /^profile\s+(for|of)\s+[\w\s.'-]+$/.test(text) ||
      /^show\s+profile\s+(for|of)\s+[\w\s.'-]+$/.test(text)
    );
  }

  isAttendancePunch(text) {
    return (
      /\b(check\s*-?\s*in|clock\s*-?\s*in|punch\s*-?\s*in)\b/.test(text) ||
      /\b(check\s*-?\s*out|clock\s*-?\s*out|punch\s*-?\s*out)\b/.test(text)
    );
  }

  isLeaveApplication(text) {
    return (
      /\bapply\s+leave\b/.test(text) ||
      /\brequest\s+leave\b/.test(text) ||
      /\bbook\s+leave\b/.test(text) ||
      /\btake\s+leave\b/.test(text)
    );
  }

  getAttendanceAction(text) {
    if (/\b(check\s*-?\s*out|clock\s*-?\s*out|punch\s*-?\s*out)\b/.test(text)) {
      return 'checkout';
    }

    if (/\b(check\s*-?\s*in|clock\s*-?\s*in|punch\s*-?\s*in)\b/.test(text)) {
      return 'checkin';
    }

    return null;
  }

  async resolveRoute(message) {
    const localIntent = this.detectIntent(message);
    const policies =
      typeof this.policyService.listPolicies === 'function'
        ? await this.policyService.listPolicies()
        : [];

    if (typeof this.llmService.classifyIntent === 'function') {
      const llmIntent = await this.llmService.classifyIntent(message, { policies });

      if (llmIntent?.intent && llmIntent.intent !== 'unknown') {
        const reconciledIntent = this.reconcileIntent(message, llmIntent.intent, localIntent);

        if (process.env.NODE_ENV !== 'test') {
          const routedBy =
            reconciledIntent === llmIntent.intent ? 'ollama' : `ollama+policy-guard:${llmIntent.intent}->${reconciledIntent}`;
          console.log(
            `[Chat] intent=${reconciledIntent} classifiedBy=${routedBy} confidence=${llmIntent.confidence || 'unknown'} target="${llmIntent.target || ''}" emotion="${llmIntent.emotion || ''}" context="${llmIntent.context || ''}" reason="${llmIntent.reason || ''}"`
          );
        }

        return {
          intent: reconciledIntent,
          target: llmIntent.target || null,
          ai: llmIntent,
        };
      }
    }

    return {
      intent: localIntent,
      target: null,
      ai: null,
    };
  }

  async resolveIntent(message) {
    const route = await this.resolveRoute(message);
    return route.intent;
  }

  reconcileIntent(message, llmIntent, localIntent = null) {
    if (localIntent === 'policy-list' || llmIntent === 'policy-list') {
      return 'policy-list';
    }

    if (localIntent === INTENTS.ATTENDANCE || llmIntent === INTENTS.ATTENDANCE) {
      return INTENTS.ATTENDANCE;
    }

    if (localIntent === INTENTS.SALARY) {
      return INTENTS.SALARY;
    }

    if (this.policyService.isPolicyQuestion(message)) {
      return INTENTS.POLICY;
    }

    return llmIntent || localIntent;
  }

  async handleAction(session, action, displayText, requestContext = {}) {
    if (action.type === 'quick_intent') {
      if (action.intent === 'policies') {
        return this.policyListResponse();
      }

      if (action.intent === INTENTS.ATTENDANCE) {
        return this.attendanceResponse(displayText || action.intent, {
          ...requestContext,
          attendanceAction: action.attendanceAction || null,
        });
      }

      return this.employeeIntentResponse(action.intent, displayText || action.intent, requestContext);
    }

    if (action.type === 'employee_select') {
      return this.employeeSelectedResponse(session, action.intent, action.employeeId, displayText, requestContext);
    }

    if (action.type === 'policy_select') {
      const policy =
        typeof this.policyService.findPolicyByTitle === 'function'
          ? await this.policyService.findPolicyByTitle(action.title)
          : this.policyService.policies.find((item) => item.title === action.title);
      if (!policy) {
        return this.policyListResponse();
      }

      return this.policyAnswerFromPolicy(displayText || policy.title, policy);
    }

    return this.fallbackResponse();
  }

  async tryPendingSelection(session, message, requestContext = {}) {
    if (!session.pendingIntent || !session.candidates?.length) {
      return null;
    }

    const selectedEmployee = findEmployeeByReference(session.candidates, message, {
      allowIndexSelection: true,
      preferIndexSelection: true,
    });

    if (!selectedEmployee) {
      return null;
    }

    return this.employeeSelectedResponse(
      session,
      session.pendingIntent,
      selectedEmployee.employeeId,
      message,
      requestContext
    );
  }

  async employeeIntentResponse(intent, message, requestContext = {}) {
    if (requestContext.personalMode) {
      const employee = await this.getCurrentEmployee(requestContext);

      if (!employee) {
        return this.currentEmployeeNotFoundResponse();
      }

      return this.employeeSelectedResponse(
        {},
        intent,
        employee.employeeId || employee.email || employee.zohoId,
        message,
        {
          ...requestContext,
          currentEmployee: employee,
        }
      );
    }

    const employees = await this.hrDataService.getEmployees();
    const mentionedEmployee = this.findEmployeeMention(employees, message);

    if (mentionedEmployee) {
      if (process.env.NODE_ENV !== 'test') {
        console.log(
          `[Chat] intent=${intent} matchedEmployee="${mentionedEmployee.name}" employeeId="${mentionedEmployee.employeeId}"`
        );
      }

      return this.employeeSelectedResponse({}, intent, mentionedEmployee.employeeId, message, requestContext);
    }

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[Chat] intent=${intent} no direct employee match; asking user to select`);
    }

    return this.askForEmployee(intent, employees);
  }

  async employeeSelectedResponse(session, intent, employeeId, question = '', requestContext = {}) {
    const employee =
      requestContext.currentEmployee ||
      (await this.hrDataService.getEmployeeById(employeeId, {
        authContext: requestContext.authContext,
      }));

    if (!employee) {
      const employees = await this.hrDataService.getEmployees({
        authContext: requestContext.authContext,
      });
      return this.askForEmployee(intent, employees, 'I could not find that employee. Select one from this list.');
    }

    session.pendingIntent = null;
    session.candidates = [];

    if (intent === INTENTS.DETAILS) {
      const text = formatEmployeeDetails(employee);

      return {
        messages: [
          await this.summarizedBot({
            intent,
            question: question || `Employee details for ${employee.name}`,
            title: `Employee details for ${employee.name}`,
            text,
            data: { employee: compactEmployee(employee) },
          }),
        ],
      };
    }

    if (intent === INTENTS.LEAVE) {
      if (this.isLeaveApplication(String(question || '').toLowerCase())) {
        const leaveRequest = await this.hrDataService.applyLeaveFromMessage(employee, question, {
          authContext: requestContext.authContext,
        });

        const leaveTypeName =
          leaveRequest.leaveType?.leavetypeName || leaveRequest.leaveType?.name || 'Selected leave type';
        const fromDate = leaveRequest.request?.fromDate;
        const toDate = leaveRequest.request?.toDate;
        const dateText = fromDate === toDate ? fromDate : `${fromDate} to ${toDate}`;

        return {
          messages: [
            this.bot(`Leave request submitted for ${employee.name}: ${leaveTypeName} on ${dateText}.`, {
              data: {
                employee: compactEmployee(employee),
                leaveRequest,
              },
            }),
          ],
        };
      }

      const report = await this.hrDataService.getLeaveReport(employee, {
        authContext: requestContext.authContext,
      });
      const text = report ? formatLeaveReport(report) : `No leave report found for ${employee.name}.`;

      return {
        messages: [
          await this.summarizedBot({
            intent,
            question: question || `Leave report for ${employee.name}`,
            title: `Leave report for ${employee.name}`,
            text,
            data: { employee: compactEmployee(employee), leaveReport: report },
          }),
        ],
      };
    }

    if (intent === INTENTS.HOLIDAY) {
      const holidays = await this.hrDataService.getHolidays(employee, {
        authContext: requestContext.authContext,
      });
      const text = formatHolidayReport(employee, holidays);

      return {
        messages: [
          await this.summarizedBot({
            intent,
            question: question || `Holidays for ${employee.name}`,
            title: `Holidays for ${employee.name}`,
            text,
            data: { employee: compactEmployee(employee), holidays },
          }),
        ],
      };
    }

    if (intent === INTENTS.SALARY) {
      const salary = await this.hrDataService.getSalaryComponents(employee, {
        authContext: requestContext.authContext,
      });
      const text = formatSalaryComponents(employee, salary);

      return {
        messages: [
          this.bot(text, {
            data: {
              employee: compactEmployee(employee),
              salary: {
                response: salary?.response || salary,
                answerSource: 'local-data',
              },
            },
          }),
        ],
      };
    }

    return this.fallbackResponse();
  }

  async attendanceResponse(message, requestContext = {}) {
    const employee = await this.getCurrentEmployee(requestContext);

    if (!employee) {
      return this.currentEmployeeNotFoundResponse();
    }

    const normalizedMessage = String(message || '').toLowerCase();
    const action = requestContext.attendanceAction || this.getAttendanceAction(normalizedMessage) || 'checkin';
    const isCheckOut = action === 'checkout';
    const attendancePayload = isCheckOut ? { checkOut: 'now' } : { checkIn: 'now' };
    const attendanceLabel = isCheckOut ? 'Check-out' : 'Check-in';

    const result = await this.hrDataService.recordAttendance(employee, {
      ...attendancePayload,
      authContext: requestContext.authContext,
    });

    return {
      messages: [
        this.bot(`${attendanceLabel} recorded for ${employee.name}.`, {
          data: {
            employee: compactEmployee(employee),
            attendance: {
              action,
              result,
            },
          },
        }),
      ],
    };
  }

  async getCurrentEmployee(requestContext = {}) {
    if (requestContext.currentEmployee) {
      return requestContext.currentEmployee;
    }

    if (typeof this.hrDataService.getCurrentEmployee !== 'function') {
      return null;
    }

    return this.hrDataService.getCurrentEmployee({
      authContext: requestContext.authContext,
      currentUser: requestContext.currentUser,
    });
  }

  currentEmployeeNotFoundResponse() {
    return {
      messages: [
        this.bot(
          'I could not match your Zoho login to an employee record. Ask HR to confirm that your Zoho account email matches your employee profile email.'
        ),
      ],
    };
  }

  askForEmployee(intent, employees, intro = null) {
    const titleByIntent = {
      [INTENTS.DETAILS]: 'Select a user to view employee details.',
      [INTENTS.LEAVE]: 'Select a user to view leave report.',
      [INTENTS.HOLIDAY]: 'Select a user to view holidays.',
      [INTENTS.SALARY]: 'Select a user to view salary components.',
      [INTENTS.ATTENDANCE]: 'Attendance is recorded for your signed-in account.',
    };

    const text = [intro || titleByIntent[intent], formatEmployeeList(employees)].join('\n\n');
    const options = employees.map((employee) => ({
      label: employee.name,
      description: [employee.employeeId, employee.department].filter(Boolean).join(' - '),
      action: {
        type: 'employee_select',
        intent,
        employeeId: employee.employeeId,
      },
    }));

    return {
      messages: [
        this.bot(text, {
          options,
          data: {
            employees: employees.map(compactEmployee),
          },
        }),
      ],
      state: {
        pendingIntent: intent,
        candidates: employees,
      },
    };
  }

  async policyResponse(message, target = null) {
    const policy =
      (target && typeof this.policyService.findPolicyByTitle === 'function'
        ? await this.policyService.findPolicyByTitle(target)
        : null) ||
      (typeof this.policyService.findPolicyForQuestion === 'function'
        ? await this.policyService.findPolicyForQuestion(message)
        : null);

    if (!policy) {
      return this.policyListResponse('Select a policy so I can answer from that source.');
    }

    return this.policyAnswerFromPolicy(message, policy);
  }

  async policyAnswerFromPolicy(question, policy) {
    const llmResult =
      typeof this.llmService.draftPolicyAnswer === 'function'
        ? await this.llmService.draftPolicyAnswer(question, policy)
        : await this.draftHrAnswer({
            intent: INTENTS.POLICY,
            question,
            title: policy.title,
            source: policy.source,
            text: policy.content,
          });
    const llmAnswer =
      typeof llmResult === 'string' ? llmResult : llmResult?.content;
    const answerSource = llmAnswer ? 'ollama-from-vector-db' : 'vector-db';
    const answer = llmAnswer ? this.withPolicySource(llmAnswer, policy.source) : this.policyService.formatPolicyAnswer(policy);

    if (process.env.NODE_ENV !== 'test') {
      console.log(
        `[Chat] policy="${policy.title}" aiStatus=${llmResult?.source || 'not-called'} answerSource=${answerSource}`
      );
    }

    return {
      messages: [
        this.bot(answer, {
          data: {
            policy: {
              title: policy.title,
              category: policy.category,
              source: policy.source,
              answerSource,
              aiStatus: llmResult?.source || 'not-called',
              model: llmResult?.model,
            },
          },
        }),
      ],
    };
  }

  async summarizedBot({ intent, question, title, source = null, text, data = {} }) {
    const llmResult = await this.draftHrAnswer({
      intent,
      question,
      title,
      source,
      text,
    });
    const llmAnswer =
      typeof llmResult === 'string' ? llmResult : llmResult?.content;
    const answerSource = llmAnswer ? 'ollama' : 'local-data';

    if (process.env.NODE_ENV !== 'test') {
      console.log(
        `[Chat] intent=${intent} aiStatus=${llmResult?.source || 'not-called'} answerSource=${answerSource}`
      );
    }

    return this.bot(llmAnswer || text, {
      data: {
        ...data,
        ai: {
          answerSource,
          status: llmResult?.source || 'not-called',
          model: llmResult?.model,
        },
      },
    });
  }

  async draftHrAnswer({ intent, question, title, source, text }) {
    if (typeof this.llmService.draftHrAnswer !== 'function') {
      return null;
    }

    return this.llmService.draftHrAnswer({
      intent,
      question,
      title,
      source,
      content: text,
    });
  }

  withPolicySource(answer, source) {
    if (!source || answer.toLowerCase().includes('source:')) {
      return answer;
    }

    return `${answer}\nSource: ${source}`;
  }

  async policyListResponse(intro = 'Select a policy.') {
    const policies =
      typeof this.policyService.listPolicies === 'function'
        ? await this.policyService.listPolicies()
        : [];

    return {
      messages: [
        this.bot(
          [intro, policies.map((policy, index) => `${index + 1}. ${policy.title}`).join('\n')].join('\n\n'),
          {
            options: policies.map((policy) => ({
              label: policy.title,
              description: policy.category,
              action: {
                type: 'policy_select',
                title: policy.title,
              },
            })),
            data: { policies },
          }
        ),
      ],
    };
  }

  findEmployeeMention(employees, message) {
    const text = message.toLowerCase();
    const directMatch = findEmployeeByReference(employees, message);

    if (directMatch) {
      return directMatch;
    }

    return (
      employees.find((employee) => text.includes(employee.employeeId.toLowerCase())) ||
      employees.find((employee) => text.includes(employee.name.toLowerCase())) ||
      employees.find((employee) => employee.firstName && text.includes(employee.firstName.toLowerCase())) ||
      null
    );
  }
}

module.exports = {
  ChatService,
  INTENTS,
};
