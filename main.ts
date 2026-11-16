// main.ts — how this forge process lives inside one make.fun trial.
//
// The trial harness starts this program next to its environment service
// ("env"). The env is the only client that matters, and the whole lifecycle
// is a short conversation with it:
//
//   1. The env's origin arrives in MAKEFUN_ENV_URL. Without it there is no
//      trial to join, so the program complains on stderr and exits 1.
//   2. The forge server (app.ts) starts on port 0, letting the kernel pick
//      a free port — never a fixed one, and never the env's own port.
//   3. The program tells the env where it ended up: POST /register with a
//      JSON body of {"port": <bound port>}. From then on the env dials that
//      address and drives the forge through the whole suite.
//   4. The program then asks GET /done every so often. The env answers
//      {"done": false} while it is still working and {"done": true} once
//      it has finished and written its export.
//   5. On done, the server closes and the program exits 0.
//
// Steps 3 and 4 are patient by design: a failed request — refused,
// answered 409 because a registration already landed, or simply slow — is
// never a reason to give up. Each attempt gets a 30 s timeout and the
// waits between attempts back off exponentially from 250 ms up to a 5 s
// ceiling. The program never exits before the env says the trial is over.

import { createApp } from './app.ts';

/** How long a single register or done request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between two attempts, and the longest wait allowed. */
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 5_000;

/** The trial env's origin with any trailing slashes removed, or '' when unset. */
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is empty: no trial env to register with\n');
  process.exit(1);
}

/** A promise that resolves after `ms` milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One env request with the trial's timeout discipline. Returns the response
 * when the env answered at all, and null when the request itself failed
 * (refused, timed out, or otherwise never completed).
 */
async function askEnv(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${envUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** Discard a response body so its connection can be reused or released. */
async function drain(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // A body that cannot be read changes nothing about the answer itself.
  }
}

const server = createApp();
await new Promise<void>((resolve) => {
  server.listen(0, () => resolve());
});

const bound = server.address();
if (bound === null || typeof bound === 'string') {
  process.stderr.write('[forge] the server did not bind a TCP port\n');
  process.exit(1);
}
const myPort = bound.port;

// Step 3: register the bound port with the env, retrying until it accepts.
// The first registration wins on the env's side; a 409 just means this loop
// keeps waiting and asking again, like any other failed attempt.
let pause = FIRST_WAIT_MS;
for (;;) {
  const answer = await askEnv('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: myPort }),
  });
  if (answer !== null) {
    await drain(answer);
    if (answer.ok) break;
  }
  await wait(pause);
  pause = Math.min(pause * 2, LONGEST_WAIT_MS);
}

// Step 4: poll /done until the env reports the trial is finished. A poll
// that fails or answers anything but {"done": true} simply means "not yet".
pause = FIRST_WAIT_MS;
for (;;) {
  const answer = await askEnv('/done');
  let finished = false;
  if (answer !== null && answer.ok) {
    try {
      const body = (await answer.json()) as { done?: unknown };
      finished = body.done === true;
    } catch {
      finished = false;
    }
  } else if (answer !== null) {
    await drain(answer);
  }
  if (finished) break;
  await wait(pause);
  pause = Math.min(pause * 2, LONGEST_WAIT_MS);
}

// Step 5: the trial is over — shut the forge down and report success.
server.close();
process.exit(0);
