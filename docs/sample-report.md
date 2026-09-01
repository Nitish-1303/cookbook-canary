## Cookbook canary — solari-sdk/solari-cookbook

**3 examples are broken.**

`main` at `abcdef123456` · 200.0s wall clock · 6.4 machine-minutes

❌ 2 fail · ⏱️ 1 timeout · ⚠️ 1 flake · ⏭️ 1 skipped · ✅ 1 pass

| | example | result | time |
| --- | --- | --- | --- |
| ❌ | `browser-scrape` | page did not contain "Scraped 3 pages" | 14.6s |
| ❌ | `py-agent` | install: exited 1 | 12.0s |
| ⏱️ | `desktop-tour` | timed out after 240.0s | 240.0s |
| ⚠️ | `stream-chat` | network or upstream error | 1.9s |
| ⏭️ | `notes` | no package.json or requirements.txt — cannot tell how to run it | 0ms |
| ✅ | `sandbox-runner` | ok | 6.1s |

### What broke

<details><summary><code>browser-scrape</code> — page did not contain "Scraped 3 pages"</summary>

- machine: `fork_browser-scrape` (sandbox)
- preview answered `200` after 4 poll(s)
- page was missing: `Scraped 3 pages`
- [session replay](https://app.solari.dev/sessions/sess_9f2c/replay)

stdout:
```
listening on http://0.0.0.0:3000
```

![what the page looked like](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAB1p1PmAAAAY0lEQVR4nO3PMQ2AMAAEwSswCwYWJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJvADXwYBAWQx7iEAAAAASUVORK5CYII=)

</details>

<details><summary><code>py-agent</code> — install: exited 1</summary>

- machine: `fork_py-agent` (sandbox)

Install output:
```
ERROR: Could not find a version that satisfies the requirement solari-sdk==0.4.0
```

</details>

<details><summary><code>desktop-tour</code> — timed out after 240.0s</summary>

- machine: `dsk_71a` (desktop)
- attempts: 2
- [live desktop stream](https://app.solari.dev/desktops/dsk_71a/stream)

stderr:
```
xdotool: no window matched
```

![what the screen looked like](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAB1p1PmAAAAY0lEQVR4nO3PMQ2AMAAEwSswCwYWJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJmACJvADXwYBAWQx7iEAAAAASUVORK5CYII=)

</details>

<sub>
Each example ran alone on its own microVM, forked from one prepared snapshot (74.0s of installs done once instead of 6 times). Credentials were passed to the run step only and scrubbed from this report.
</sub>