import type { OrcaWorkerApi } from 'orca/worker'

export default function activate(orca: OrcaWorkerApi): void {
  orca.commands.register('persona.status', () => 'persona: —')
  orca.commands.register('persona.applyGit', () => 'not implemented')
  orca.hooks.on('agent.launch.before', () => undefined)
  orca.hooks.on('workspace.create.after', () => undefined)
}
