// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
// `seams.run` stands in for the `nrv` child process: no test starts a real one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, mountWorker, test, type TestWorker } from 'orca/testing'
import * as main from './worker'

const realRun = main.seams.run
let calls: { args: string[]; cwd: string }[] = []
let folder = ''
let worker: TestWorker | undefined

const RUNS = JSON.stringify({
  scope: 'all projects',
  runs: [
    // Open in the ledger since last month, with nothing working on it: listed, never counted.
    { run_id: 'run-0', project_id: 'old', target_kind: 'squad', target_slug: 'copy', state: 'stalled', in_progress: false, gate: null, outputs_root: null, updated_at: '2026-10-01T10:00:00.000Z' },
    { run_id: 'run-1', project_id: 'site', target_kind: 'business', target_slug: 'web', state: 'delivered', in_progress: false, gate: 'pass', outputs_root: '/out/site', updated_at: '2026-11-22T10:00:00.000Z' },
    { run_id: 'run-2', project_id: 'book', target_kind: 'squad', target_slug: 'copy', state: 'running', in_progress: true, gate: null, outputs_root: null, updated_at: '2026-11-22T09:00:00.000Z' }
  ]
})

/** `nrv` as the tests see it: `init` answers with `init()`, the status read with `status`. */
function fakeNrv(init: () => string = () => '', status = RUNS): void {
  main.seams.run = async (args, cwd) => {
    calls.push({ args, cwd })
    return args[0] === 'init' ? init() : status
  }
}

const created = (path: string) => ({ workspaceId: 'w1', kind: 'worktree' as const, path, branch: 'main' })
const adoptions = () => calls.filter((call) => call.args[0] === 'init')

beforeEach(() => {
  calls = []
  folder = mkdtempSync(join(tmpdir(), 'nirvana-orca-plugin-'))
  fakeNrv()
})

afterEach(async () => {
  await worker?.deactivate()
  worker = undefined
  main.seams.run = realRun
  rmSync(folder, { recursive: true, force: true })
})

test('workspace.created adopts a folder that is not a Nirvana project', async () => {
  worker = await mountWorker(main)
  await worker.emit('workspace.created', created(folder))
  assert.deepEqual(adoptions(), [{ args: ['init', '.', '--adopt'], cwd: folder }])
  assert.ok(worker.logs.some((line) => line.includes('adopted as a Nirvana project')))
  assert.deepEqual(worker.refusals, [])
})

test('workspace.created skips a folder that is already a Nirvana project', async () => {
  mkdirSync(join(folder, '.nirvana'))
  writeFileSync(join(folder, '.nirvana', 'project.yaml'), 'id: demo\n')
  worker = await mountWorker(main)
  await worker.emit('workspace.created', created(folder))
  assert.deepEqual(adoptions(), [])
  assert.ok(worker.logs.some((line) => line.includes('already a Nirvana project')))
})

test('workspace.created skips a folder that is not on this machine', async () => {
  worker = await mountWorker(main)
  await worker.emit('workspace.created', created(join(folder, 'remote-only')))
  assert.deepEqual(adoptions(), [])
})

test('workspace.created survives a failing nrv', async () => {
  fakeNrv(() => {
    throw new Error('nrv: command not found')
  })
  worker = await mountWorker(main)
  await worker.emit('workspace.created', created(folder))
  assert.equal(adoptions().length, 1)
  assert.ok(worker.logs.some((line) => line.includes('could not adopt') && line.includes('command not found')))
})

test('shows the runs in progress in the status bar and answers the panel', async () => {
  worker = await mountWorker(main)
  const snapshot = await worker.request('runs.refresh')
  assert.equal(snapshot.active, 1)
  assert.deepEqual(snapshot.runs.map((run) => run.runId), ['run-2', 'run-1', 'run-0'])
  assert.deepEqual(snapshot.runs[1], {
    runId: 'run-1',
    projectId: 'site',
    target: 'business/web',
    state: 'delivered',
    inProgress: false,
    gate: 'pass',
    outputsRoot: '/out/site'
  })
  assert.deepEqual(await worker.request('runs.list'), snapshot)
  const update = worker.host.callsOf('statusBar.update').at(-1) as { id: string; text: string }
  assert.equal(update.id, 'runs')
  assert.equal(update.text, 'Nirvana: 1')
  assert.deepEqual(worker.posts.at(-1), { event: 'runs.changed', payload: snapshot })
  assert.deepEqual(worker.refusals, [])
})

test('reports an engine that does not answer in JSON instead of throwing', async () => {
  fakeNrv(undefined, 'supervisor: no non-terminal runs in all projects. Ledger is clean.\n')
  worker = await mountWorker(main)
  const snapshot = await worker.request('runs.refresh')
  assert.deepEqual(snapshot.runs, [])
  assert.match(snapshot.error ?? '', /nrv update/)
})
