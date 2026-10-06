import {Buffer} from 'node:buffer'

import {requireEnv} from './helpers.js'

/**
 * GETs a GitHub REST endpoint directly, bypassing the CLI and the MCP server
 * entirely.
 *
 * This is the oracle the CLI is checked against, so it must not share its code
 * path: whatever a tool command prints is compared with what GitHub itself
 * answers here. Read-only by construction — there is no method parameter.
 *
 * @param apiPath Path under https://api.github.com, e.g. `/user`.
 * @returns The parsed JSON body.
 */
export async function githubRest<T>(apiPath: string): Promise<T> {
  const {github} = requireEnv()
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${github}`,
      'x-github-api-version': '2022-11-28',
    },
  })

  const text = await response.text()
  if (response.status !== 200) {
    throw new Error(`githubRest ${apiPath} failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }

  return JSON.parse(text) as T
}

/** The authenticated user's login, straight from the REST API. */
export async function oracleLogin(): Promise<string> {
  const {login} = await githubRest<{login: string}>('/user')
  return login
}

/**
 * The newest commits on a repo's default branch, straight from the REST API.
 *
 * @returns Commit SHAs, newest first.
 */
export async function oracleCommitShas(owner: string, repo: string, perPage: number): Promise<string[]> {
  const commits = await githubRest<Array<{sha: string}>>(`/repos/${owner}/${repo}/commits?per_page=${perPage}`)
  return commits.map((commit) => commit.sha)
}

/** A file's decoded contents on the default branch, straight from the REST API. */
export async function oracleFileText(owner: string, repo: string, filePath: string): Promise<string> {
  const {content, encoding} = await githubRest<{content: string; encoding: string}>(
    `/repos/${owner}/${repo}/contents/${filePath}`,
  )
  if (encoding !== 'base64') throw new Error(`oracleFileText: unexpected encoding ${encoding}`)
  return Buffer.from(content, 'base64').toString('utf8')
}
