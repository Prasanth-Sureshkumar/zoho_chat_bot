const crypto = require('crypto');
const localDb = require('./localDbService');

const COLLECTION = 'vectorDocuments';
const VECTOR_SIZE = 256;

const STOP_WORDS = new Set([
  'a',
  'about',
  'and',
  'are',
  'as',
  'be',
  'can',
  'details',
  'do',
  'for',
  'from',
  'get',
  'give',
  'help',
  'hr',
  'i',
  'in',
  'info',
  'information',
  'is',
  'it',
  'me',
  'my',
  'need',
  'of',
  'on',
  'or',
  'policy',
  'rule',
  'rules',
  'show',
  'that',
  'the',
  'this',
  'to',
  'want',
  'what',
  'when',
  'with',
]);

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

function hashToken(token) {
  const digest = crypto.createHash('sha256').update(token).digest();
  return digest.readUInt32BE(0) % VECTOR_SIZE;
}

function createVector(text = '') {
  const vector = new Array(VECTOR_SIZE).fill(0);
  const tokens = tokenize(text);

  tokens.forEach((token) => {
    vector[hashToken(token)] += 1;
  });

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function cosineSimilarity(left = [], right = []) {
  const length = Math.min(left.length, right.length);
  let score = 0;

  for (let index = 0; index < length; index += 1) {
    score += Number(left[index] || 0) * Number(right[index] || 0);
  }

  return score;
}

function toVectorDocument(document) {
  const text = [
    document.title,
    document.category,
    document.source,
    document.keywords,
    document.content,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    id: document.id,
    title: document.title,
    category: document.category,
    source: document.source,
    content: document.content,
    keywords: document.keywords || '',
    vector: createVector(text),
    ingestedAt: Date.now(),
  };
}

async function ingestDocuments(documents = []) {
  const existing = await localDb.getCollection(COLLECTION);
  const nextCollection = { ...existing };

  documents.forEach((document) => {
    if (!document.id || !document.content) {
      return;
    }

    nextCollection[document.id] = toVectorDocument(document);
  });

  await localDb.replaceCollection(COLLECTION, nextCollection);
  return Object.values(nextCollection);
}

async function listDocuments() {
  return Object.values(await localDb.getCollection(COLLECTION));
}

async function search(query, { topK = 3, minScore = 0.08 } = {}) {
  const queryTokens = tokenize(query);

  if (!queryTokens.length) {
    return [];
  }

  const queryVector = createVector(query);
  const documents = await listDocuments();

  return documents
    .map((document) => ({
      ...document,
      score: cosineSimilarity(queryVector, document.vector),
    }))
    .filter((document) => document.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

module.exports = {
  ingestDocuments,
  listDocuments,
  search,
  tokenize,
  createVector,
  cosineSimilarity,
};
