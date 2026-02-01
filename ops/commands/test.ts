import { Command } from 'commander'

// Colors for output
const green = '\x1b[32m'
const red = '\x1b[31m'
const yellow = '\x1b[33m'
const reset = '\x1b[0m'

interface TestSuiteResult {
  name: string
  passed: boolean
  skipped: boolean
}

async function runTestSuite(
  name: string,
  command: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<TestSuiteResult> {
  console.log(`\n${yellow}━━━ Running: ${name} ━━━${reset}\n`)

  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })

  const exitCode = await proc.exited
  const passed = exitCode === 0

  if (passed) {
    console.log(`\n${green}✓ ${name} passed${reset}`)
  } else {
    console.log(`\n${red}✗ ${name} failed (exit code ${exitCode})${reset}`)
  }

  return { name, passed, skipped: false }
}

export async function testAction(options: {
  instance?: string
  skipServer?: boolean
}): Promise<void> {
  const instance = options.instance || 'staging'
  const results: TestSuiteResult[] = []

  console.log(`\n${yellow}╔════════════════════════════════════════╗${reset}`)
  console.log(`${yellow}║       Running All Test Suites          ║${reset}`)
  console.log(`${yellow}╚════════════════════════════════════════╝${reset}`)

  // 1. CLI Unit Tests
  results.push(await runTestSuite('CLI Unit Tests', ['bun', 'run', 'test:unit'], { cwd: 'cli' }))

  // 2. CLI E2E Tests
  results.push(await runTestSuite('CLI E2E Tests', ['bun', 'run', 'test:e2e'], { cwd: 'cli' }))

  // 3. Ops Unit Tests
  results.push(await runTestSuite('Ops Unit Tests', ['bun', 'test', './ops/test/']))

  // 4. Server Integration Tests (optional skip)
  if (options.skipServer) {
    console.log(`\n${yellow}━━━ Skipping: Server Integration Tests ━━━${reset}`)
    results.push({ name: 'Server Integration Tests', passed: true, skipped: true })
  } else {
    results.push(
      await runTestSuite(
        `Server Integration Tests (${instance})`,
        ['bun', 'test', './ops/commands/server/test/index.ts', '--timeout', '600000'],
        { env: { TEST_INSTANCE: instance } }
      )
    )
  }

  // Summary
  console.log(`\n${yellow}╔════════════════════════════════════════╗${reset}`)
  console.log(`${yellow}║            Test Summary                ║${reset}`)
  console.log(`${yellow}╚════════════════════════════════════════╝${reset}\n`)

  let allPassed = true
  for (const result of results) {
    if (result.skipped) {
      console.log(`  ${yellow}○${reset} ${result.name} (skipped)`)
    } else if (result.passed) {
      console.log(`  ${green}✓${reset} ${result.name}`)
    } else {
      console.log(`  ${red}✗${reset} ${result.name}`)
      allPassed = false
    }
  }

  const passedCount = results.filter((r) => r.passed && !r.skipped).length
  const skippedCount = results.filter((r) => r.skipped).length
  const failedCount = results.filter((r) => !r.passed).length
  const totalRan = results.length - skippedCount

  console.log(
    `\n  Total: ${totalRan} suites, ${green}${passedCount} passed${reset}${failedCount > 0 ? `, ${red}${failedCount} failed${reset}` : ''}${skippedCount > 0 ? `, ${yellow}${skippedCount} skipped${reset}` : ''}`
  )

  if (!allPassed) {
    console.log(`\n${red}Some tests failed.${reset}`)
    process.exit(1)
  }

  console.log(`\n${green}All tests passed!${reset}`)
}

export function registerTestCommand(program: Command): void {
  program
    .command('test')
    .description('Run all tests (CLI unit, CLI e2e, ops unit, server integration)')
    .option('-i, --instance <instance>', 'Server instance for integration tests (default: staging)')
    .option('--skip-server', 'Skip server integration tests')
    .action(async (options) => {
      await testAction(options)
    })
}
