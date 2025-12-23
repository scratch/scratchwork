import path from 'path';
import { hasTemplate, materializeTemplate, listTemplateFiles } from '../template';
import log from '../logger';

interface RevertOptions {
  list?: boolean;
}

/**
 * Revert a file or directory to its template version.
 */
export async function revertCommand(filePath: string | undefined, options: RevertOptions = {}): Promise<void> {
  const allFiles = listTemplateFiles();

  // List available templates if --list flag is provided
  if (options.list) {
    log.info('Available template files:');
    for (const file of allFiles.sort()) {
      // Skip internal build infrastructure
      if (file.startsWith('_build/')) continue;
      console.log(`  ${file}`);
    }
    return;
  }

  if (!filePath) {
    log.error('Please provide a file or directory path to revert, or use --list to see available templates.');
    process.exit(1);
  }

  // Normalize the path (remove leading ./ and trailing /)
  const templatePath = filePath.replace(/^\.\//, '').replace(/\/$/, '');

  // Check if it's an exact file match
  if (hasTemplate(templatePath)) {
    const targetPath = path.resolve(process.cwd(), templatePath);
    await materializeTemplate(templatePath, targetPath);
    log.info(`Reverted ${templatePath}`);
    return;
  }

  // Check if it's a directory (find all templates that start with this path)
  const dirPrefix = templatePath + '/';
  const matchingFiles = allFiles.filter(f => f.startsWith(dirPrefix));

  if (matchingFiles.length > 0) {
    for (const file of matchingFiles) {
      const targetPath = path.resolve(process.cwd(), file);
      await materializeTemplate(file, targetPath);
      log.info(`Reverted ${file}`);
    }
    return;
  }

  // No match found
  log.error(`No template found for: ${templatePath}`);
  console.log(`\nThis command should be run from the project root.`);
  console.log(`Use 'scratch revert --list' to see all available templates.`);
  process.exit(1);
}
