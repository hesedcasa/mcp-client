# CLAUDE.md

## End-to-end tests

`test/e2e/**` runs the built `bin/run.js` as a real subprocess against two live MCP servers — GitHub's hosted server (`https://api.githubcopilot.com/mcp/`, HTTP) and Context7, both hosted (HTTP) and as the pinned `@upstash/context7-mcp` npm package over stdio. `npm run test:e2e` then reruns the same suite through the latest sdkck host CLI with the current build packed and installed as its `@hesed/mcp-client` plugin — the host switch (`E2E_HOST_CLI=sdkck` + `E2E_SDKCK_HOME`, set by `scripts/e2e.sh` and the CI workflow) lives in `test/e2e/helpers.ts`; the plugin must be installed before any `sdkck mcp` call, or sdkck's JIT installer pulls the published release, and the tarball must be a `file:` URL (bare paths read as GitHub `org/repo`); sdkck is installed with the credentials stripped from its environment, and after installing the plugin the script and workflow check sdkck's install record carries the packed `file:` tarball. It is excluded from `npm test`. **Credentials (`GITHUB_TOKEN`, `CONTEXT7_API_KEY`) live in Infisical** (never commit a token) — nothing in this repo loads `.env`, so they must be in the process environment. `.infisical.json` links the repo to the Infisical project (`dev` environment); `scripts/e2e.sh` re-runs itself under `infisical run` when the credentials aren't exported — signed in by `infisical login`, or headless (an E2B sandbox) by a machine identity's `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`/`_CLIENT_SECRET`, with `--projectId` read from `.infisical.json` — but the other scripts need the wrapper:

```bash
npm run test:e2e                         # build, run standalone, then run via sdkck
npm run test:e2e -- --grep "sweep"       # extra args go through to mocha
infisical run -- npm run e2e:mocha       # standalone leg only, without rebuilding
```

`GITHUB_TOKEN` is a personal access token, not the Actions workflow token: GitHub's MCP server needs a user identity (`get_me`). CI (`.github/workflows/run-e2e-tests.yml`, manual dispatch from the default branch only) builds and installs in a job with no OIDC permission, then fetches the credentials in the test job with `Infisical/secrets-action` over OIDC — the repo variables `INFISICAL_IDENTITY_ID` and `INFISICAL_PROJECT_SLUG` select the machine identity and project, and no secret is stored in the repo.

Rules specific to this suite:

- **The suite is read-only.** The GitHub token has no write permission, and nothing in the suite writes to either account, so there are no fixtures and nothing to sweep afterwards. Read paths target this repo (`hesedcasa/mcp-client`, public), so they always have data.
- **Expected values come from an oracle, not the CLI.** `test/e2e/oracle.ts` reads GitHub's REST API with raw `fetch`; CLI output is checked against it (login, commit SHAs, file contents), never against itself.
- **The subprocess config dir is isolated with `MCP_CLIENT_CONFIG_DIR`** (oclif's bin-scoped `CONFIG_DIR` override; `SDKCK_CONFIG_DIR` under sdkck). Tests never touch `~/.config/mcp-client`; the shared dir is built once per mocha process by `getSharedConfigDir()` and removed by the root `after` hook in `root-hooks.e2e.test.ts`. That hook can't live in `helpers.ts`: any mocha call there makes eslint-plugin-mocha treat the module as a test file and reject its exports.
- **Context7 is added with `Authorization: Bearer`, not its own `CONTEXT7_API_KEY` header.** Without an `Authorization` header the client assumes OAuth (`hasStaticAuth`) and would try to open a browser mid-run.
- **The stdio server is pinned** (`CONTEXT7_STDIO_PACKAGE` in `helpers.ts`): npx runs it with the API key in its environment.
- **No regex literals in `test/**`.** `require-unicode-regexp` demands the `v` flag, which needs TS target `es2024`; this repo targets `es2022`. Use string methods instead.

## Tool sweep

`test/e2e/sweep.e2e.test.ts` calls **every** tool each server annotates `readOnlyHint: true`, 4 at a time, retrying rate limits and transport failures. Required arguments come from a value table (this repo, a known library id) or the schema (first enum member, `1`, `__e2e_probe__`). A probe passes if the CLI exits 0 (answered) or exits 2 with "Failed to call tool" (the server rejected it — a probe tag that doesn't exist, say). Any other failure is a violation: a flag the CLI didn't register, a required check tripping on a supplied value, a crash. Each server must attempt ≥50% of its tools and get real answers from ≥50% of those attempted. The planning/judging logic lives in `test/sweep-helpers.ts` (not under `test/e2e/`: ts-node cannot resolve downward imports from `test/` into `test/e2e/`) and is unit-pinned by `test/sweep-probe.test.ts`, which runs in plain `npm test`.

- **Write tools are never invoked.** A tool without `readOnlyHint: true` is skipped and counts against coverage. MCP has no request shape that fails validation before a handler runs, so unlike a REST sweep there is no poisoning to fall back on: the server's annotation is the only guard.
- **`EXCLUDED` holds read-only tools that are still not fired blind**, each with a reason — currently `run_secret_scanning`, which uploads caller content to GitHub's scanner.

Pinned-as-observed behaviours (deliberate, do not "fix" the tests):

- `this.error` exits **2**. An unknown command exits **2** standalone, but **127** under sdkck, whose `@oclif/plugin-not-found` handles it (`unknownCommandFailure()` in `helpers.ts`).
- A tool result with `isError` and a thrown MCP error both surface as exit 2 with `Failed to call tool "<name>": …`.
- `mcp client add` with an existing name **silently replaces** the server.
- GitHub checks the token on connect, so `add` refuses a bad one; a token revoked after `add` is simulated by cloning the server file with a bad header (`cloneServerWithHeaders`).
- Context7 lists tools without checking the key, and answers a bad key with an ordinary text result — **exit 0** with `Invalid API key` in the body.
- `get_file_contents` answers with a text item plus an embedded `resource` item, which the CLI prints as pretty JSON — the only live coverage of the non-text content path.
