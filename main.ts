// The entry <-> env lifecycle. The harness contract (env/src/wire.ts) is:
// bind an ephemeral port, register it with the env, then poll the env's /done
// until it answers true and exit 0. The env owns port 8080; the entry must
// never bind it. This file is the forge's own implementation of that contract;
// the server it boots lives in app.ts.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nobody to
//      register with, so the process exits 1 immediately.
//   2. createApp() builds the HTTP server; listen(0) lets the kernel choose a
//      free port.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N} tells the env where to dial.
//      The first registration wins: a 409 is as good as a 200 here. A 400 or
//      405 is a contract error and ends the program; anything else (the env
//      may still be starting) is retried with backoff.
//   4. GET $MAKEFUN_ENV_URL/done answers at once with {"done": false} while
//      the trial runs and {"done": true} when it ends. Poll it with backoff
//      and never exit before it says true.
//   5. On done: close the server and exit 0, so the harness can read the
//      export the env writes.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff between retries: starts here, doubles, and never exceeds the cap. */
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after `failures` failed attempts: exponential, capped. */
function backoff(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(failures, 8));
}

/** Register the bound port with the env, retrying while the env is unreachable. */
async function registerPort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let fatal = false;
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        process.stderr.write(`[entry] register answered HTTP ${res.status}: ${await res.text()}\n`);
        fatal = true;
      }
    } catch {
      // The env is not answering yet: that is a retry, not an ending.
    }
    if (fatal) throw new Error('register refused by the env');
    await delay(backoff(failures));
  }
}

/** Poll /done until the env ends the trial; never returns before that. */
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        failures = 0;
      }
    } catch {
      // A failed poll only means the env is not done (or not up) yet.
    }
    await delay(backoff(failures));
  }
}

/** The whole life of the process: bind, register, serve, wait, exit 0. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await registerPort(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
