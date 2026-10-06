import {expect} from 'chai'

import {
  addGithubArgs,
  createConfigDir,
  getSharedConfigDir,
  redactSecret,
  removeConfigDir,
  requireEnv,
  runCli,
  runCliJson,
  runCliOk,
  SERVERS,
  unknownCommandFailure,
} from './helpers.js'
import {oracleLogin} from './oracle.js'

describe('e2e: connection', () => {
  let configDir: string

  // Slow first run: builds the shared dir, connecting to every server.
  before(async function () {
    this.timeout(300_000)
    configDir = await getSharedConfigDir()
  })

  it('authenticates to GitHub over HTTP as the token owner', async () => {
    const me = await runCliJson<{login: string}>([SERVERS.github, 'get_me'], configDir)
    expect(me.login).to.equal(await oracleLogin())
  })

  it('authenticates to Context7 over HTTP', async () => {
    const {stdout} = await runCliOk(
      [SERVERS.context7, 'resolve-library-id', '--libraryName', 'react', '--query', 'hooks'],
      configDir,
    )
    expect(stdout).to.contain('Context7-compatible library ID: /')
  })

  it('authenticates to Context7 over stdio', async () => {
    const {stdout} = await runCliOk(
      [SERVERS.context7Stdio, 'resolve-library-id', '--libraryName', 'react', '--query', 'hooks'],
      configDir,
    )
    expect(stdout).to.contain('Context7-compatible library ID: /')
  })

  // `server:tool` is the registered id; `server tool` is what oclif's space
  // topic separator turns into it. Both must reach the same command.
  it('resolves both the colon and the space-separated tool command forms', async () => {
    const colon = await runCli([`${SERVERS.github}:get_me`], configDir)
    expect(colon.code).to.equal(0)

    const space = await runCli([SERVERS.github, 'get_me'], configDir)
    expect(space.code).to.equal(0)
    expect(space.stdout).to.equal(colon.stdout)
  })

  // A synthetic secret, not the real API keys: chai renders the actual
  // strings in its failure message, so if this used live keys the one
  // circumstance where this test fails (a redaction regression) would print
  // credentials into the terminal and CI logs.
  it('redacts secrets from captured output', () => {
    const needle = 'SEKRET-PLACEHOLDER-0001'
    const text = `some output embedding ${needle} in the middle of it`

    expect(redactSecret(text, [needle])).to.not.include(needle)
    expect(redactSecret(text, [needle])).to.contain('<redacted>')
  })

  it('leaves text untouched when there is no secret to redact', () => {
    const text = 'plain output with no secret in it'

    expect(redactSecret(text, [])).to.equal(text)
    expect(redactSecret(text, [''])).to.equal(text)
  })

  it('refuses to add GitHub with a token it rejects', async () => {
    const dir = await createConfigDir('mcp-client-e2e-badtoken-')
    try {
      const result = await runCli(addGithubArgs('gh-bad', 'ghp_000000000000000000000000000000000000'), dir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('Failed to connect to MCP server')
      expect(result.stderr).to.contain('unauthorized')

      // Nothing is persisted for a server that never connected.
      const list = await runCli(['mcp', 'client', 'list'], dir)
      expect(list.stdout).to.contain('No MCP servers configured')
    } finally {
      await removeConfigDir(dir)
    }
  })

  it('fails a tool call cleanly once the GitHub token is revoked', async () => {
    const result = await runCli([SERVERS.githubRevoked, 'get_me'], configDir)
    expect(result.code).to.equal(2)
    expect(result.stderr).to.contain('Failed to call tool "get_me"')
  })

  // PINNED AS OBSERVED, not as desired: Context7 lists tools without checking
  // the key, and answers a bad key with an ordinary (non-isError) text result,
  // so the call exits 0 and the rejection only shows up in the body.
  it('exits 0 with an "Invalid API key" body when Context7 rejects the key', async () => {
    const result = await runCli(
      [SERVERS.context7Broken, 'resolve-library-id', '--libraryName', 'react', '--query', 'hooks'],
      configDir,
    )
    expect(result.code).to.equal(0)
    expect(result.stdout).to.contain('Invalid API key')
  })

  it('errors on an unknown tool', async () => {
    const result = await runCli([SERVERS.github, 'nosuch_tool'], configDir)
    const expected = unknownCommandFailure()
    expect(result.code).to.equal(expected.code)
    expect(result.stderr).to.contain(expected.stderr)
  })

  it('errors on an unknown server', async () => {
    const result = await runCli(['mcp', 'client', 'refresh', 'nosuch'], configDir)
    expect(result.code).to.equal(2)
    expect(result.stderr).to.contain('MCP server "nosuch" not found')
  })

  it('never prints a live key into captured output', async () => {
    const {context7, github} = requireEnv()
    // The revoked server forces an error path that echoes server output; the
    // captured stdout/stderr of a failing run, and `list` (which echoes the
    // transport config), must not contain either key.
    const failing = await runCli([SERVERS.githubRevoked, 'get_me'], configDir)
    const list = await runCli(['mcp', 'client', 'list'], configDir)
    for (const key of [github, context7]) {
      for (const text of [failing.stdout, failing.stderr, list.stdout, list.stderr]) {
        expect(text.includes(key), 'a live key leaked into CLI output').to.be.false
      }
    }
  })

  it('lists every configured server', async () => {
    const result = await runCli(['mcp', 'client', 'list'], configDir)
    expect(result.code).to.equal(0)
    for (const name of Object.values(SERVERS)) {
      expect(result.stdout).to.contain(`${name}\n  Transport:`)
    }
  })
})
