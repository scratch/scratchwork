import { materializeProjectTemplates } from '../template';
import log from '../logger';

/**
 * Initialize a minimal Scratch project.
 * Creates only the essential files: pages/, public/, .gitignore, AGENTS.md
 * No prompts - just creates the minimal structure.
 */
export async function initCommand(targetPath: string) {
  const created = await materializeProjectTemplates(targetPath, {
    includeComponents: false,
    includeExamples: false,
  });

  if (created.length > 0) {
    log.info('Initialized:');
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
