import fs from 'fs/promises';
import path from 'path';
import log from './logger';
import { templates } from './template.generated';

export { templates };

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Write project templates to a target directory.
 * Excludes _build/ files (internal build infrastructure).
 * Optionally includes pages/examples/ files.
 * Returns list of files that were created.
 */
export async function materializeProjectTemplates(
  targetDir: string,
  options: { includeExamples?: boolean; overwrite?: boolean } = {}
): Promise<string[]> {
  const { includeExamples = false, overwrite = false } = options;
  const created: string[] = [];

  await fs.mkdir(targetDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(templates)) {
    // Skip _build/ files (internal build infrastructure)
    if (relativePath.startsWith('_build/')) {
      continue;
    }

    // Skip examples unless explicitly included
    if (!includeExamples && relativePath.startsWith('pages/examples/')) {
      continue;
    }

    const targetPath = path.join(targetDir, relativePath);
    const targetDirPath = path.dirname(targetPath);

    await fs.mkdir(targetDirPath, { recursive: true });

    const exists = await fs.exists(targetPath);
    if (exists && !overwrite) {
      log.debug(`Skipped ${relativePath}`);
      continue;
    }

    await fs.writeFile(targetPath, content);
    log.debug(`${exists ? 'Overwrote' : 'Wrote'} ${relativePath}`);
    created.push(relativePath);
  }

  return created;
}

/**
 * Write a single template file to a target path.
 * Creates parent directories as needed.
 */
export async function materializeTemplate(
  templatePath: string,
  targetPath: string
): Promise<void> {
  const content = templates[templatePath];

  if (!content) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

/**
 * Get the content of a template file without writing to disk.
 */
export function getTemplateContent(templatePath: string): string {
  const content = templates[templatePath];

  if (!content) {
    throw new Error(`Template not found: ${templatePath}`);
  }

  return content;
}

/**
 * Check if a template file exists.
 */
export function hasTemplate(templatePath: string): boolean {
  return templatePath in templates;
}

/**
 * List all template files.
 */
export function listTemplateFiles(): string[] {
  return Object.keys(templates);
}
