// The "Nirvana" sidebar panel: the runs the worker last read, and a button to read them again.
// Read-only. No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  type PanelContext,
  type Tone
} from 'orca'
import type { RunsSnapshot } from './protocol'

/** What the worker last reported; null until it answers. */
const snapshot = atom<RunsSnapshot | null>(null)
const refreshing = atom(false)

const STATE_TONES: Record<string, Tone> = {
  delivered: 'success',
  withheld: 'warning',
  stalled: 'warning',
  failed: 'danger',
  abandoned: 'danger'
}

async function refresh(): Promise<void> {
  set(refreshing, true)
  try {
    set(snapshot, await plugin.request('runs.refresh'))
  } catch (error) {
    set(snapshot, { runs: [], active: 0, error: error instanceof Error ? error.message : String(error) })
  } finally {
    set(refreshing, false)
  }
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('runs.changed', (payload) => set(snapshot, payload)))
  void plugin.request('runs.list').then(
    (answer) => set(snapshot, answer),
    () => refresh()
  )
}

export default function Panel() {
  const current = read(snapshot)
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Nirvana runs</Heading>
        <IconButton icon="refresh" label="Refresh" variant="ghost" disabled={read(refreshing)} onPress={refresh} />
      </Row>
      {current?.error ? (
        <Callout tone="warning" title="Could not read the runs">
          <Text>{current.error}</Text>
        </Callout>
      ) : null}
      {current && !current.error && current.runs.length === 0 ? (
        <EmptyState icon="activity" title="No runs yet" description="A run appears here when Nirvana-OS dispatches one." />
      ) : null}
      {current && current.runs.length > 0 ? (
        <List label="Recent runs">
          {current.runs.map((run) => (
            <ListItem key={run.runId} title={run.projectId} description={run.outputsRoot ?? 'No deliverables folder recorded'}>
              <Row gap="xs" wrap>
                <Badge tone={run.inProgress ? 'accent' : (STATE_TONES[run.state] ?? 'neutral')}>{run.state}</Badge>
                <Badge tone={run.gate === 'pass' ? 'success' : run.gate ? 'warning' : 'neutral'}>
                  {run.gate ? `gate: ${run.gate}` : 'not gated'}
                </Badge>
                <Text muted size="xs">
                  {run.target}
                </Text>
              </Row>
            </ListItem>
          ))}
        </List>
      ) : null}
    </Stack>
  )
}
