import path from 'path';
import fs from 'fs/promises';
import { materializeProjectTemplates } from '../template';
import { BUILD_DEPENDENCIES } from '../context';
import log from '../logger';

interface CreateOptions {
  src?: boolean;
  examples?: boolean;
  package?: boolean;
  minimal?: boolean;
  full?: boolean;
}

/**
 * Generate a package.json file for the project.
 */
async function generatePackageJson(targetDir: string, projectName: string): Promise<void> {
  const packageJson = {
    name: projectName,
    private: true,
    scripts: {
      dev: 'scratch dev',
      build: 'scratch build',
    },
    dependencies: Object.fromEntries(
      BUILD_DEPENDENCIES.map(pkg => [pkg, 'latest'])
    ),
  };

  const packageJsonPath = path.join(targetDir, 'package.json');
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
}

/**
 * Create a new Scratch project.
 * Flag-based with sensible defaults.
 *
 * Defaults: --src, --examples, --no-package
 * Shorthands: --minimal (no src, no examples, no package), --full (everything)
 */
export async function createCommand(targetPath: string, options: CreateOptions = {}) {
  // Start with defaults
  let includeSrc = true;
  let includeExamples = true;
  let includePackage = false;

  // Apply shorthand flags first
  if (options.minimal) {
    includeSrc = false;
    includeExamples = false;
    includePackage = false;
  }
  if (options.full) {
    includeSrc = true;
    includeExamples = true;
    includePackage = true;
  }

  // Explicit flags override shorthands
  if (options.src !== undefined) includeSrc = options.src;
  if (options.examples !== undefined) includeExamples = options.examples;
  if (options.package !== undefined) includePackage = options.package;

  const created = await materializeProjectTemplates(targetPath, {
    includeSrc,
    includeExamples,
  });

  // Generate package.json if requested
  if (includePackage) {
    const projectName = path.basename(path.resolve(targetPath));
    await generatePackageJson(targetPath, projectName);
    created.push('package.json');
  }

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
