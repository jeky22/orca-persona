import { assert, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('activate registers both commands and passes an unrelated launch', async () => {
  const worker = await mountWorker(main)
  assert.equal(await worker.command('persona.status'), 'persona: —')
  const decision = await worker.hooks.fire('agent.launch.before',
    { agent: 'gemini', workspaceId: null, workspaceKind: null, command: 'gemini', env: {} })
  assert.equal(decision.kind, 'continue')
  await worker.deactivate()
})
