const path = require('path');
const express = require('express');
require('dotenv').config();

const apiRoutes = require('./src/routes/apiRoutes');
const llmService = require('./src/services/llmService');
const localDbService = require('./src/services/localDbService');
const zohoAuthService = require('./src/services/zohoAuthService');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRoutes);

function disabledSharedEndpoint(req, res) {
  res.status(410).json({
    success: false,
    error: 'This shared endpoint is disabled. Sign in with Zoho and use the /api personal endpoints.',
  });
}

app.get('/employees', disabledSharedEndpoint);
app.get('/leave-report/:employeeId', disabledSharedEndpoint);
app.get('/holidays/:employeeId', disabledSharedEndpoint);

app.use((error, req, res, next) => {
  console.error('Server Error:', error.response?.data || error.message);
  const statusCode = error.statusCode || 500;

  res.status(statusCode).json({
    success: false,
    error: error.response?.data || error.message,
  });
});

app.listen(port, () => {
  const aiStatus = llmService.getStatus();
  const zohoOAuthConfigured = zohoAuthService.hasZohoOAuthConfig();
  const dbStatus = localDbService.getBackendInfo();

  console.log(`Server running on port ${port}`);
  console.log(`[Config] Database provider=${dbStatus.provider} table=${dbStatus.tableName}`);
  console.log(`[Config] Zoho OAuth login enabled=${zohoOAuthConfigured}`);
  console.log(
    `[Config] Ollama summaries enabled=${aiStatus.enabled} model=${aiStatus.model} baseUrl=${aiStatus.baseUrl}`
  );
});
