// The entry's lifecycle against the trial env. The contract: bind an ephemeral TCP
// port (never 8080, which the env owns), POST {"port": N} to $MAKEFUN_ENV_URL/register,
// then long-poll $MAKEFUN_ENV_URL/done until it answers {"done": true}, and exit 0.
// The HTTP surface itself is built by createApp() in app.ts.
//
// Registration tolerates an env that is still booting (retry with capped backoff) and
// treats a first-registration-wins 409 as success; a 400/405 is a contract error and
// ends the process. The done poll never exits early on a transient failure.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[spark] MAKEFUN_ENV_URL is unset: no env to register with\n');
  process.exit(1);
}

const CALL_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CEIL_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Capped exponential backoff after `failures` consecutive failed attempts. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CEIL_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 8));
}

/** Tell the env which port we bound; retry while it is unreachable, stop on a contract error. */
async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let contractError = false;
    try {
      const response = await fetch(envOrigin + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        process.stderr.write(`[spark] register refused: HTTP ${response.status} ${await response.text()}\n`);
        contractError = true;
      }
    } catch {
      // The env is not answering yet; that is a retry, not an ending.
    }
    if (contractError) throw new Error('the env refused registration');
    await pause(backoffMs(failures));
  }
}

/** Poll /done until the env ends the trial; transient failures only mean "not yet". */
async function waitForDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(envOrigin + '/done', { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
        failures = 0;
      }
    } catch {
      // A failed poll means the env is not done (or not up) yet.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind, register, serve, wait for done, then exit cleanly. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[spark] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[spark] registered; serving until the env says done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[spark] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[spark] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}