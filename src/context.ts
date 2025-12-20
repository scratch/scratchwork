import { buildFileMap, type FileMapResult } from './util';
import _path from 'path';
import fs from 'fs/promises';
import { globSync } from 'fast-glob';
import template from './template';
import log from './logger';

const BUILD_DEPENDENCIES = ['react', 'react-dom', '@mdx-js/react', 'tailwindcss', '@tailwindcss/cli'];

let CONTEXT: BuildContext | undefined;

export function setBuildContext(opts: BuildContextInitOptions) {
  CONTEXT = new BuildContext(opts);
  return CONTEXT;
}

export function getBuildContext(): BuildContext {
  if (CONTEXT === undefined) {
    throw new Error('Build context not initialized');
  }
  return CONTEXT;
}

export interface BuildContextInitOptions {
  path?: string;
  rootDirName?: string;
  tempDirName?: string;
  buildDirName?: string;
  componentsDirName?: string;
  pagesDirName?: string;
  staticDirName?: string;

  development?: boolean;
  open?: boolean;
  port?: number;
  strict?: boolean;
}

export class BuildContext {
  rootDir: string;
  tempDir: string;
  buildDir: string;
  componentsDir: string;
  pagesDir: string;
  staticDir: string;

  options: BuildContextInitOptions;

  private entries: Record<string, Entry> | undefined;
  private componentMap: Record<string, string> | undefined;
  private componentConflicts: Set<string> | undefined;

  constructor(opts: BuildContextInitOptions) {
    this.options = opts;
    this.rootDir = _path.resolve(opts.path || opts.rootDirName || '.');
    this.tempDir = _path.resolve(this.rootDir, opts.tempDirName || '.scratch-build-cache');
    this.buildDir = _path.resolve(this.rootDir, opts.buildDirName || 'dist');
    this.componentsDir = _path.resolve(
      this.rootDir,
      opts.componentsDirName || 'components'
    );
    this.pagesDir = _path.resolve(this.rootDir, opts.pagesDirName || 'pages');
    this.staticDir = _path.resolve(this.rootDir, opts.staticDirName || 'public');
  }

  clientSrcDir = () => _path.resolve(this.tempDir, 'client-src');
  clientCompiledDir = () => _path.resolve(this.tempDir, 'client-compiled');
  serverSrcDir = () => _path.resolve(this.tempDir, 'server-src');
  serverCompiledDir = () => _path.resolve(this.tempDir, 'server-compiled');

  /**
   * Returns the node_modules directory to use for build dependencies.
   * Prefers user's node_modules if it exists, otherwise uses cache.
   */
  async nodeModulesDir(): Promise<string> {
    const userNodeModules = _path.resolve(this.rootDir, 'node_modules');
    if (await fs.exists(userNodeModules)) {
      return userNodeModules;
    }
    return _path.resolve(this.tempDir, 'node_modules');
  }

