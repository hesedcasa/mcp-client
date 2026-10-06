import {expect} from 'chai'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

import {
  type CachedTool,
  judgeProbe,
  planProbe,
  type ProbeExecution,
  type ProbeResult,
  runPool,
  shouldRetry,
  summarize,
  type SweepSummary,
} from '../sweep-helpers.js'
import {getSharedConfigDir, READ_OWNER, READ_REPO, runCli, SERVERS} from './helpers.js'

/**
 * The tool sweep: every read-only tool of each live server is exercised
 * through its dynamic command, planned and judged by `test/sweep-helpers.ts`
 * (the read-only guarantee lives there, unit-pinned by test/sweep-probe.test.ts).
 *
 * What "tested" means here: the CLI registered the tool's flags, built a call
 * from them, and the server either answered or rejected it as a tool error —
 * never a CLI-side failure. The curated suites (read/connection) make the
 * positive assertions; this sweep's job is breadth, not depth.
 */

/** Concurrent probes. Low enough to stay under GitHub's secondary rate limits. */
const SWEEP_CONCURRENCY = 4

/** Retries after a rate limit or transport failure, with this backoff between attempts. */
const RETRY_BACKOFF_MS = [2000, 5000]

/**
 * Known-good values for required arguments, by property name. Everything
 * targets this repo (public, always present); names the planner does not find
 * here fall back to schema-derived values (see planProbe).
 */
const PROBE_VALUES: Record<string, string> = {
  issue_number: '1',
  libraryId: '/vercel/next.js',
  libraryName: 'react',
  org: READ_OWNER,
  owner: READ_OWNER,
  pullNumber: '1',
  query: `repo:${READ_OWNER}/${READ_REPO}`,
  repo: READ_REPO,
  sha: 'main',
}

/**
 * Read-only tools that are excluded anyway. Every entry needs a justification.
 */
const EXCLUDED = new Map<string, string>([
  // Annotated read-only, but its whole job is uploading caller-supplied file
  // content to GitHub's secret scanner — not something to fire blind.
  ['run_secret_scanning', 'uploads caller content to a third-party scanner'],
])

/** Each server's sweep must actually get answers, not just rejections, from at least this share. */
const MIN_ANSWERED = 0.5
/** And must attempt at least this share of the server's tools. */
const MIN_COVERAGE = 0.5

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Reads the tools the CLI itself cached — the sweep's denominator is the CLI's own view. */
async function readTools(configDir: string, name: string): Promise<CachedTool[]> {
  const raw = await readFile(join(configDir, `mcp-client-${name}.json`), 'utf8')
  return (JSON.parse(raw) as {cachedTools?: CachedTool[]}).cachedTools ?? []
}

/** Runs one probe, retrying rate limits and transport failures per RETRY_BACKOFF_MS. */
async function executeProbe(args: string[], configDir: string): Promise<ProbeExecution> {
  const run = async (): Promise<ProbeExecution> => {
    const result = await runCli(args, configDir)
    return {exitCode: result.code, stderr: result.stderr, stdout: result.stdout}
  }

  let execution = await run()
  for (const backoff of RETRY_BACKOFF_MS) {
    if (!shouldRetry(execution)) return execution

    // eslint-disable-next-line no-await-in-loop
    await sleep(backoff)
    // eslint-disable-next-line no-await-in-loop
    execution = await run()
  }

  return execution
}

async function sweepServer(serverName: string): Promise<SweepSummary> {
  const configDir = await getSharedConfigDir()
  const tools = await readTools(configDir, serverName)
  const results: ProbeResult[] = []

  await runPool(tools, SWEEP_CONCURRENCY, async (tool) => {
    const plan = planProbe(serverName, tool, PROBE_VALUES, EXCLUDED)
    if (plan.kind === 'skip') {
      results.push({plan, verdict: {ok: true, outcome: 'skipped'}})
      return
    }

    const execution = await executeProbe(plan.args, configDir)
    results.push({plan, verdict: judgeProbe(execution)})
  })

  return summarize(results)
}

function report(summary: SweepSummary): string {
  const pct = (summary.coverage * 100).toFixed(1)
  const lines = [
    `attempted ${summary.attempted}/${summary.total} (${pct}%), answered ${summary.answered}, skipped ${summary.skipped}, violations ${summary.violations.length}`,
    ...summary.violations.slice(0, 20).map((v) => `  ${v.toolName}: ${v.violation}`),
  ]
  if (summary.violations.length > 20) lines.push(`  …and ${summary.violations.length - 20} more`)
  return lines.join('\n')
}

describe('e2e: tool sweep', () => {
  for (const serverName of [SERVERS.github, SERVERS.context7, SERVERS.context7Stdio]) {
    describe(serverName, () => {
      let summary: SweepSummary

      before(async function () {
        // Dozens of subprocess probes; CI runners are slower than laptops.
        this.timeout(900_000)
        summary = await sweepServer(serverName)
        // One line per server in the log, so a passing run still shows the shape of the coverage.
        console.log(`sweep ${serverName}: ${report(summary)}`)
      })

      it('probes every read-only tool without a CLI-side failure', () => {
        expect(summary.violations, report(summary)).to.deep.equal([])
      })

      it(`attempts at least ${MIN_COVERAGE * 100}% of the server's tools`, () => {
        expect(summary.coverage, report(summary)).to.be.at.least(MIN_COVERAGE)
      })

      it(`gets a real answer from at least ${MIN_ANSWERED * 100}% of the attempted tools`, () => {
        expect(summary.answered / summary.attempted, report(summary)).to.be.at.least(MIN_ANSWERED)
      })
    })
  }
})
