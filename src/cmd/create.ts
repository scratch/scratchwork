import { materializeProjectTemplates } from '../template';
import log from '../logger';

interface CreateOptions {
  full?: boolean;
  examples?: boolean;
}

/**
 * Prompt user with a yes/no question.
 * Returns true for yes (default), false for no.
 */
async function promptYesNo(question: string): Promise<boolean> {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const response = await new Promise<string>((resolve) => {
    rl.question(`${question} (Y/n) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
  return response !== 'n' && response !== 'no';
}

/**
 * Create a new Scratch project.
 *
 * Flags:
 * - --full: Include theme.css and components (skip prompt)
 * - --no-full: Exclude theme.css and components (skip prompt)
 * - --examples: Include example pages (skip prompt)
 * - --no-examples: Exclude example pages (skip prompt)
 *
 * If a flag is not provided, prompts interactively.
 */
export async function createCommand(targetPath: string, options: CreateOptions = {}) {
  let includeComponents: boolean;
  let includeExamples: boolean;

  // Determine whether to include components (--full / --no-full)
  if (options.full !== undefined) {
    includeComponents = options.full;
  } else {
    includeComponents = await promptYesNo('Include theme.css, PageWrapper.jsx, and Markdown components?');
  }

  // Determine whether to include examples (--examples / --no-examples)
  if (options.examples !== undefined) {
    includeExamples = options.examples;
  } else {
    includeExamples = await promptYesNo('Include examples?');
  }

  const created = await materializeProjectTemplates(targetPath, {
    includeComponents,
    includeExamples,
  });

  if (created.length > 0) {
    log.info('Created:');
    for (const file of created.sort()) {
      log.info(`  ${file}`);
    }
    log.info('');
    log.info('Start the development server:');
    if (targetPath !== '.') {
      log.info(`  cd ${targetPath}`);
    }
    log.info('  scratch dev');
  } else {
    log.info('No files created (project already exists)');
  }
}
