const axios = require('axios');

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3';
const INTENT_LABELS = ['details', 'leave', 'holiday', 'salary', 'attendance', 'policy', 'policy-list', 'unknown'];

function isEnabled() {
  return process.env.ENABLE_OLLAMA_SUMMARY !== 'false';
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getStatus() {
  return {
    enabled: isEnabled(),
    model: process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
    baseUrl: normalizeBaseUrl(process.env.OLLAMA_BASE_URL),
  };
}

function parseOllamaGenerateResponse(payload) {
  if (!payload) {
    return null;
  }

  if (typeof payload === 'object') {
    return String(payload.response || '').trim() || null;
  }

  const raw = String(payload).trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return String(parsed.response || '').trim() || null;
  } catch (error) {
    const content = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line).response || '';
        } catch (parseError) {
          return '';
        }
      })
      .join('')
      .trim();

    return content || null;
  }
}

function buildPrompt({ intent, question, title, source, content }) {
  const label = title || intent || 'HR data';
  const sourceText = source ? `\nSource: ${source}` : '';

  return `
You are an HR assistant. Summarize the provided HR information into a clear answer for the employee.

Rules:
- Use only the supplied HR information.
- Keep it concise and easy to read.
- Return no more than 4 short lines.
- If the user describes a personal situation or concern, acknowledge it briefly and professionally.
- Preserve important names, employee IDs, leave balances, dates, and policy source details.
- If the supplied information does not contain the answer, say the information is not available.
- Return plain text only.

User request: ${question || label}
Topic: ${label}${sourceText}

HR information:
${content}
`.trim();
}

function formatPolicyContext(policies = []) {
  if (!Array.isArray(policies) || !policies.length) {
    return 'No configured policies were supplied.';
  }

  return policies
    .map((policy) => `- ${policy.title} (${policy.category})`)
    .join('\n');
}

function buildIntentPrompt(message, context = {}) {
  const policyContext = formatPolicyContext(context.policies);

  return `
You are an HR intent classifier.

Classify the user message into exactly one of these intents:
- details
- leave
- holiday
- salary
- attendance
- policy
- policy-list
- unknown

Rules:
- Return JSON only.
- Use "policy-list" only when the user is asking to show or list policies.
- Use "policy" when the user is asking about a specific policy, HR rule, eligibility, process, approval, or a life-event situation that should be answered from company policy.
- Use "details" only when the user wants an employee/user profile or employee record details, including questions like "who is Sarath" or "tell me about Priya".
- Use "leave" when the user asks about leave balance, leave report, time off, vacation, or remaining days.
- Use "holiday" when the user asks about holidays or holiday calendars.
- Use "salary" when the user asks to view salary, CTC, compensation, pay structure, or salary components.
- Use "attendance" when the user is asking to check in, check out, punch in, punch out, clock in, clock out, or mark attendance.
- Use "unknown" if the message does not clearly fit one of the above.
- If the user says they are pregnant, expecting a baby, resigning, working remotely, missing a punch, claiming an expense, or asking about payroll rules, classify it as "policy".
- If the user asks about salary policy or compensation rules, classify it as "policy", not "salary".
- If the user asks for "policy details", classify it as "policy", not "details".
- Capture the user's emotion/context in short neutral words when present.

Return this exact shape:
{"intent":"policy","confidence":"high","target":"Maternity Leave Policy","emotion":"concerned","context":"pregnancy and maternity leave","reason":"short reason"}

Available policies:
${policyContext}

User message:
${message}
`.trim();
}

function parseIntentResponse(content) {
  if (!content) {
    return null;
  }

  const raw = String(content).trim();
  if (!raw) {
    return null;
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : raw;

  try {
    const parsed = JSON.parse(candidate);
    const intent = INTENT_LABELS.includes(parsed.intent) ? parsed.intent : 'unknown';

    return {
      intent,
      confidence: parsed.confidence || null,
      target: parsed.target || parsed.policy || parsed.policyTitle || parsed.matchedPolicyTitle || null,
      emotion: parsed.emotion || null,
      context: parsed.context || null,
      reason: parsed.reason || null,
      raw,
    };
  } catch (error) {
    return null;
  }
}

async function generateText(prompt, { intent = 'hr', temperature = 0.2, numPredict = 160 } = {}) {
  const status = getStatus();

  if (!status.enabled) {
    return {
      content: null,
      source: 'disabled',
    };
  }

  if (process.env.NODE_ENV !== 'test') {
    console.log(`[AI] ${intent} request -> Ollama model=${status.model}`);
  }

  try {
    const response = await axios.post(
      `${status.baseUrl}/api/generate`,
      {
        model: status.model,
        prompt,
        stream: false,
        options: {
          temperature,
          num_predict: numPredict,
        },
      },
      {
        responseType: 'text',
        timeout: toPositiveInteger(process.env.OLLAMA_TIMEOUT_MS, 120000),
      }
    );

    const content = parseOllamaGenerateResponse(response.data);

    if (process.env.NODE_ENV !== 'test') {
      console.log(
        `[AI] ${intent} response <- Ollama model=${status.model} contentChars=${content?.length || 0}`
      );
    }

    return {
      content,
      source: content ? 'ollama' : 'empty',
      model: status.model,
    };
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        `[AI] ${intent} fallback <- Ollama code=${error.code || 'unknown'} message="${error.message}"`
      );
    }

    return {
      content: null,
      source: 'error',
      code: error.code || 'ollama_request_failed',
      message: error.message,
    };
  }
}

async function draftHrAnswer(input) {
  return generateText(buildPrompt(input), {
    intent: input.intent,
    temperature: input.temperature,
    numPredict: toPositiveInteger(process.env.OLLAMA_NUM_PREDICT, 160),
  });
}

async function classifyIntent(message, context = {}) {
  const result = await generateText(buildIntentPrompt(message, context), {
    intent: 'intent',
    temperature: 0,
    numPredict: toPositiveInteger(process.env.OLLAMA_INTENT_NUM_PREDICT, 64),
  });

  const parsed = parseIntentResponse(result?.content);

  if (!parsed) {
    return {
      intent: null,
      source: result?.source || 'error',
      model: result?.model,
      raw: result?.content || null,
    };
  }

  return {
    ...parsed,
    source: result?.source || 'ollama',
    model: result?.model,
  };
}

async function draftPolicyAnswer(question, policy) {
  return draftHrAnswer({
    intent: 'policy',
    question,
    title: policy.title,
    source: policy.source,
    content: `Retrieved vector DB policy document only.\nPolicy title: ${policy.title}\nPolicy source: ${policy.source}\n${policy.content}`,
  });
}

module.exports = {
  isEnabled,
  getStatus,
  parseOllamaGenerateResponse,
  parseIntentResponse,
  draftHrAnswer,
  draftPolicyAnswer,
  classifyIntent,
};
