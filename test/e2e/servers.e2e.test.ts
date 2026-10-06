import {expect} from 'chai'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  addContext7HttpArgs,
  addContext7StdioArgs,
  addGithubArgs,
  CONTEXT7_MCP_URL,
  CONTEXT7_STDIO_PACKAGE,
  createConfigDir,
  GITHUB_MCP_URL,
  removeConfigDir,
  requireEnv,
  runCli,
  runCliJson,
  runCliOk,
  unknownCommandFailure,
} from './helpers.js'

type ServerFile = {cachedTools?: Array<{name: string}>; cacheTimestamp?: number; config: {transport: string}}

async function readServerFile(configDir: string, name: string): Promise<ServerFile> {
  return JSON.parse(await fs.readFile(path.join(configDir, `mcp-client-${name}.json`), 'utf8')) as ServerFile
}

describe('e2e: server management', () => {
  let configDir: string

  before(async () => {
    configDir = await createConfigDir('mcp-client-e2e-servers-')
  })

  after(async () => {
    await removeConfigDir(configDir)
  })

  describe('add', () => {
    before(async function () {
      // A cold npx cache downloads the stdio server package on first add.
      this.timeout(300_000)
      const {context7, github} = requireEnv()

      await runCliOk(addGithubArgs('github', github), configDir)
      await runCliOk(addContext7HttpArgs('context7', context7), configDir)
      await runCliOk(addContext7StdioArgs('context7-stdio', context7), configDir)
    })

    it('adds GitHub as an HTTP server with its tools cached', async () => {
      const file = await readServerFile(configDir, 'github')
      expect(file.config.transport).to.equal('http')
      const names = (file.cachedTools ?? []).map((tool) => tool.name)
      // Spot-check tools the rest of the suite drives.
      expect(names).to.include.members(['get_me', 'get_file_contents', 'list_commits'])
    })

    it('adds Context7 over both transports with the same tool set', async () => {
      const http = await readServerFile(configDir, 'context7')
      const stdio = await readServerFile(configDir, 'context7-stdio')
      expect(http.config.transport).to.equal('http')
      expect(stdio.config.transport).to.equal('stdio')

      const httpNames = (http.cachedTools ?? []).map((tool) => tool.name)
      expect(httpNames).to.include.members(['resolve-library-id', 'query-docs'])
      expect((stdio.cachedTools ?? []).map((tool) => tool.name)).to.have.members(httpNames)
    })

    it('describes each server in `mcp client list`', async () => {
      const {stdout} = await runCliOk(['mcp', 'client', 'list'], configDir)
      expect(stdout).to.contain(`github\n  Transport: http (${GITHUB_MCP_URL})`)
      expect(stdout).to.contain(`context7\n  Transport: http (${CONTEXT7_MCP_URL})`)
      expect(stdout).to.contain(`context7-stdio\n  Transport: stdio (npx -y ${CONTEXT7_STDIO_PACKAGE})`)
      // A freshly added cache is not stale.
      expect(stdout).to.not.contain('cache stale')
    })

    it('lists individual tools with --tools', async () => {
      const {stdout} = await runCliOk(['mcp', 'client', 'list', '--tools'], configDir)
      expect(stdout).to.contain('    github get_me')
      expect(stdout).to.contain('    context7-stdio query-docs')
    })

    it('registers the cached tools as commands in help', async () => {
      const {stdout} = await runCliOk(['github', '--help'], configDir)
      expect(stdout).to.contain('get_me')
      expect(stdout).to.contain('list_commits')
    })

    // PINNED AS OBSERVED: unlike a name clash in most stores, re-adding an
    // existing name silently replaces the server (and its cached tools).
    it('replaces a server when the same name is added again', async () => {
      const {github} = requireEnv()
      const before = (await readServerFile(configDir, 'github')).cacheTimestamp!

      const result = await runCli(addGithubArgs('github', github), configDir)
      expect(result.code).to.equal(0)
      expect(result.stdout).to.contain('Added MCP server "github"')
      expect((await readServerFile(configDir, 'github')).cacheTimestamp).to.be.greaterThan(before)
    })

    it('requires exactly one of --command and --url', async () => {
      const neither = await runCli(['mcp', 'client', 'add', 'x'], configDir)
      expect(neither.code).to.equal(2)
      expect(neither.stderr).to.contain('Either --command (stdio) or --url (http) is required')

      const both = await runCli(['mcp', 'client', 'add', 'x', '--command', 'a', '--url', 'http://b'], configDir)
      expect(both.code).to.equal(2)
      expect(both.stderr).to.contain('Specify only one of --command (stdio) or --url (http)')
    })

    it('fails to add a stdio server whose command does not exist', async () => {
      const result = await runCli(['mcp', 'client', 'add', 'ghost', '--command', '/nonexistent/mcp-server'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('Failed to connect to MCP server')
      expect(result.stderr).to.contain('ENOENT')
    })
  })

  describe('refresh and auth', () => {
    it('refreshes one server and bumps its cache timestamp', async function () {
      this.timeout(120_000)
      const before = (await readServerFile(configDir, 'context7')).cacheTimestamp!

      const {stdout} = await runCliOk(['mcp', 'client', 'refresh', 'context7'], configDir)
      expect(stdout).to.contain('tool(s) cached for "context7"')
      expect((await readServerFile(configDir, 'context7')).cacheTimestamp).to.be.greaterThan(before)
    })

    it('refreshes every server concurrently when no name is given', async function () {
      this.timeout(300_000)
      const {stdout} = await runCliOk(['mcp', 'client', 'refresh'], configDir)
      for (const name of ['github', 'context7', 'context7-stdio']) {
        expect(stdout).to.contain(`tool(s) cached for "${name}"`)
      }
    })

    // GitHub carries a static Authorization header, so re-auth never starts
    // the OAuth browser flow — it just reconnects and re-caches.
    it('re-authenticates an HTTP server with static auth without a browser', async function () {
      this.timeout(120_000)
      const {stdout} = await runCliOk(['mcp', 'client', 'auth', 'github'], configDir)
      expect(stdout).to.contain('Re-authenticated and refreshed')
      expect(stdout).to.contain('for "github"')
    })

    it('refuses to re-authenticate a stdio server', async () => {
      const result = await runCli(['mcp', 'client', 'auth', 'context7-stdio'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('uses stdio transport')
    })

    it('errors when re-authenticating an unknown server', async () => {
      const result = await runCli(['mcp', 'client', 'auth', 'nosuch'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('MCP server "nosuch" not found')
    })

    it('still calls a tool after refresh', async () => {
      const me = await runCliJson<{login: string}>(['github', 'get_me'], configDir)
      expect(me.login).to.be.a('string').and.to.have.lengthOf.at.least(1)
    })
  })

  describe('removal', () => {
    before(async () => {
      // Every other test in this file may have run before us, so removal
      // operates on whatever is left — removing all three makes the
      // assertions below order-independent.
      for (const name of ['github', 'context7', 'context7-stdio']) {
        // Sequential: concurrent CLI processes would race the store dir.
        // eslint-disable-next-line no-await-in-loop
        await runCli(['mcp', 'client', 'remove', name], configDir)
      }
    })

    it('reports "No MCP servers configured" once everything is gone', async () => {
      const {stdout} = await runCliOk(['mcp', 'client', 'list'], configDir)
      expect(stdout).to.contain('No MCP servers configured')
    })

    it('deletes the server file from the config dir', async () => {
      const files = await fs.readdir(configDir)
      expect(files.filter((file) => file.startsWith('mcp-client-'))).to.deep.equal([])
    })

    it('errors when removing an unknown server', async () => {
      const result = await runCli(['mcp', 'client', 'remove', 'github'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('MCP server "github" not found')
    })

    it('unregisters the tool commands of a removed server', async () => {
      const result = await runCli(['github', 'get_me'], configDir)
      const expected = unknownCommandFailure()
      expect(result.code).to.equal(expected.code)
      expect(result.stderr).to.contain(expected.stderr)
    })
  })
})
