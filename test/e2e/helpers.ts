import {expect} from 'chai'
import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(REPO_ROOT, 'bin', 'run.js')

/**
 * oclif scopes its config dir override to the bin name, so `MCP_CLIENT_CONFIG_DIR`
 * redirects every store/OAuth read of the subprocess. See `Config.scopedEnvVar`
 * in the oclif core package.
 */
export const CONFIG_DIR_ENV = 'MCP_CLIENT_CONFIG_DIR'

/** GitHub's hosted MCP server (streamable HTTP, PAT as a bearer token). */
export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'
/** Context7's hosted MCP server (streamable HTTP, API key as a bearer token). */
export const CONTEXT7_MCP_URL = 'https://mcp.context7.com/mcp'
/**
 * Context7's MCP server as an npm package, for the stdio transport. Pinned to
 * an exact version: npx runs it with CONTEXT7_API_KEY in its environment, so
 * it must not float on `latest`. Bump deliberately.
 */
export const CONTEXT7_STDIO_PACKAGE = '@upstash/context7-mcp@4.1.1'

/** A public repo every read-path test targets — this one, so it always exists. */
export const READ_OWNER = 'hesedcasa'
export const READ_REPO = 'mcp-client'

/** Server names in the shared config dir. */
export const SERVERS = {
  context7: 'context7',
  context7Broken: 'context7-broken',
  context7Stdio: 'context7-stdio',
  github: 'github',
  githubRevoked: 'github-revoked',
} as const

export type Secrets = {
  context7: string
  github: string
}

/**
 * Reads the two live-API credentials from the environment.
 *
 * They come from Infisical (or an exported .env); nothing in this repo loads
 * either, so run under `infisical run --` or via `npm run test:e2e`.
 */
export function requireEnv(): Secrets {
  const github = process.env.GITHUB_TOKEN
  const context7 = process.env.CONTEXT7_API_KEY

  if (!github || !context7) {
    throw new Error('Missing GITHUB_TOKEN or CONTEXT7_API_KEY. Run under Infisical: infisical run -- npm run e2e:mocha')
  }

  return {context7, github}
}

/** Every credential the suite knows about, for redacting captured CLI output. */
function secrets(): string[] {
  try {
    const {context7, github} = requireEnv()
    return [github, context7]
  } catch {
    return []
  }
}

/** `mcp client add` argv for each live server. */
export function addGithubArgs(name: string, token: string): string[] {
  return ['mcp', 'client', 'add', name, '--url', GITHUB_MCP_URL, '--header', `Authorization=Bearer ${token}`]
}

export function addContext7HttpArgs(name: string, key: string): string[] {
  // Authorization, not Context7's own CONTEXT7_API_KEY header: without an
  // Authorization header the client assumes OAuth (hasStaticAuth), and an
  // OAuth flow would try to open a browser mid-suite.
  return ['mcp', 'client', 'add', name, '--url', CONTEXT7_MCP_URL, '--header', `Authorization=Bearer ${key}`]
}

export function addContext7StdioArgs(name: string, key: string): string[] {
  return [
    'mcp',
    'client',
    'add',
    name,
    '--command',
    'npx',
    '--args',
    '-y',
    '--args',
    CONTEXT7_STDIO_PACKAGE,
    '--env',
    `CONTEXT7_API_KEY=${key}`,
  ]
}

export type CliResult = {
  code: number
  stderr: string
  stdout: string
}

/**
 * Builds the subprocess invocation for the configured host CLI.
 *
 * By default the built standalone CLI (`bin/run.js`) runs with
 * `MCP_CLIENT_CONFIG_DIR`. When `E2E_HOST_CLI=sdkck`, the same arguments go to
 * the `sdkck` binary instead — the argv is host-agnostic because every
 * command already carries the `mcp client` topic prefix and dynamic tool
 * commands live under the server name — and oclif's bin-scoped `SDKCK_*` dirs
 * are redirected: config to the same throwaway config dir the standalone leg
 * uses, data/cache into the throwaway sdkck home (`E2E_SDKCK_HOME`) that the
 * scripts installed the plugin into.
 *
 * @param args Command line arguments, e.g. ['github', 'get_me'].
 * @param configDir The isolated config dir, from createConfigDir() or the shared dir.
 * @returns The executable, its argv, and env overrides to layer over process.env.
 */
