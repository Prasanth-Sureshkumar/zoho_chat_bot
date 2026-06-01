#!/usr/bin/env node

require('dotenv').config();

const policyService = require('../src/services/policyService');
const localDbService = require('../src/services/localDbService');

async function main() {
  const dbStatus = localDbService.getBackendInfo();

  if (dbStatus.provider !== 'postgres') {
    throw new Error(`Policy seeding expects Postgres, but DB_PROVIDER is "${dbStatus.provider}".`);
  }

  await policyService.ensurePolicyDocumentsIngested();
  const policies = await policyService.listPolicies();

  console.log(`Seeded ${policies.length} policy documents into ${dbStatus.tableName}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