  /**
   * Ensures build dependencies are installed. If the user has their own
   * node_modules, assumes they manage deps. Otherwise, installs required
   * packages to .scratch-build-cache/node_modules.
   */
  async ensureBuildDependencies(): Promise<void> {
    const userNodeModules = _path.resolve(this.rootDir, 'node_modules');
    if (await fs.exists(userNodeModules)) {
      log.debug('Using user node_modules for build dependencies');
      return;
    }

    const cacheNodeModules = _path.resolve(this.tempDir, 'node_modules');

    // Check if all required packages exist
    let needsInstall = !(await fs.exists(cacheNodeModules));
    if (!needsInstall) {
      for (const pkg of BUILD_DEPENDENCIES) {
        const pkgPath = _path.resolve(cacheNodeModules, pkg);
        if (!(await fs.exists(pkgPath))) {
          needsInstall = true;
          break;
        }
      }
    }

    if (needsInstall) {
      log.info('Installing build dependencies...');
      await fs.mkdir(this.tempDir, { recursive: true });

      // Create minimal package.json
      const packageJson = {
        name: 'scratch-build-cache',
        private: true,
        dependencies: Object.fromEntries(
          BUILD_DEPENDENCIES.map(pkg => [pkg, 'latest'])
        ),
      };
      await fs.writeFile(
        _path.resolve(this.tempDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      // Run bun install
      const proc = Bun.spawn(['bun', 'install'], {
        cwd: this.tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(
          `Failed to install build dependencies.\n\n` +
          `This can happen if:\n` +
          `  - No network connection\n` +
          `  - Bun is not installed correctly\n` +
          `  - Disk space is low\n\n` +
          `Details: ${stderr}`
        );
      }

      log.info('Build dependencies installed');
    }
  }

  async reset() {
    await this.resetBuildDir();
    await this.resetTempDir();
  }

  async resetBuildDir() {
    await fs.rm(this.buildDir, { recursive: true, force: true });
    await fs.mkdir(this.buildDir, { recursive: true });
  }

  async resetTempDir() {
    // Preserve node_modules if it exists to avoid reinstalling every build
    const nodeModulesPath = _path.resolve(this.tempDir, 'node_modules');
    const packageJsonPath = _path.resolve(this.tempDir, 'package.json');
    const hasNodeModules = await fs.exists(nodeModulesPath);

    if (hasNodeModules) {
      // Delete everything except node_modules and package.json
      const entries = await fs.readdir(this.tempDir);
      for (const entry of entries) {
        if (entry !== 'node_modules' && entry !== 'package.json') {
          await fs.rm(_path.resolve(this.tempDir, entry), { recursive: true, force: true });
        }
      }
    } else {
      await fs.rm(this.tempDir, { recursive: true, force: true });
      await fs.mkdir(this.tempDir, { recursive: true });
    }
  }

  async markdownComponentsDir() {
    return this.resolveWithTemplateFallback('components/markdown');
  }

  async tailwindCssSrcPath() {
    return this.resolveWithTemplateFallback([
      'theme.css',
      'tailwind.css',
      'index.css',
      'globals.css',
    ]);
  }

  async clientTsxSrcPath() {
    return this.resolveWithTemplateFallback([
      'entry-client.tsx',
      'entry.tsx',
      'client.tsx',
    ]);
  }

  async serverJsxSrcPath() {
    return this.resolveWithTemplateFallback([
      'entry-server.jsx',
      'index.jsx',
      'server.jsx',
    ]);
  }

  async pageWrapperPath() {
    return this.resolveWithTemplateFallback([
      'components/PageWrapper.jsx',
      'components/PageWrapper.tsx',
    ]);
  }

  /**
   * Resolve a relative path to an absolute path, checking multiple base directories
   * in priority order:
   * 1. Project root (if the file/dir exists)
   * 2. Default template directory
   * 3. Internal template directory (for build infrastructure)
   *
   * @param relativePaths - Path(s) relative to the base directory (checks all paths in each base before moving to next)
   * @returns The absolute path to the first existing location
   * @throws Error if the path doesn't exist in any of the base directories
   */
  async resolveWithTemplateFallback(
    relativePaths: string | string[]
  ): Promise<string> {
    const paths = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
    const baseDirs = [
      this.rootDir,
      template.defaultTemplateDir,
      template.internalTemplateDir,
    ];

    for (const baseDir of baseDirs) {
      for (const relativePath of paths) {
        const candidate = _path.resolve(baseDir, relativePath);
        if (await fs.exists(candidate)) {
          return candidate;
        }
      }
    }

    throw new Error(
      `Path "${paths.join('" or "')}" not found in project root or templates`
    );
  }

  /**
   * Map the source mdx files in the pages directory and create Entry objects
   * for each one.
   */
  async getEntries() {
    if (!this.entries) {
      const mdxFiles = globSync('**/*.{mdx,md}', {
        cwd: this.pagesDir,
        absolute: true,
      });
      this.entries = {};
      for (const mdxFile of mdxFiles) {
        const entry = new Entry(mdxFile, this.pagesDir);
        this.entries[entry.name] = entry;
      }
    }
    return this.entries;
  }

  /**
   * Catalogue all of the component files in the components directory and pages directory.
   * Falls back to template components for PageWrapper and markdown components
   * if they are not found in the project.
   */
  async getComponentMap() {
    if (!this.componentMap) {
      const pattern = '**/*.{js,jsx,ts,tsx}';

      // Start with project components (if directory exists)
      let result: FileMapResult = { map: {}, conflicts: new Set() };
      if (await fs.exists(this.componentsDir)) {
        result = await buildFileMap(this.componentsDir, pattern, true);
      }

      // Also scan pages directory for co-located components
      if (await fs.exists(this.pagesDir)) {
        const pagesResult = await buildFileMap(this.pagesDir, pattern, true);
        for (const [name, filePath] of Object.entries(pagesResult.map)) {
          if (name in result.map) {
            result.conflicts.add(name);
          } else {
            result.map[name] = filePath;
          }
        }
        for (const conflict of pagesResult.conflicts) {
          result.conflicts.add(conflict);
        }
      }

      // Fallback: Add PageWrapper from template if not in project
      if (!('PageWrapper' in result.map)) {
        const templatePageWrapper = _path.resolve(template.defaultTemplateDir, 'components/PageWrapper.jsx');
        if (await fs.exists(templatePageWrapper)) {
          result.map['PageWrapper'] = templatePageWrapper;
        }
      }

      // Fallback: Add markdown components from template if not in project
      const markdownComponents = ['CodeBlock', 'Heading'];
      const templateMarkdownDir = _path.resolve(template.defaultTemplateDir, 'components/markdown');
      for (const comp of markdownComponents) {
        if (!(comp in result.map)) {
          // Check for .tsx, .jsx, .ts, .js variants
          for (const ext of ['.tsx', '.jsx', '.ts', '.js']) {
            const templatePath = _path.resolve(templateMarkdownDir, comp + ext);
            if (await fs.exists(templatePath)) {
              result.map[comp] = templatePath;
              break;
            }
          }
        }
      }

      this.componentMap = result.map;
      this.componentConflicts = result.conflicts;
    }
    return this.componentMap;
  }

  /**
   * Get the set of component names that have conflicts (multiple files with same name).
   * Must call getComponentMap() first.
   */
  getComponentConflicts(): Set<string> {
    return this.componentConflicts || new Set();
  }
}

export class Entry {
  // A unique name for this entry, e.g. "articles/post1"
  name: string;

  // The absolute path to the source file, e.g. "/project/pages/articles/post1.mdx"
  absPath: string;

  // Path to the source file relative to the base directory, e.g. "articles/post1.mdx"
  relPath: string;

  // The absolute path to the base directory of the source file, e.g. "/project/pages"
  baseDir: string;

  // Frontmatter data extracted from the source file
  frontmatterData?: Record<string, any>;

  constructor(sourceFile: string, baseDir: string) {
    this.absPath = _path.resolve(sourceFile);
    this.baseDir = _path.resolve(baseDir);

    this.relPath = _path.relative(this.baseDir, this.absPath);

    // The entry name is the relative path to the source file without the extension
    this.name = this.relPath.replace(/\.[^/.]+$/, '');
  }

  /**
   * Construct the appropriate artifact path for this entry
   */
  getArtifactPath(extension: string, baseDir: string): string {
    // check if the basename of the entry name is "index"
    const basename = _path.basename(this.name);
    if (basename === 'index') {
      return _path.resolve(baseDir, this.name + extension);
    }
    return _path.resolve(baseDir, this.name + '/index' + extension);
  }
}
