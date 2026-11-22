// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'
import type { RunsSnapshot } from './protocol'

const ONE_RUN: RunsSnapshot = {
  runs: [{ runId: 'run-1', projectId: 'site', target: 'business/web', state: 'delivered', inProgress: false, gate: 'pass', outputsRoot: '/out/site' }],
  active: 0,
  error: null
}

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

test('lists the runs and reads them again on Refresh', async () => {
  let refreshes = 0
  // Stands in for src/worker.ts: what each plugin.request answers.
  const host = mockHost({
    requests: {
      'runs.list': () => ({ runs: [], active: 0, error: null }),
      'runs.refresh': () => {
        refreshes += 1
        return ONE_RUN
      }
    }
  })
  panel = await mount(panelModule, { host })
  assert.match(panel.summary().join('\n'), /No runs yet/)

  await panel.press({ label: 'Refresh' })
  assert.equal(refreshes, 1)
  const text = JSON.stringify(panel.tree())
  for (const shown of ['site', 'delivered', 'gate: pass', '/out/site']) assert.ok(text.includes(shown), shown)

  // The worker read again on its own: an agent changed status, or the timer fired.
  await panel.post('runs.changed', { runs: [], active: 0, error: 'nrv: command not found' })
  assert.match(panel.summary().join('\n'), /Could not read the runs/)
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.refusals, [])
})
