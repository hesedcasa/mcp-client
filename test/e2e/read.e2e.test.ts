import {expect} from 'chai'

import {getSharedConfigDir, READ_OWNER, READ_REPO, runCli, runCliJson, runCliOk, SERVERS} from './helpers.js'
import {oracleCommitShas, oracleFileText} from './oracle.js'

type Commit = {sha: string}

const REPO_FLAGS = ['--owner', READ_OWNER, '--repo', READ_REPO]

describe('e2e: read paths', () => {
  let configDir: string

  before(async function () {
    this.timeout(300_000)
    configDir = await getSharedConfigDir()
  })

  describe('github', () => {
    // Paired with the oracle so the CLI's answer is checked against GitHub
    // itself, and with two different sizes so a dropped --perPage (which would
    // fall back to GitHub's default of 30) cannot pass.
    it('coerces a numeric flag: --perPage caps list_commits', async () => {
      const one = await runCliJson<Commit[]>(
        [SERVERS.github, 'list_commits', ...REPO_FLAGS, '--perPage', '1'],
        configDir,
      )
      const two = await runCliJson<Commit[]>(
        [SERVERS.github, 'list_commits', ...REPO_FLAGS, '--perPage', '2'],
        configDir,
      )
      expect(one).to.have.lengthOf(1)
      expect(two).to.have.lengthOf(2)
    })

    it('reads a commit by sha that matches the REST API', async () => {
      const [sha] = await oracleCommitShas(READ_OWNER, READ_REPO, 1)
      const commit = await runCliJson<Commit>(
        [SERVERS.github, 'get_commit', ...REPO_FLAGS, '--sha', sha, '--detail', 'none'],
        configDir,
      )
      expect(commit.sha).to.equal(sha)
    })

    it('passes the same arguments through --json-args', async () => {
      const viaFlags = await runCliJson<Commit[]>(
        [SERVERS.github, 'list_commits', ...REPO_FLAGS, '--perPage', '1'],
        configDir,
      )
      const viaJson = await runCliJson<Commit[]>(
        [
          SERVERS.github,
          'list_commits',
          '--json-args',
          JSON.stringify({owner: READ_OWNER, perPage: 1, repo: READ_REPO}),
        ],
        configDir,
      )
      expect(viaJson.map((c) => c.sha)).to.deep.equal(viaFlags.map((c) => c.sha))
    })

    // get_file_contents answers with a text item plus an embedded `resource`
    // item — the only live coverage of the CLI's non-text content path, which
    // prints the item as pretty JSON.
    it('prints a resource content item as JSON carrying the file text', async () => {
      const {stdout} = await runCliOk(
        [SERVERS.github, 'get_file_contents', ...REPO_FLAGS, '--path', 'package.json'],
        configDir,
      )
      const start = stdout.indexOf('{\n  "type": "resource"')
      expect(start, 'expected a pretty-printed resource item').to.be.at.least(0)

      const item = JSON.parse(stdout.slice(start)) as {resource: {text: string}; type: string}
      expect(item.resource.text).to.equal(await oracleFileText(READ_OWNER, READ_REPO, 'package.json'))
    })

    it('searches repositories', async () => {
      const payload = await runCliJson<{items: Array<{full_name: string}>}>(
        [SERVERS.github, 'search_repositories', '--query', `repo:${READ_OWNER}/${READ_REPO}`],
        configDir,
      )
      expect(payload.items.map((item) => item.full_name)).to.include(`${READ_OWNER}/${READ_REPO}`)
    })

    it('emits TOON rather than JSON under --toon', async () => {
      const {stdout} = await runCliOk([SERVERS.github, 'get_me', '--toon'], configDir)
      expect(() => {
        JSON.parse(stdout)
      }).to.throw()
      expect(stdout).to.contain('login: ')
    })

    it('surfaces a server-side tool error as exit 2', async () => {
      const result = await runCli(
        [SERVERS.github, 'issue_read', ...REPO_FLAGS, '--method', 'get', '--issue_number', '999999'],
        configDir,
      )
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('Failed to call tool "issue_read"')
      expect(result.stderr).to.contain('404')
    })

    it('enforces required arguments before calling the server', async () => {
      const result = await runCli([SERVERS.github, 'list_commits', '--owner', READ_OWNER], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('Missing required argument: --repo')
    })

    it('rejects --json-args that is not JSON', async () => {
      const result = await runCli([SERVERS.github, 'get_me', '--json-args', 'not-json'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('--json-args must be a valid JSON object')
    })

    it('rejects a flag the tool schema does not declare', async () => {
      const result = await runCli([SERVERS.github, 'get_me', '--nosuch', 'x'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('Nonexistent flag: --nosuch')
    })
  })

  describe('context7', () => {
    for (const server of [SERVERS.context7, SERVERS.context7Stdio]) {
      // Each test re-awaits the memoized shared dir rather than reading the
      // suite-level `configDir` from inside this loop.
      it(`resolves a library id via ${server}`, async () => {
        const dir = await getSharedConfigDir()
        const {stdout} = await runCliOk(
          [server, 'resolve-library-id', '--libraryName', 'next.js', '--query', 'app router'],
          dir,
        )
        expect(stdout).to.contain('/vercel/next.js')
      })

      // query-docs answers with markdown, not JSON — the text item must pass
      // through untouched, and --toon must leave non-JSON text alone.
      it(`streams non-JSON docs through unmodified via ${server}`, async () => {
        const dir = await getSharedConfigDir()
        const args = [server, 'query-docs', '--libraryId', '/vercel/next.js', '--query', 'app router setup']
        const {stdout} = await runCliOk(args, dir)
        expect(stdout).to.have.lengthOf.at.least(100)
        expect(() => {
          JSON.parse(stdout)
        }).to.throw()

        const toon = await runCliOk([...args, '--toon'], dir)
        expect(toon.stdout).to.have.lengthOf.at.least(100)
      })
    }

    it('reports a missing required argument by its flag name', async () => {
      const result = await runCli([SERVERS.context7, 'resolve-library-id', '--query', 'hooks'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('Missing required argument: --libraryName')
    })
  })
})