function hostInvocation(
  args: string[],
  configDir: string,
): {argv: string[]; command: string; env: Record<string, string>} {
  if (process.env.E2E_HOST_CLI === 'sdkck') {
    const home = process.env.E2E_SDKCK_HOME
    if (!home) {
      throw new Error('E2E_HOST_CLI=sdkck requires E2E_SDKCK_HOME — set by scripts/e2e.sh or the CI workflow')
    }

    return {
      argv: args,
      command: 'sdkck',
      env: {
        SDKCK_CACHE_DIR: path.join(home, 'cache'),
        SDKCK_CONFIG_DIR: configDir,
        SDKCK_DATA_DIR: path.join(home, 'data'),
      },
    }
  }

  return {argv: [CLI, ...args], command: process.execPath, env: {[CONFIG_DIR_ENV]: configDir}}
}

/**
 * Runs the host CLI as a real subprocess against an isolated config dir. The
 * host is the built standalone CLI unless `E2E_HOST_CLI=sdkck` (see
 * hostInvocation()). Non-zero exits are returned rather than thrown so tests
 * can assert on failure paths.
 *
 * @param args Command line arguments, e.g. ['github', 'get_me'].
 * @param configDir The isolated config dir.
 * @returns The exit code and captured stdout/stderr.
 */
export async function runCli(args: string[], configDir: string): Promise<CliResult> {
  const {argv, command, env} = hostInvocation(args, configDir)
  return new Promise((resolve) => {
    execFile(
      command,
      argv,
      {env: {...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env}, maxBuffer: 64 * 1024 * 1024},
      (error, stdout, stderr) => {
        // A spawn failure carries a string errno code (ENOENT), not an exit code.
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({code, stderr, stdout})
      },
    )
  })
}

/**
 * What an unknown command looks like under the configured host.
 *
 * The standalone CLI has no not-found plugin, so oclif's own error exits 2
 * ("command github:nosuch not found"); sdkck ships `@oclif/plugin-not-found`,
 * which exits 127 ("github nosuch is not a sdkck command").
 */
export function unknownCommandFailure(): {code: number; stderr: string} {
  return process.env.E2E_HOST_CLI === 'sdkck'
    ? {code: 127, stderr: 'is not a sdkck command'}
    : {code: 2, stderr: 'not found'}
}

/**
 * Replaces every occurrence of each secret in `text` with `<redacted>`.
 *
 * Empty/missing secrets are skipped rather than matching everything — an empty
 * needle would otherwise turn `replaceAll` into a full-string redaction.
 *
 * Exported (rather than a private helper) so it can be exercised directly by a
 * unit-style test without invoking a command whose output carries a real token.
 *
 * @param text Captured stdout/stderr that may contain secrets.
 * @param needles The values to scrub; falsy values leave `text` untouched.
 * @returns `text` with every occurrence of every needle replaced.
 */
export function redactSecret(text: string, needles: string[]): string {
  let result = text
  for (const needle of needles) {
    if (needle) result = result.replaceAll(needle, '<redacted>')
  }

  return result
}

/**
 * Runs the CLI and fails the test if it exited non-zero.
 *
 * The failure message — and the argv echoed in it, since `mcp client add`
 * takes the credential as a flag — redacts both API keys before they are
 * interpolated, so a failing call never prints a live credential into mocha's
 * failure output or CI logs. The returned `CliResult` itself is left
 * unredacted — tests need the real values to assert on.
 *
 * @param args Command line arguments.
 * @param configDir The isolated config dir.
 * @returns The successful result.
 */
