// Fetch a JSON configuration secret with the VM identity; never write credentials to disk.
import { spawn } from 'node:child_process';
const vault = process.env.ASOF_VAULT;
if (!/^[a-zA-Z0-9-]{3,24}$/.test(vault ?? '')) throw new Error('ASOF_VAULT is required');
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
  const permitted = new Set(['PORT','DB_PATH','DEPLOYMENT_MODE','ALLOWED_ORIGINS','OWNER_TOKENS','LLM_API_KEY','LLM_BASE_URL','LLM_MODEL','LLM_FAST_MODEL','LLM_API_MODE','LLM_REASONING_EFFORT','INPUT_DOLLARS_PER_MILLION','OUTPUT_DOLLARS_PER_MILLION','MODEL_PRICE_VERSION','MODEL_DEPLOYMENT_PRICES_JSON','SEARCH_MAX_ATTEMPT_DOLLARS','EXA_API_KEY','AZURE_TOTAL_BUDGET_DOLLARS','EXA_TOTAL_BUDGET_DOLLARS']);
  for (const [key,value] of Object.entries(config)) if (!permitted.has(key) || typeof value !== 'string') throw new Error('Invalid configuration field');
  if (config.DEPLOYMENT_MODE !== 'hosted') throw new Error('Hosted access policy required');
  const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: '/opt/asof/app', env: { ...process.env, ...config }, stdio: 'inherit' });
  for (const sig of ['SIGTERM','SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch { console.error('Unable to load hosted configuration; startup stopped.'); process.exitCode = 1; }
