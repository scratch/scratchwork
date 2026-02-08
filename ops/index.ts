#!/usr/bin/env bun

import { Command } from 'commander'
import { registerServerCommands } from './commands/server/index'
import { registerCliCommands } from './commands/cli'
import { registerPrCommand } from './commands/pr'
import { registerCommitCommand } from './commands/commit'
import { registerWebsiteCommands } from './commands/website'
import { registerTestCommand } from './commands/test'

const program = new Command()

program
  .name('ops')
  .description('Scratchwork ops CLI')
  .version('1.0.0')

registerServerCommands(program)
registerCliCommands(program)
registerTestCommand(program)
registerPrCommand(program)
registerCommitCommand(program)
registerWebsiteCommands(program)

program.parse()
