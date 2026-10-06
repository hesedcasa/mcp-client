import {expect} from 'chai'

import {
  type CachedTool,
  judgeProbe,
  planProbe,
  PROBE_VALUE,
  type ProbeResult,
  runPool,
  shouldRetry,
  summarize,
} from './sweep-helpers.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function tool(
  name: string,
  readOnlyHint: boolean | undefined,
  properties: CachedTool['inputSchema']['properties'] = {},
  required: string[] = [],
): CachedTool {
  return {
    ...(readOnlyHint !== undefined && {annotations: {readOnlyHint}}),
    inputSchema: {properties, required, type: 'object'},
    name,
  }
}

describe('sweep helpers', () => {
  // ─── planProbe ───────────────────────────────────────────────────────────────

  describe('sweep planProbe', () => {
    it('never invokes a tool annotated readOnlyHint: false', () => {
      const plan = planProbe('github', tool('issue_write', false), {})
      expect(plan.kind).to.equal('skip')
    })

    it('never invokes a tool with no annotation at all', () => {
      const plan = planProbe('github', tool('mystery', undefined), {})
      expect(plan.kind).to.equal('skip')
    })

    it('skips an excluded read-only tool with the caller-supplied reason', () => {
      const plan = planProbe(
        'github',
        tool('run_secret_scanning', true),
        {},
        new Map([['run_secret_scanning', 'uploads']]),
      )
      expect(plan).to.deep.equal({kind: 'skip', reason: 'uploads', toolName: 'run_secret_scanning'})
    })

    it('invokes an argless read-only tool as `<server> <tool>`', () => {
      const plan = planProbe('github', tool('get_me', true), {})
      expect(plan).to.deep.equal({args: ['github', 'get_me'], kind: 'invoke', toolName: 'get_me'})
    })

    it('fills required args from supplied values, then the schema', () => {
      const plan = planProbe(
        'github',
        tool(
          'issue_read',
          true,
          {
            issue_number: {type: 'number'},
            method: {enum: ['get', 'get_comments'], type: 'string'},
            owner: {type: 'string'},
            tag: {type: 'string'},
            verbose: {type: 'boolean'},
          },
          ['owner', 'method', 'issue_number', 'tag', 'verbose'],
        ),
        {owner: 'hesedcasa'},
      )

      expect(plan.kind).to.equal('invoke')
      if (plan.kind !== 'invoke') return
      expect(plan.args).to.deep.equal([
        'github',
        'issue_read',
        '--owner',
        'hesedcasa',
        '--method',
        'get',
        '--issue_number',
        '1',
        '--tag',
        PROBE_VALUE,
        '--verbose',
      ])
    })

    it('leaves optional properties out', () => {
      const plan = planProbe(
        'github',
        tool('list_tags', true, {owner: {type: 'string'}, page: {type: 'number'}}, ['owner']),
        {
          owner: 'o',
        },
      )
      expect(plan.kind === 'invoke' && plan.args).to.deep.equal(['github', 'list_tags', '--owner', 'o'])
    })

    it('prefers a supplied value over the enum default', () => {
      const plan = planProbe('github', tool('ui_get', true, {method: {enum: ['labels', 'branches']}}, ['method']), {
        method: 'branches',
      })
      expect(plan.kind === 'invoke' && plan.args).to.deep.equal(['github', 'ui_get', '--method', 'branches'])
    })

    it('skips a tool whose required structured argument it cannot invent', () => {
      const plan = planProbe('github', tool('scan', true, {files: {type: 'array'}}, ['files']), {})
      expect(plan.kind).to.equal('skip')
      expect(plan.kind === 'skip' && plan.reason).to.contain('"files"')
    })
  })

  // ─── judgeProbe / shouldRetry ────────────────────────────────────────────────

  describe('sweep judgeProbe', () => {
    it('treats exit 0 as an answer', () => {
      expect(judgeProbe({exitCode: 0, stderr: '', stdout: '{}'})).to.deep.equal({ok: true, outcome: 'answered'})
    })

    it('treats a server-side tool failure as a rejection, not a violation', () => {
      const verdict = judgeProbe({
        exitCode: 2,
        stderr: ' ›   Error: Failed to call tool "get_tag": 404 Not Found',
        stdout: '',
      })
      expect(verdict).to.deep.equal({ok: true, outcome: 'rejected'})
    })

    it('flags a CLI-side error as a violation', () => {
      const verdict = judgeProbe({
        exitCode: 2,
        stderr: ' ›   Error: Nonexistent flag: --owner\n ›   See more help',
        stdout: '',
      })
      expect(verdict.ok).to.be.false
      expect(!verdict.ok && verdict.violation).to.equal('exit 2: Error: Nonexistent flag: --owner See more help')
    })

    it('flags a crash as a violation even when it mentions a tool failure', () => {
      expect(judgeProbe({exitCode: 1, stderr: 'Failed to call tool', stdout: ''}).ok).to.be.false
    })
  })

  describe('sweep shouldRetry', () => {
    it('retries rate limits and transport failures', () => {
      expect(shouldRetry({exitCode: 2, stderr: 'API rate limit exceeded', stdout: ''})).to.be.true
      expect(shouldRetry({exitCode: 2, stderr: 'HTTP 429', stdout: ''})).to.be.true
      expect(shouldRetry({exitCode: 2, stderr: 'TypeError: fetch failed', stdout: ''})).to.be.true
    })

    it('does not retry a success or an ordinary rejection', () => {
      expect(shouldRetry({exitCode: 0, stderr: 'rate limit', stdout: ''})).to.be.false
      expect(shouldRetry({exitCode: 2, stderr: 'Failed to call tool: 404 Not Found', stdout: ''})).to.be.false
    })
  })

  // ─── summarize / runPool ─────────────────────────────────────────────────────

  describe('sweep summarize', () => {
    it('counts skips against coverage and collects violations', () => {
      const results: ProbeResult[] = [
        {plan: {args: [], kind: 'invoke', toolName: 'a'}, verdict: {ok: true, outcome: 'answered'}},
        {plan: {args: [], kind: 'invoke', toolName: 'b'}, verdict: {ok: true, outcome: 'rejected'}},
        {plan: {args: [], kind: 'invoke', toolName: 'c'}, verdict: {ok: false, violation: 'boom'}},
        {plan: {kind: 'skip', reason: 'r', toolName: 'd'}, verdict: {ok: true, outcome: 'skipped'}},
      ]

      expect(summarize(results)).to.deep.equal({
        answered: 1,
        attempted: 3,
        coverage: 0.75,
        skipped: 1,
        total: 4,
        violations: [{toolName: 'c', violation: 'boom'}],
      })
    })

    it('reports zero coverage for an empty tool list', () => {
      expect(summarize([]).coverage).to.equal(0)
    })
  })

  describe('sweep runPool', () => {
    it('visits every item without exceeding the concurrency limit', async () => {
      let inFlight = 0
      let peak = 0
      const seen: number[] = []

      await runPool([1, 2, 3, 4, 5], 2, async (item) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })
        seen.push(item)
        inFlight--
      })

      expect(seen).to.have.members([1, 2, 3, 4, 5])
      expect(peak).to.equal(2)
    })
  })
})
