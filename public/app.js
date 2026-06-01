const SESSION_KEY = 'hr-chat-session-id';

const messagesEl = document.querySelector('#messages');
const chatForm = document.querySelector('#chatForm');
const messageInput = document.querySelector('#messageInput');
const connectionStatus = document.querySelector('#connectionStatus');
const statusStrip = document.querySelector('.status-strip');
const resetChat = document.querySelector('#resetChat');
const sessionLabel = document.querySelector('#sessionLabel');
const accountName = document.querySelector('#accountName');
const signInButton = document.querySelector('#signInButton');
const logoutButton = document.querySelector('#logoutButton');
const quickActionButtons = [...document.querySelectorAll('.quick-action')];

const quickLabels = {
  details: 'Get details',
  leave: 'Leave report',
  salary: 'Salary details',
  holiday: 'Holidays',
  policies: 'Policies',
};

const state = {
  sessionId: localStorage.getItem(SESSION_KEY) || createSessionId(),
  busy: false,
  authenticated: false,
  auth: null,
};

localStorage.setItem(SESSION_KEY, state.sessionId);
updateSessionLabel();

function createSessionId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateSessionLabel() {
  const name = state.auth?.employee?.name || state.auth?.user?.email || 'Session';
  sessionLabel.textContent = state.authenticated ? name : `Session ${state.sessionId.slice(0, 8)}`;
}

function updateControlState() {
  const disabled = state.busy || !state.authenticated;
  messageInput.disabled = disabled;
  chatForm.querySelector('button').disabled = disabled;
  quickActionButtons.forEach((button) => {
    button.disabled = disabled;
  });
}

function setBusy(isBusy) {
  state.busy = isBusy;
  updateControlState();
}

function setStatus(text, isError = false) {
  connectionStatus.textContent = text;
  statusStrip.classList.toggle('is-error', isError);
}

function setAuthState(auth) {
  state.auth = auth;
  state.authenticated = Boolean(auth?.authenticated);

  const displayName = auth?.employee?.name || auth?.user?.name || auth?.user?.email || 'Not signed in';
  accountName.textContent = state.authenticated ? displayName : 'Not signed in';
  signInButton.hidden = state.authenticated;
  logoutButton.hidden = !state.authenticated;
  updateSessionLabel();
  updateControlState();
}

function appendSignInPrompt() {
  messagesEl.replaceChildren();
  appendMessage('assistant', 'Sign in with Zoho to fetch your own HR details, leave report, and holidays.');
}

function appendMessage(role, text, payload = {}) {
  const messageEl = document.createElement('article');
  messageEl.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'YOU' : 'HR';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const messageText = document.createElement('p');
  messageText.className = 'bubble-text';
  messageText.textContent = text;
  bubble.appendChild(messageText);

  if (payload.options?.length) {
    bubble.appendChild(renderOptions(payload.options));
  }

  if (payload.data?.leaveReport?.leavetypes?.length) {
    bubble.appendChild(renderLeaveReport(payload.data.leaveReport));
  }

  if (payload.data?.holidays?.data?.length) {
    bubble.appendChild(renderHolidays(payload.data.holidays.data));
  }

  if (payload.data?.salary) {
    bubble.appendChild(renderSalaryComponents(payload.data.salary));
  }

  messageEl.append(avatar, bubble);
  messagesEl.appendChild(messageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  return messageEl;
}

function appendTyping() {
  const typing = appendMessage('assistant', 'Thinking...');
  typing.classList.add('typing');
  return typing;
}

function renderOptions(options) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-options';

  options.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option-button';

    const label = document.createElement('span');
    label.className = 'option-label';
    label.textContent = option.label;
    button.appendChild(label);

    if (option.description) {
      const description = document.createElement('span');
      description.className = 'option-description';
      description.textContent = option.description;
      button.appendChild(description);
    }

    button.addEventListener('click', () => {
      sendToAssistant(option.label, option.action, { appendUser: true });
    });

    wrapper.appendChild(button);
  });

  return wrapper;
}

function renderLeaveReport(report) {
  const wrapper = document.createElement('div');
  wrapper.className = 'data-grid';

  report.leavetypes.forEach((leave) => {
    const row = document.createElement('div');
    row.className = 'leave-row';
    row.style.borderLeft = `4px solid ${leave.leavetypeColor || '#0f766e'}`;

    const info = document.createElement('div');

    const name = document.createElement('div');
    name.className = 'leave-name';
    name.textContent = `${leave.leavetypeName} (${leave.code})`;

    const meta = document.createElement('div');
    meta.className = 'leave-meta';
    meta.textContent = `Taken ${leave.taken} ${leave.unit || 'Day'} - ${leave.type || ''}`.trim();

    const balance = document.createElement('div');
    balance.className = 'leave-balance';
    balance.textContent = `${leave.available} left`;

    info.append(name, meta);
    row.append(info, balance);
    wrapper.appendChild(row);
  });

  return wrapper;
}