export async function runCliOk(args: string[], configDir: string): Promise<CliResult> {
  const result = await runCli(args, configDir)
  const needles = secrets()
  const command = redactSecret(args.join(' '), needles)
  const stdout = redactSecret(result.stdout, needles)
  const stderr = redactSecret(result.stderr, needles)
  expect(result.code, `\`${command}\` failed:\n${stdout}\n${stderr}`).to.equal(0)
  return result
}

/**
 * Runs the CLI, expects success, and parses stdout as JSON.
 *
 * Tool commands print each text content item verbatim, so a tool that answers
 * with one JSON text item yields exactly that JSON on stdout.
 *
 * @param args Command line arguments.
 * @param configDir The isolated config dir.
 * @returns The parsed JSON payload.
 */
export async function runCliJson<T = unknown>(args: string[], configDir: string): Promise<T> {
  const {stdout} = await runCliOk(args, configDir)
  return JSON.parse(stdout) as T
}

// ─── Config dirs ──────────────────────────────────────────────────────────────

export async function createConfigDir(prefix = 'mcp-client-e2e-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function removeConfigDir(dir: string): Promise<void> {
  await fs.rm(dir, {force: true, recursive: true})
}

/**
 * Writes a copy of a configured server under a new name with one HTTP header
 * replaced — the state a token revoked *after* `mcp client add` leaves behind.
 *
 * That state is unreachable through the CLI (add refuses a token the server
 * rejects), so it is written directly; the cached tool list is kept so the
 * dynamic commands still register and the call path is what fails.
 */
export async function cloneServerWithHeaders(
  configDir: string,
  source: string,
  target: string,
  headers: Record<string, string>,
): Promise<void> {
  const raw = await fs.readFile(path.join(configDir, `mcp-client-${source}.json`), 'utf8')
  const file = JSON.parse(raw) as {config: {headers?: Record<string, string>; name: string}}
  file.config.name = target
  file.config.headers = {...file.config.headers, ...headers}
  await fs.writeFile(path.join(configDir, `mcp-client-${target}.json`), JSON.stringify(file, null, 2), 'utf8')
}

/**
 * The one config dir shared by every test file in a mocha process, with the
 * live servers added.
 *
 * Adding a server is a live connect + listTools round trip (and the stdio one
 * an npx install on a cold cache), and most files need the same servers, so
 * the dir is built once and memoized. Each file's `before` awaits this; the
 * root-level `after` in root-hooks.e2e.test.ts removes the token-bearing
 * directory after the whole run, however it ends.
 */
let sharedConfigDir: Promise<string> | undefined

export async function getSharedConfigDir(): Promise<string> {
  sharedConfigDir ??= buildSharedConfigDir()
  return sharedConfigDir
}

/** Removes the shared config dir, if this process ever built one. */
export async function disposeSharedConfigDir(): Promise<void> {
  if (!sharedConfigDir) return
  const dir = await sharedConfigDir.catch(() => null)
  if (dir) await removeConfigDir(dir)
}

async function buildSharedConfigDir(): Promise<string> {
  const dir = await createConfigDir('mcp-client-e2e-shared-')
  const {context7, github} = requireEnv()

  // Sequential on purpose: each add writes into the same dir, and the
  // servers.e2e file covers concurrent behaviour (`refresh` of all) on its own.
  await runCliOk(addGithubArgs(SERVERS.github, github), dir)
  await runCliOk(addContext7HttpArgs(SERVERS.context7, context7), dir)
  await runCliOk(addContext7StdioArgs(SERVERS.context7Stdio, context7), dir)

  // Context7 lists its tools without checking the key, so a broken key can be
  // added through the CLI like any other server; it only fails at call time.
  await runCliOk(addContext7HttpArgs(SERVERS.context7Broken, 'definitely-not-the-token'), dir)
  // GitHub checks the token on connect, so its broken twin has to be cloned.
  await cloneServerWithHeaders(dir, SERVERS.github, SERVERS.githubRevoked, {
    Authorization: 'Bearer ghp_000000000000000000000000000000000000',
  })

  return dir
}
