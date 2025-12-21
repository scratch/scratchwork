import fs from 'fs/promises';
import path from 'path';
import log from './logger';
import { templates } from './template.generated';

export { templates };

// ============================================================================
// TEMPLATE TIERS
// ============================================================================

/**
 * Files included in minimal tier (init command, or create --no-full --no-examples)
 * All other project files are in the "full" tier (components, theme.css)
 */
const MINIMAL_FILES = new Set([
  '.gitignore',
  'AGENTS.md',
  'pages/index.mdx',
  'pages/Counter.jsx',
  'public/scratch.svg',
]);

/**
 * Check if a file belongs to the minimal tier
 */
function isMinimalFile(relativePath: string): boolean {
  // Check exact matches
  if (MINIMAL_FILES.has(relativePath)) {
    return true;
  }
  // public/ directory (for any future files)
  if (relativePath.startsWith('public/')) {
    return true;
  }
  return false;
}

/**
 * Check if a file belongs to the examples tier
 */
function isExamplesFile(relativePath: string): boolean {
  return relativePath.startsWith('pages/examples/');
}

/**
 * Check if a file belongs to the full tier (components + theme)
 */
function isFullFile(relativePath: string): boolean {
  return (
    relativePath === 'theme.css' ||
    relativePath.startsWith('components/')
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export interface MaterializeOptions {
  /** Include theme.css and components/ (default: true) */
  includeComponents?: boolean;
  /** Include pages/examples/ (default: false) */
  includeExamples?: boolean;
  /** Overwrite existing files (default: false) */
  overwrite?: boolean;
}

/**
 * Write project templates to a target directory.
 * Excludes _build/ files (internal build infrastructure).
 *
 * Tiers:
 * - Minimal: pages/index.mdx, pages/Counter.jsx, public/, .gitignore, AGENTS.md
 * - Full components: theme.css, components/* (controlled by includeComponents)
 * - Examples: pages/examples/* (controlled by includeExamples)
 *
 * Returns list of files that were created.
 */
export async function materializeProjectTemplates(
  targetDir: string,
  options: MaterializeOptions = {}
): Promise<string[]> {
  const { includeComponents = true, includeExamples = false, overwrite = false } = options;
  const created: string[] = [];

  await fs.mkdir(targetDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(templates)) {
    // Skip _build/ files (internal build infrastructure)
    if (relativePath.startsWith('_build/')) {
      continue;
    }

    // Determine if file should be included based on tier
    const isMinimal = isMinimalFile(relativePath);
    const isFull = isFullFile(relativePath);
    const isExamples = isExamplesFile(relativePath);

    // Skip full tier files unless includeComponents is true
    if (isFull && !includeComponents) {
      continue;
    }

    // Skip examples unless includeExamples is true
    if (isExamples && !includeExamples) {
      continue;
    }

    // Skip files that don't belong to any known tier (shouldn't happen)
    if (!isMinimal && !isFull && !isExamples) {
      log.debug(`Skipping unknown tier file: ${relativePath}`);
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
