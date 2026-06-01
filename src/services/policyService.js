const fs = require('fs');
const path = require('path');
const vectorDbService = require('./vectorDbService');

const POLICY_TEXT_FILE = path.join(__dirname, '../data/hrPoliceis.txt');

function parsePoliciesFromText(raw = '') {
  const sections = String(raw)
    .split(/\n\s*---+\s*\n/g)
    .map((section) => section.trim())
    .filter(Boolean);

  return sections
    .map((section) => {
      const lines = section.split(/\r?\n/);
      const meta = {};
      let contentStart = 0;

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const match = line.match(/^(title|category|source)\s*:\s*(.+)$/i);

        if (!match) {
          contentStart = index;
          break;
        }

        meta[match[1].toLowerCase()] = match[2].trim();
        contentStart = index + 1;
      }

      const content = lines
        .slice(contentStart)
        .join('\n')
        .trim();

      if (!meta.title || !content) {
        return null;
      }

      return {
        title: meta.title,
        category: meta.category || 'general',
        source: meta.source || 'hr-policy-text',
        content,
      };
    })
    .filter(Boolean);
}

function loadPoliciesFromTextFile() {
  if (!fs.existsSync(POLICY_TEXT_FILE)) {
    return [];
  }

  const raw = fs.readFileSync(POLICY_TEXT_FILE, 'utf8');
  return parsePoliciesFromText(raw);
}

const policies = loadPoliciesFromTextFile();

const policyAliases = {
  maternity: [
    'maternity',
    'pregnancy',
    'delivery',
    'childbirth',
    'pregnant',
    'expecting',
    'expecting baby',
    'having a baby',
    'due date',
    'prenatal',
  ],
  reimbursement: ['reimbursement', 'expense', 'claim', 'invoice', 'receipt'],
  attendance: ['attendance', 'late', 'punch', 'regularization', 'early departure'],
  'work from home': ['work from home', 'wfh', 'remote', 'home'],
  payroll: ['payroll', 'salary', 'deduction', 'arrear', 'bank account'],
  notice: ['notice', 'resignation', 'release date', 'final settlement', 'separation'],
};

const STOP_WORDS = new Set([
  'a',
  'about',
  'am',
  'an',
  'and',
  'any',
  'api',
  'are',
  'as',
  'be',
  'can',
  'company',
  'details',
  'do',
  'does',
  'employee',
  'employees',
  'for',
  'from',
  'get',
  'give',
  'has',
  'have',
  'help',
  'hr',
  'i',
  'if',
  'in',
  'info',
  'information',
  'is',
  'it',
  'leave',
  'me',
  'my',
  'need',
  'of',
  'on',
  'or',
  'policy',
  'rule',
  'rules',
  'should',
  'show',
  'that',
  'the',
  'this',
  'to',
  'user',
  'want',
  'what',
  'when',
  'with',
]);

async function listPolicies() {
  await ensurePolicyDocumentsIngested();

  return policies.map((policy) => ({
    title: policy.title,
    category: policy.category,
    source: policy.source,
  }));
}

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value = '') {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function slugify(value = '') {
  return normalizeText(value).replace(/\s+/g, '-');
}

function getPolicyAliases(policy) {
  const normalizedTitle = normalizeText(policy.title);
  const aliasKey = Object.keys(policyAliases).find((key) => normalizedTitle.includes(key));
  return aliasKey ? policyAliases[aliasKey] : [];
}

function buildPolicyDocuments() {
  return policies.map((policy) => ({
    id: `policy-${slugify(policy.title)}`,
    title: policy.title,
    category: policy.category,
    source: policy.source,
    keywords: getPolicyAliases(policy).join(' '),
    content: policy.content,
  }));
}

let policyDocumentsIngestedPromise = null;

async function ensurePolicyDocumentsIngested() {
  if (!policyDocumentsIngestedPromise) {
    policyDocumentsIngestedPromise = (async () => {
      const documents = buildPolicyDocuments();
      const existingIds = new Set((await vectorDbService.listDocuments()).map((document) => document.id));
      const hasAllDocuments = documents.every((document) => existingIds.has(document.id));

      if (!hasAllDocuments || process.env.REINDEX_POLICIES === 'true') {
        await vectorDbService.ingestDocuments(documents);
      }
    })();
  }

  await policyDocumentsIngestedPromise;
}

async function getPolicyDocuments() {
  await ensurePolicyDocumentsIngested();
  const documentsByTitle = new Map(
    (await vectorDbService.listDocuments()).map((document) => [normalizeText(document.title), document])
  );

  return policies
    .map((policy) => documentsByTitle.get(normalizeText(policy.title)))
    .filter(Boolean);
}

async function findPolicyByTitle(title = '') {
  await ensurePolicyDocumentsIngested();
  const normalizedTitle = normalizeText(title);

  if (!normalizedTitle) {
    return null;
  }

  const documents = await getPolicyDocuments();
  return documents.find((policy) => normalizeText(policy.title) === normalizedTitle) || null;
}

async function findPolicyForQuestion(question = '') {
  const text = normalizeText(question);

  if (!text || !tokenize(text).length) {
    return null;
  }

  await ensurePolicyDocumentsIngested();
  const [match] = await vectorDbService.search(text, {
    topK: 1,
    minScore: 0.08,
  });

  return match || null;
}

function isPolicyQuestion(question = '') {
  const text = normalizeText(question);
  const mentionsPolicyLanguage =
    text.includes('policy') ||
    text.includes('rule') ||
    text.includes('rules') ||
    text.includes('eligibility') ||
    text.includes('eligible') ||
    text.includes('approval') ||
    text.includes('process');
  const mentionsPolicyAlias = Object.values(policyAliases).some((aliases) =>
    aliases.some((alias) => text.includes(normalizeText(alias)))
  );

  return (
    mentionsPolicyLanguage ||
    mentionsPolicyAlias
  );
}

function formatPolicyAnswer(policy) {
  return `${policy.title}\n${policy.content}\nSource: ${policy.source}`;
}

module.exports = {
  policies,
  listPolicies,
  findPolicyByTitle,
  findPolicyForQuestion,
  isPolicyQuestion,
  formatPolicyAnswer,
  ensurePolicyDocumentsIngested,
};
