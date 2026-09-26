import 'reflect-metadata'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../src/config/env'

/**
 * S9 acceptance orchestrator.
 *
 * S9 spans four prompts and three independent suites: the notification
 * read/mark surface plus booking-event wiring, WebSocket delivery, and the
 * FR-61 email outbox. Each suite is a standalone script that boots and tears
 * down its own DataSource (and, for realtime/email, its own HTTP server on an
 * ephemeral port), so this runner executes them sequentially in child processes
 * rather than importing them — importing would run three `main()` side effects
 * in one process against one port.
 *
 * Every suite cleans up after itself, so all of them run even if an earlier one
 * fails: a single command then reports all three verdicts instead of hiding
 * them behind the first failure. Any failure fails the run.
 */

interface S9Suite {
  readonly label: string
  readonly file: string
}

const SUITES: readonly S9Suite[] = [
  {
    label: 'S9.1/2 notifications CRUD + booking-event wiring (FR-57/58/59/60/90)',
    file: 'src/modules/notification/__tests__/notification.acceptance.ts',
  },
  {
    label: 'S9.3 websocket delivery (handshake auth, live push, fan-out)',
    file: 'src/realtime/__tests__/realtime.acceptance.ts',
  },
  {
    label: 'S9.4 email outbox (FR-61 enqueue, dispatch, retry, dead-letter)',
    file: 'src/email/__tests__/email.acceptance.ts',
  },
]

function log(line: string): void {
  console.log(line)
}

/**
 * Prefers the workspace's own tsx CLI (resolved from disk, so the child cannot
 * silently pick up a different tsx or a network-fetched one) and falls back to
 * npx only if the layout is unexpected.
 */
function resolveRunner(serverRoot: string): { command: string; prefixArgs: readonly string[] } {
  // serverRoot is apps/server, so the hoisted workspace root is two levels up.
  const candidates = [
    path.join(serverRoot, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(serverRoot, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: process.execPath, prefixArgs: [candidate] }
    }
  }
  return { command: 'npx', prefixArgs: ['tsx'] }
}

function main(): void {
  const serverRoot = path.join(__dirname, '..')
  const runner = resolveRunner(serverRoot)

  log(`S9 acceptance suite — ${String(SUITES.length)} suites, db ${loadEnv().db.name}, runner ${runner.command}`)
  log('')

  const failures: string[] = []

  for (const [index, suite] of SUITES.entries()) {
    const suitePath = path.join(serverRoot, suite.file)
    if (!fs.existsSync(suitePath)) {
      log(`FAIL  [${String(index + 1)}/${String(SUITES.length)}] ${suite.label}`)
      log(`        missing suite file: ${suite.file}`)
      failures.push(suite.label)
      continue
    }

    log(`--- [${String(index + 1)}/${String(SUITES.length)}] ${suite.label}`)
    const startedAt = Date.now()
    const result = spawnSync(runner.command, [...runner.prefixArgs, suite.file], {
      cwd: serverRoot,
      stdio: 'inherit',
      env: process.env,
    })
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

    if (result.error !== undefined) {
      // spawnSync surfaces ENOENT and friends here; treat it as a failure
      // rather than letting a null status read as a pass.
      log(`FAIL  [${String(index + 1)}/${String(SUITES.length)}] ${suite.label} — could not start: ${result.error.message}`)
      failures.push(suite.label)
      continue
    }

    if (result.status === 0) {
      log(`PASS  [${String(index + 1)}/${String(SUITES.length)}] ${suite.label} (${seconds}s)`)
    } else {
      const reason = result.signal === null ? `exit ${String(result.status)}` : `signal ${result.signal}`
      log(`FAIL  [${String(index + 1)}/${String(SUITES.length)}] ${suite.label} — ${reason} (${seconds}s)`)
      failures.push(suite.label)
    }
    log('')
  }

  if (failures.length === 0) {
    log('RESULT: all S9 acceptance suites passed')
    process.exit(0)
  }

  log(`RESULT: ${String(failures.length)} of ${String(SUITES.length)} S9 suite(s) FAILED:`)
  for (const failure of failures) {
    log(`  - ${failure}`)
  }
  process.exit(1)
}

main()
