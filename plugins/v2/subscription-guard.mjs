// Staged V2 implementation. Do not load into the V1 service.
// V2 contract: https://opencode.ai/v2/docs/build/plugins/migrate-v1/
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateFinancial } from '../../config/guard-validation.mjs';
import { configuredCodexHome, managedConfigRoot, packageRoot, statePath } from './paths.mjs';

const quotaEnvironment = env => Object.fromEntries([
  'HOME', 'PATH', 'LANG', 'HARNESS_STATE_DIR', 'CODEX_HOME', 'HARNESS_CODEX_BIN', 'HARNESS_PYTHON',
].flatMap(name => env[name] === undefined ? [] : [[name, env[name]]]));
const codexURL = 'https://chatgpt.com/backend-api/codex';
const oauthMethods = new Set(['chatgpt-browser', 'chatgpt-headless']);
const officialPackages = new Set(['@opencode/ai/providers/openai', '@opencode/ai/providers/openai/responses']);
const quotaTimeout = 25000;
const execFileAsync = promisify(execFile);
const quotaErrorCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE',
  'ENOMEM', 'E2BIG', 'ETIMEDOUT', 'ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);
const quotaSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGINT', 'SIGHUP', 'SIGPIPE']);
const quotaTelemetryReasons = new Set(['initialization_failed', 'quota_rpc_failed', 'invalid_response',
  'unexpected_eof', 'timeout', 'executable_missing', 'permission_denied', 'process_io_failed', 'unknown_failure']);

function quotaFailure(error, operation, elapsed, timeout) {
  // Never forward message/stack/cause/stdout/stderr: child errors can contain
  // credentials. Only closed-set metadata may reach the service log.
  // execFileSync exposes an exit value as status, while execFile places it in
  // code. Normalize only a valid numeric process status; named OS codes remain
  // in the separately allowlisted code field below.
  const status = Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255 ? error.status
    : Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 ? error.code : null;
  const code = quotaErrorCodes.has(error?.code) ? error.code : null;
  const signal = quotaSignals.has(error?.signal) ? error.signal : null;
  // execFileSync reports ETIMEDOUT; its asynchronous counterpart reports a
  // killed SIGTERM for the same configured deadline. Keep that distinction
  // internal so the service receives the existing closed-set timeout reason.
  const timedOut = code === 'ETIMEDOUT' || (error?.killed === true && signal === 'SIGTERM');
  const reason = timedOut ? 'timeout'
    : code ? 'process_error'
    : signal ? 'terminated'
    : status === 1 && operation === 'check' ? 'policy_denied'
    : status === 2 ? 'telemetry_unavailable' : 'unknown_failure';
  // codex-quota --check exits 1 for admission policy, 2 for failed telemetry.
  // Neither an unavailable check nor a successful --json read proves admission.
  const detail = { operation, reason, status, code, signal, timeout_ms: timeout,
    elapsed_ms: Math.max(0, Math.round(elapsed)) };
  if (status === 2 && (typeof error?.stderr === 'string' || Buffer.isBuffer(error?.stderr))) {
    const match = /^quota unavailable: ([a-z_]+)\n?$/.exec(String(error.stderr));
    if (match && quotaTelemetryReasons.has(match[1])) detail.telemetry_reason = match[1];
  }
  const failure = new Error(`Subscription guard: quota ${operation} failed ${JSON.stringify(detail)}. ` +
    'Admission remains blocked; inspect the process result and run codex-quota --refresh --check. No retry or fallback was attempted.');
  failure.code = 'SUBSCRIPTION_QUOTA_CHECK_FAILED';
  failure.detail = detail;
  return failure;
}

function assertOverrides(value) {
  if (value.package && !officialPackages.has(value.package) ||
      Object.hasOwn(value.settings ?? {}, 'apiKey') ||
      Object.keys(value.headers ?? {}).some(key => /^(authorization|api-key|x-api-key)$/i.test(key)))
    throw new Error('Subscription guard: custom OpenAI credentials/endpoint/SDK overrides are forbidden.');
  if (Object.hasOwn(value.settings ?? {}, 'baseURL')) verifyEndpoint(value.settings.baseURL);
}

function verifyEndpoint(value) {
  // No custom gateway, API endpoint, URL credentials, or non-Codex path.
  let url;
  try { url = new URL(value); } catch { throw new Error('Subscription guard: invalid model endpoint.'); }
  if (url.origin !== 'https://chatgpt.com' ||
      !(url.pathname === '/backend-api/codex' || url.pathname.startsWith('/backend-api/codex/')) ||
      url.username || url.password || url.search || url.hash)
    throw new Error('Subscription guard: custom model endpoint is forbidden.');
}

