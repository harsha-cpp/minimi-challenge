// Fetch a JSON configuration secret with the VM identity; never write credentials to disk.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const vault = process.env.ASOF_VAULT;
if (!/^[a-zA-Z0-9-]{3,24}$/.test(vault ?? '')) throw new Error('ASOF_VAULT is required');
for (const name of ['asof.db', 'asof.db.temporal.db', 'provider-spend.db']) {
  if (!existsSync(`/opt/asof/app/data/${name}`)) throw new Error('Reconciled deployment databases are required');
}
async function json(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Configuration service returned ${response.status}`);
  return response.json();
}
try {
  const token = await json('http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net', { Metadata: 'true' });
  const secret = await json(`https://${vault}.vault.azure.net/secrets/asof-config?api-version=7.4`, { Authorization: `Bearer ${token.access_token}` });
  const config = JSON.parse(secret.value);
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Invalid config');
  const permitted = new Set(['PORT','DB_PATH','DEPLOYMENT_MODE','ALLOWED_ORIGINS','OWNER_TOKENS','LLM_API_KEY','LLM_BASE_URL','LLM_MODEL','LLM_FAST_MODEL','LLM_API_MODE','LLM_REASONING_EFFORT','INPUT_DOLLARS_PER_MILLION','OUTPUT_DOLLARS_PER_MILLION','MODEL_PRICE_VERSION','MODEL_DEPLOYMENT_PRICES_JSON','SEARCH_MAX_ATTEMPT_DOLLARS','EXA_API_KEY','AZURE_TOTAL_BUDGET_DOLLARS','EXA_TOTAL_BUDGET_DOLLARS',
    'LLM_TOKEN_LIMIT_PARAMETER','LLM_STREAM_USAGE','MAX_ACTIVE_TURNS','MAX_QUEUED_TURNS','MAX_ACTIVE_MODELS','MAX_QUEUED_MODELS','MODEL_REQUESTS_PER_MINUTE','MODEL_TOKENS_PER_MINUTE','MODEL_COMPLETION_REQUEST_RESERVE','MODEL_COMPLETION_TOKEN_RESERVE','TURN_TIMEOUT_MS','MAX_TURN_MODEL_CALLS','MAX_TURN_TOKENS','MAX_OUTPUT_TOKENS','MAX_TURN_DOLLARS','SHUTDOWN_MS','TRACE_RETENTION_DAYS','RETRIEVAL_PROFILES']);
  for (const [key,value] of Object.entries(config)) if (!permitted.has(key) || typeof value !== 'string') throw new Error('Invalid configuration field');
  if (config.DEPLOYMENT_MODE !== 'hosted') throw new Error('Hosted access policy required');
  if (config.DB_PATH !== 'data/asof.db' || config.PORT !== '3000') throw new Error('Hosted storage and proxy paths must match');
  const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: '/opt/asof/app', env: { ...process.env, ...config }, stdio: 'inherit' });
  for (const sig of ['SIGTERM','SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch { console.error('Unable to load hosted configuration; startup stopped.'); process.exitCode = 1; }
