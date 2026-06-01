import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import logo from './assets/logo.png';

const SESSION_KEY = 'hr-chat-session-id';

function createSessionId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getInitialSessionId() {
  const existing = window.localStorage.getItem(SESSION_KEY);
  const nextSessionId = existing || createSessionId();
  window.localStorage.setItem(SESSION_KEY, nextSessionId);
  return nextSessionId;
}

function SignInPrompt() {
  return {
    role: 'assistant',
    text: 'Sign in with Zoho to fetch your own HR details, leave report, salary components, holidays, and policies.',
  };
}

function TypingMessage() {
  return {
    role: 'assistant',
    text: 'Thinking...',
    typing: true,
  };
}

function App() {
  const [sessionId, setSessionId] = useState(getInitialSessionId);
  const [messages, setMessages] = useState([]);
  const [auth, setAuth] = useState({ authenticated: false });
  const [status, setStatus] = useState({ text: 'Ready', isError: false });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const messagesEndRef = useRef(null);

  const authenticated = Boolean(auth?.authenticated);
  const displayName =
    auth?.employee?.name || auth?.user?.name || auth?.user?.email || 'Not signed in';
  const sessionLabel = authenticated
    ? auth?.employee?.name || auth?.user?.email
    : `Session ${sessionId.slice(0, 8)}`;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  useEffect(() => {
    loadAuth();
  }, []);

  function persistSession(nextSessionId) {
    setSessionId(nextSessionId);
    window.localStorage.setItem(SESSION_KEY, nextSessionId);
  }

  function setReady(text = 'Ready') {
    setStatus({ text, isError: false });
  }

  function setError(text) {
    setStatus({ text, isError: true });
  }

  async function loadAuth() {
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'same-origin',
      });
      const nextAuth = await response.json();

      setAuth(nextAuth);

      if (nextAuth.authenticated) {
        setReady();
        await sendToAssistant('', null, {
          appendUser: false,
          forceAuthenticated: true,
        });
        return;
      }

      setReady('Sign in required');
      setMessages([SignInPrompt()]);
    } catch (error) {
      setAuth({ authenticated: false });
      setError(error.message);
      setMessages([SignInPrompt()]);
    }
  }

  async function sendToAssistant(message, action = null, options = {}) {
    if (busy) {
      return;
    }

    if (!authenticated && !options.forceAuthenticated) {
      setMessages([SignInPrompt()]);
      setReady('Sign in required');
      return;
    }

    const shouldAppendUser = options.appendUser !== false && Boolean(message);
    const typing = TypingMessage();
    const activeSessionId = options.sessionIdOverride || sessionId;

    setBusy(true);
    setReady('Working');
    setMessages((current) => [
      ...current,
      ...(shouldAppendUser ? [{ role: 'user', text: message }] : []),
      typing,
    ]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: activeSessionId,
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
          setAuth({ authenticated: false });
        }

        throw new Error(errorMessage);
      }

      const data = await response.json();
      persistSession(data.sessionId || activeSessionId);
      setMessages((current) => [
        ...current.filter((item) => item !== typing),
        ...(data.messages || []).map((item) => ({
          ...item,
          role: item.role || 'assistant',
        })),
      ]);
      setReady();
    } catch (error) {
      setMessages((current) => [
        ...current.filter((item) => item !== typing),
        {
          role: 'assistant',
          text: `I could not complete that request. ${error.message}`,
        },
      ]);
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    const message = draft.trim();

    if (!message) {
      return;
    }

    setDraft('');
    sendToAssistant(message);
  }

  function handleReset() {
    const nextSessionId = createSessionId();
    persistSession(nextSessionId);
    setMessages([]);

    if (authenticated) {
      sendToAssistant('', null, { appendUser: false, sessionIdOverride: nextSessionId });
    } else {
      setMessages([SignInPrompt()]);
    }
  }

  function handleSignIn() {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.href = `/api/auth/zoho/login?returnTo=${encodeURIComponent(returnTo)}`;
  }

  async function handleLogout() {
    setBusy(true);

    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } finally {
      const nextSessionId = createSessionId();
      persistSession(nextSessionId);
      setAuth({ authenticated: false });
      setMessages([SignInPrompt()]);
      setReady('Signed out');
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <img src={logo} alt="Justo logo" className="brand-mark" />
          <div>
            <h1>Justo HR Assistant</h1>
            <p>{sessionLabel}</p>
          </div>
        </div>

        <div className="account-actions">
          {/* <div className={`status-pill ${status.isError ? 'is-error' : ''}`} aria-live="polite">
            <span aria-hidden="true" />
            {status.text}
          </div> */}
          {/* <div className="account-name" title={displayName}>
            {displayName}
          </div> */}
          {authenticated ? (
            <button type="button" className="secondary-button" onClick={handleLogout} disabled={busy}>
              Sign out
            </button>
          ) : (
            <button type="button" className="primary-button" onClick={handleSignIn}>
              Sign in
            </button>
          )}
          <button type="button" className="icon-button" onClick={handleReset} aria-label="Reset chat">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M20 6v5h-5" />
              <path d="M19 13a7 7 0 1 1-2-5" />
            </svg>
          </button>
        </div>
      </header>

      <section className="chat-panel" aria-label="HR chat">
        <div className="messages" aria-live="polite">
          {messages.map((message, index) => (
            <Message
              key={`${message.role}-${index}-${message.text.slice(0, 16)}`}
              message={message}
              onOption={(option) =>
                sendToAssistant(option.label, option.action, {
                  appendUser: true,
                })
              }
            />
          ))}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy || !authenticated}
            type="text"
            autoComplete="off"
            placeholder="Message HR assistant"
            aria-label="Message HR assistant"
          />
          <button
            type="submit"
            className="send-button"
            disabled={busy || !authenticated || !draft.trim()}
            aria-label="Send message"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m4 12 15-7-5 14-3-6-7-1Z" />
              <path d="m11 13 8-8" />
            </svg>
          </button>
        </form>
      </section>
    </main>
  );
}

