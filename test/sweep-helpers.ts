/**
 * Pure planning and judging logic for the tool sweep (`e2e/sweep.e2e.test.ts`).
 *
 * The sweep invokes tools of the live MCP servers through their dynamic
 * commands, so the guarantee it makes about NOT mutating the live accounts
 * lives here, where unit tests can pin it (`test/sweep-probe.test.ts`):
 *
 * - Only tools the server itself annotates `readOnlyHint: true` are invoked.
 *   A tool without the annotation — or with it set to anything but `true` — is
 *   skipped, never executed, and counts against coverage.
 * - Read-only tools that still ship caller data off to a third party (e.g.
 *   GitHub's secret scanner) are excluded by name by the caller.
 *
 * Unlike a REST sweep there is no poisoning step: MCP has no request shape that
 * fails validation before a handler runs, so "read-only" has to come from the
 * server's own annotation rather than from crafted input.
 */

import type {McpSchemaProperty, McpToolSchema} from '../src/mcp-client-store.js'

/** Every invented argument carries this, so anything bearing it on a live account came from the sweep. */
export const PROBE_VALUE = '__e2e_probe__'

/** The listTools payload as cached on disk — the store type omits MCP's optional annotations. */
export type CachedTool = McpToolSchema & {annotations?: {readOnlyHint?: boolean}}

export type ProbePlan =
  {args: string[]; kind: 'invoke'; toolName: string} | {kind: 'skip'; reason: string; toolName: string}

export type ProbeExecution = {exitCode: number; stderr: string; stdout: string}

/**
 * `answered`: exit 0. `rejected`: the tool ran and the server refused it (a 404
 * for a probe tag, say) — the CLI reports that as exit 2 "Failed to call tool".
 * Both prove the CLI built a request the server accepted as well-formed.
 */
export type ProbeVerdict = {ok: false; violation: string} | {ok: true; outcome: 'answered' | 'rejected' | 'skipped'}

export type ProbeResult = {plan: ProbePlan; verdict: ProbeVerdict}

/**
 * Builds the CLI argv for one tool, or explains why it must not run.
 *
 * Required properties are filled from `values` (by property name) first, then
 * from the schema: the first enum member, `1` for numbers, the bare flag for
 * booleans, and PROBE_VALUE for any other string. Optional properties are left
 * out. A required object/array/untyped property with no supplied value cannot
 * be invented safely, so the tool is skipped.
 *
 * @param serverName The configured server name — the dynamic command's topic.
 * @param tool The cached tool schema.
 * @param values Known-good argument values by property name.
 * @param excluded Tool names to skip regardless, with the reason to report.
 */
export function planProbe(
  serverName: string,
  tool: CachedTool,
  values: Readonly<Record<string, string>>,
  excluded: ReadonlyMap<string, string> = new Map(),
): ProbePlan {
  const toolName = tool.name
  const exclusion = excluded.get(toolName)
  if (exclusion) return {kind: 'skip', reason: exclusion, toolName}

  if (tool.annotations?.readOnlyHint !== true) {
    return {kind: 'skip', reason: 'not annotated readOnlyHint: true', toolName}
  }

  const properties = tool.inputSchema.properties ?? {}
  const args = [serverName, toolName]

  for (const name of tool.inputSchema.required ?? []) {
    const flag = probeFlag(name, properties[name] ?? {}, values)
    if (!flag) return {kind: 'skip', reason: `required "${name}" has no probe value`, toolName}
    args.push(...flag)
  }

  return {args, kind: 'invoke', toolName}
}

function probeFlag(
  name: string,
  prop: McpSchemaProperty,
  values: Readonly<Record<string, string>>,
): string[] | undefined {
  if (Object.hasOwn(values, name)) return [`--${name}`, values[name]]
  if (prop.enum && prop.enum.length > 0) return [`--${name}`, prop.enum[0]]
  if (prop.type === 'boolean') return [`--${name}`]
  if (prop.type === 'integer' || prop.type === 'number') return [`--${name}`, '1']
  if (prop.type === 'string') return [`--${name}`, PROBE_VALUE]
  return undefined
}

/**
 * Judges one probe. Exit 0 is an answer; exit 2 carrying the CLI's "Failed to
 * call tool" prefix is a server-side rejection. Anything else — a flag the
 * CLI failed to register, a required-argument check that tripped on a value
 * the planner supplied, a crash — is a violation.
 */
export function judgeProbe(execution: ProbeExecution): ProbeVerdict {
  if (execution.exitCode === 0) return {ok: true, outcome: 'answered'}
  if (execution.exitCode === 2 && execution.stderr.includes('Failed to call tool')) {
    return {ok: true, outcome: 'rejected'}
  }

  return {ok: false, violation: `exit ${execution.exitCode}: ${oneLine(execution.stderr).slice(0, 300)}`}
}

/** oclif wraps error text across ` ›   ` continuation lines; flatten it for a one-line report. */
function oneLine(text: string): string {
  const words = text.split('\n').flatMap((line) => line.replaceAll('›', ' ').split(' '))
  return words.filter(Boolean).join(' ')
}

const TRANSIENT_MARKERS = ['429', 'rate limit', 'ECONNRESET', 'ETIMEDOUT', 'fetch failed', 'socket hang up']

/** A rate limit or transport hiccup — worth another attempt, not a verdict. */
export function shouldRetry(execution: ProbeExecution): boolean {
  if (execution.exitCode === 0) return false
  const stderr = execution.stderr.toLowerCase()
  return TRANSIENT_MARKERS.some((marker) => stderr.includes(marker.toLowerCase()))
}

/**
 * Runs `worker` over every item with at most `limit` concurrent executions,
 * preserving no ordering guarantees. Worker errors propagate after the in-flight
 * batch settles.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const item = items[next++]
      // The sequential-await loop IS the pool: `limit` of these runners drain
      // the shared index concurrently.
      // eslint-disable-next-line no-await-in-loop
      await worker(item)
    }
  })

  await Promise.all(runners)
}

export type SweepSummary = {
  answered: number
  attempted: number
  coverage: number
  skipped: number
  total: number
  violations: Array<{toolName: string; violation: string}>
}

/**
 * Aggregates probe results: coverage is attempted / total over the whole tool
 * list (skips count against coverage — that is what keeps the gate honest when
 * a server grows faster than the sweep can safely probe it).
 */
export function summarize(results: readonly ProbeResult[]): SweepSummary {
  const total = results.length
  const skipped = results.filter((r) => r.plan.kind === 'skip').length
  const attempted = total - skipped
  const answered = results.filter((r) => r.verdict.ok && r.verdict.outcome === 'answered').length
  const violations = results.flatMap((r) =>
    r.verdict.ok ? [] : [{toolName: r.plan.toolName, violation: r.verdict.violation}],
  )

  return {answered, attempted, coverage: total === 0 ? 0 : attempted / total, skipped, total, violations}
}