function renderHolidays(holidays) {
  const wrapper = document.createElement('div');
  wrapper.className = 'data-grid';

  holidays.forEach((holiday) => {
    const row = document.createElement('div');
    row.className = 'holiday-row';

    const name = document.createElement('div');
    name.className = 'holiday-name';
    name.textContent = holiday.Name;

    const date = document.createElement('div');
    date.className = 'holiday-date';
    date.textContent = holiday.Date;

    row.append(name, date);
    wrapper.appendChild(row);
  });

  return wrapper;
}

function getSalaryComponents(salary) {
  const result = salary?.response?.result || salary?.result || {};

  if (Array.isArray(result)) {
    return [];
  }

  return result.ctcComponents || result.components || result.data || [];
}

function renderSalaryComponents(salary) {
  const components = getSalaryComponents(salary);
  const wrapper = document.createElement('div');
  wrapper.className = 'data-grid salary-grid';

  if (!components.length) {
    return wrapper;
  }

  components.forEach((component) => {
    const row = document.createElement('div');
    row.className = 'salary-row';

    const info = document.createElement('div');

    const name = document.createElement('div');
    name.className = 'salary-name';
    name.textContent = component.Component_Name || 'Component';

    const meta = document.createElement('div');
    meta.className = 'salary-meta';
    meta.textContent = [component.Component_Category, component.Payment_Type, component.Payment_Frequency]
      .filter(Boolean)
      .join(' - ');

    const amount = document.createElement('div');
    amount.className = 'salary-amount';
    amount.textContent = `Monthly ${component.Monthly || '-'} / Annual ${component.Annually || '-'}`;

    info.append(name, meta);
    row.append(info, amount);
    wrapper.appendChild(row);
  });

  return wrapper;
}

async function sendToAssistant(message, action = null, options = {}) {
  if (state.busy) {
    return;
  }

  if (!state.authenticated) {
    appendSignInPrompt();
    return;
  }

  const shouldAppendUser = options.appendUser !== false && message;

  if (shouldAppendUser) {
    appendMessage('user', message);
  }

  setBusy(true);
  setStatus('Working');
  const typing = appendTyping();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: state.sessionId,
        message,
        action,
      }),
    });

    if (!response.ok) {
      let errorMessage = `Request failed with status ${response.status}`;

      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch (parseError) {
        errorMessage = parseError.message || errorMessage;
      }

      if (response.status === 401) {
        setAuthState({ authenticated: false });
      }

      throw new Error(errorMessage);
    }

    const data = await response.json();
    state.sessionId = data.sessionId || state.sessionId;
    localStorage.setItem(SESSION_KEY, state.sessionId);
    updateSessionLabel();

    typing.remove();
    data.messages.forEach((botMessage) => {
      appendMessage('assistant', botMessage.text, botMessage);
    });

    setStatus('Ready');
  } catch (error) {
    typing.remove();
    appendMessage('assistant', `I could not complete that request. ${error.message}`);
    setStatus(error.message, true);
  } finally {
    setBusy(false);
    messageInput.focus();
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();

  if (!message) {
    return;
  }

  messageInput.value = '';
  sendToAssistant(message);
});

quickActionButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const intent = button.dataset.intent;
    sendToAssistant(quickLabels[intent], { type: 'quick_intent', intent });
  });
});

resetChat.addEventListener('click', () => {
  state.sessionId = createSessionId();
  localStorage.setItem(SESSION_KEY, state.sessionId);
  messagesEl.replaceChildren();
  updateSessionLabel();
  if (state.authenticated) {
    sendToAssistant('', null, { appendUser: false });
  } else {
    appendSignInPrompt();
  }
});

signInButton.addEventListener('click', () => {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/auth/zoho/login?returnTo=${encodeURIComponent(returnTo)}`;
});

logoutButton.addEventListener('click', async () => {
  setBusy(true);

  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } finally {
    state.sessionId = createSessionId();
    localStorage.setItem(SESSION_KEY, state.sessionId);
    setAuthState({ authenticated: false });
    messagesEl.replaceChildren();
    appendSignInPrompt();
    setStatus('Signed out');
    setBusy(false);
  }
});

async function loadAuth() {
  try {
    const response = await fetch('/api/auth/me', {
      credentials: 'same-origin',
    });
    const auth = await response.json();

    setAuthState(auth);

    if (auth.authenticated) {
      setStatus('Ready');
      sendToAssistant('', null, { appendUser: false });
      return;
    }

    setStatus('Sign in required');
    appendSignInPrompt();
  } catch (error) {
    setAuthState({ authenticated: false });
    setStatus(error.message, true);
    appendSignInPrompt();
  }
}

setAuthState({ authenticated: false });
loadAuth();