function Message({ message, onOption }) {
  return (
    <article className={`message ${message.role || 'assistant'} ${message.typing ? 'typing' : ''}`}>
      <div className="avatar" aria-hidden="true">
        {message.role === 'user' ? 'ME' : 'HR'}
      </div>
      <div className="bubble">
        <p className="bubble-text">{message.text}</p>
        {message.options?.length ? <Options options={message.options} onOption={onOption} /> : null}
        {message.data?.leaveReport?.leavetypes?.length ? (
          <LeaveReport report={message.data.leaveReport} />
        ) : null}
        {message.data?.holidays?.data?.length ? <Holidays holidays={message.data.holidays.data} /> : null}
        {message.data?.salary ? <SalaryComponents salary={message.data.salary} /> : null}
      </div>
    </article>
  );
}

function Options({ options, onOption }) {
  return (
    <div className="message-options">
      {options.map((option) => (
        <button
          key={`${option.label}-${option.description || ''}`}
          type="button"
          className="option-button"
          onClick={() => onOption(option)}
        >
          <span className="option-label">{option.label}</span>
          {option.description ? <span className="option-description">{option.description}</span> : null}
        </button>
      ))}
    </div>
  );
}

function LeaveReport({ report }) {
  return (
    <div className="data-grid">
      {report.leavetypes.map((leave) => (
        <div
          key={`${leave.leavetypeName}-${leave.code}`}
          className="leave-row"
          style={{ borderLeftColor: leave.leavetypeColor || '#0f766e' }}
        >
          <div>
            <div className="leave-name">
              {leave.leavetypeName} ({leave.code})
            </div>
            <div className="leave-meta">
              Taken {leave.taken} {leave.unit || 'Day'} {leave.type || ''}
            </div>
          </div>
          <div className="leave-balance">{leave.available} left</div>
        </div>
      ))}
    </div>
  );
}

function Holidays({ holidays }) {
  return (
    <div className="data-grid">
      {holidays.map((holiday) => (
        <div key={`${holiday.Name}-${holiday.Date}`} className="holiday-row">
          <div className="holiday-name">{holiday.Name}</div>
          <div className="holiday-date">{holiday.Date}</div>
        </div>
      ))}
    </div>
  );
}

function getSalaryComponents(salary) {
  const result = salary?.response?.result || salary?.result || {};

  if (Array.isArray(result)) {
    return [];
  }

  return result.ctcComponents || result.components || result.data || [];
}

function SalaryComponents({ salary }) {
  const components = getSalaryComponents(salary);

  if (!components.length) {
    return null;
  }

  return (
    <div className="data-grid salary-grid">
      {components.map((component, index) => (
        <div key={`${component.Component_Name || 'component'}-${index}`} className="salary-row">
          <div>
            <div className="salary-name">{component.Component_Name || 'Component'}</div>
            <div className="salary-meta">
              {[component.Component_Category, component.Payment_Type, component.Payment_Frequency]
                .filter(Boolean)
                .join(' - ')}
            </div>
          </div>
          <div className="salary-amount">
            Monthly {component.Monthly || '-'} / Annual {component.Annually || '-'}
          </div>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