export function createV2Guard({ readJSON = file => JSON.parse(readFileSync(file, 'utf8')),
  quotaCommand = path.join(packageRoot, 'bin/codex-quota'), quotaDeadline = quotaTimeout,
  runQuota = async (args, opts) => (await execFileAsync(quotaCommand, args, opts)).stdout,
  append = (file, value) => {
    const telemetry = statePath('telemetry');
    mkdirSync(telemetry, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(telemetry, `${file}.jsonl`), JSON.stringify(value) + '\n', { mode: 0o600 });
  }, env = process.env, now = () => new Date().toISOString() } = {}) {
  async function quota(operation) {
    const started = performance.now();
    try {
      return await runQuota([operation === 'check' ? '--check' : '--json'], {
        env: quotaEnvironment(env), timeout: quotaDeadline, encoding: 'utf8', stdio: 'pipe',
      });
    } catch (error) {
      throw quotaFailure(error, operation, performance.now() - started, quotaDeadline);
    }
  }
  async function verify(ctx, event) {
    if (event.model?.providerID !== 'openai') throw new Error('Subscription guard: OpenAI only.');
    // The V2 config provider runs AFTER local plugins. A provider transform cannot
    // certify the final registry: read the effective provider on every request.
    let provider;
    try { provider = (await ctx.provider.get({ providerID: 'openai' })).data; }
    catch { throw new Error('Subscription guard: effective OpenAI provider unavailable.'); }
    if (!provider || !officialPackages.has(provider.package))
      throw new Error('Subscription guard: custom OpenAI credentials/endpoint/SDK overrides are forbidden.');
    assertOverrides(provider);
    let models;
    try { models = (await ctx.model.list()).data; }
    catch { throw new Error('Subscription guard: effective model inventory unavailable.'); }
    if (!Array.isArray(models)) throw new Error('Subscription guard: effective model inventory unavailable.');
    for (const model of models) {
      if (model.providerID !== 'openai') throw new Error('Subscription guard: OpenAI only.');
      assertOverrides(model);
      for (const variant of model.variants ?? []) assertOverrides(variant);
    }
    if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL)
      throw new Error('Subscription guard: API key/base URL present; use the clean opencode launcher.');
    const connection = await ctx.integration.connection.active('openai');
    if (connection?.type !== 'credential' || connection.method !== 'oauth')
      throw new Error('Subscription guard: OpenAI ChatGPT OAuth is required. No API-key fallback.');
    const credential = await ctx.integration.connection.resolve(connection);
    if (credential?.type !== 'oauth' || !oauthMethods.has(credential.methodID))
      throw new Error('Subscription guard: OpenAI ChatGPT OAuth is required. No API-key fallback.');
    const codex = readJSON(path.join(configuredCodexHome, 'auth.json'));
    if (codex.auth_mode !== 'chatgpt' || !credential.metadata?.accountID ||
        credential.metadata.accountID !== codex.tokens?.account_id)
      throw new Error('Subscription guard: OpenCode and quota telemetry must use the same ChatGPT account.');
    validateFinancial(readJSON(path.join(managedConfigRoot, 'financial-verification.json')));
    await quota('check');
  }
  return {
    id: 'subscription.guard',
    async setup(ctx) {
      const steps = new Map();
      await ctx.provider.transform(editor => {
        const provider = editor.get('openai')?.provider;
        if (!provider) return; // A missing provider cannot produce a model request.
        // Throwing here makes Core disable this plugin AND all its request hooks.
        // Drop an unsafe early definition instead; the request hooks check the
        // final inventory, including the later config-provider overlay.
        try {
          if (!officialPackages.has(provider.package)) throw new Error('unsafe package');
          assertOverrides(provider);
        } catch { editor.remove('openai'); }
      });
      await ctx.tool.transform(editor => editor.add({
        name: 'codex_quota', description: 'Read actual Codex quota windows, reset times, pacing and credit risk (30-second cache). No inference or spending.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ content: await quota('read') }),
      }));
      await ctx.session.hook('model.request', async event => {
        if (event.baseURL !== undefined) verifyEndpoint(event.baseURL);
        await verify(ctx, event);
        append('requests', { checked_at: now(), session: event.sessionID, agent: event.agent,
          model: event.model.id, provider: event.model.providerID,
          variant: event.model.variant ?? null, reasoning_effort: null });
      });
      // Validate the resolved transport as well: a later plugin or provider setting can
      // rewrite baseURL after model.request. HTTP and WS are both possible in V2.
      await ctx.session.hook('http.request', async event => {
        await verify(ctx, event);
        verifyEndpoint(event.request.url);
      });
      await ctx.session.hook('experimental.ws.handshake', async event => {
        await verify(ctx, event);
        verifyEndpoint(event.url.replace(/^wss:/, 'https:'));
      });
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            const data = event.data;
            if (event.type === 'session.deleted') {
              for (const key of steps.keys()) if (key.startsWith(`${data.sessionID}\u0000`)) steps.delete(key);
            }
            if (event.type === 'session.step.started') {
              if (steps.size >= 512) steps.delete(steps.keys().next().value);
              steps.set(`${data.sessionID}\u0000${data.assistantMessageID}`, { model: data.model, agent: data.agent });
            }
            if (event.type !== 'session.step.ended') continue;
            const key = `${data.sessionID}\u0000${data.assistantMessageID}`;
            const step = steps.get(key); steps.delete(key);
            if (!step) continue;
            append('completions', { recorded_at: now(), message_id: data.assistantMessageID, session_id: data.sessionID,
              model: step.model.id, provider: step.model.providerID, agent: step.agent,
              tokens: data.tokens, completed_at: event.created });
          }
        } catch (error) { if (!controller.signal.aborted) console.error('subscription telemetry stopped', error); }
      })();
      return () => { controller.abort(); steps.clear(); };
    },
  };
}

export default createV2Guard();
