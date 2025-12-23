import path from 'path';
import { hasTemplate, materializeTemplate, listTemplateFiles } from '../template';
import log from '../logger';

interface RevertOptions {
  list?: boolean;
}

/**
 * Revert a file to its template version.
 */
export async function revertCommand(filePath: string | undefined, options: RevertOptions = {}): Promise<void> {
  // List available templates if --list flag is provided
  if (options.list) {
    const files = listTemplateFiles();
    log.info('Available template files:');
    for (const file of files.sort()) {
      console.log(`  ${file}`);
    }
    return;
  }

  if (!filePath) {
    log.error('Please provide a file path to revert, or use --list to see available templates.');
    process.exit(1);
  }

  // Normalize the path (remove leading ./ if present)
  const templatePath = filePath.replace(/^\.\//, '');

  if (!hasTemplate(templatePath)) {
    log.error(`No template found for: ${templatePath}`);
    console.log(`\nThis command should be run from the project root.`);
    console.log(`Use 'scratch revert --list' to see all available templates.`);
    process.exit(1);
  }

  // Target path in the project (cwd)
  const targetPath = path.resolve(process.cwd(), templatePath);

  // Copy template to target
  await materializeTemplate(templatePath, targetPath);
  log.info(`Reverted ${templatePath}`);
}
