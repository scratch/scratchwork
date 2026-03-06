/**
 * Bun.build() configuration for client and server builds.
 *
 * This module provides build configuration factories that assemble
 * plugins from ./plugins for MDX compilation.
 */
import type { BunPlugin, BuildConfig } from 'bun';
import path from 'path';
import { createFormatAwareProcessors } from '@mdx-js/mdx/internal-create-format-aware-processors';
import { VFile } from 'vfile';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { BuildContext } from './context';
import { BuildCache } from './cache';
import {
  createAutoImportPlugin,
  createNotProsePlugin,
  createFootnotesPlugin,
  createShikiPlugin,
  createPackageResolverPlugin,
  createImagePathsPlugin,
  createLinkPathsPlugin,
} from './plugins';
// Note: createFrontmatterPlugin removed — frontmatter is now extracted in step 03

/**
 * Module-level MDX compilation cache.
 * Initialized on first use; reset between builds via resetMdxCache().
 */
let mdxCache: BuildCache | null = null;

/**
 * Reset the MDX compilation cache. Called between full builds.
 */
export function resetMdxCache(): void {
  mdxCache?.resetMemory();
}

export interface BunBuildConfigOptions {
  entryPts: string[];
  outDir: string;
  root: string;
}

/**
 * Disk cache version. Bump this when the compilation pipeline changes
 * (e.g., plugins added/removed, processing logic modified) to invalidate
 * all previously cached results.
 */
const MDX_DISK_CACHE_VERSION = 1;

// MDX node types that should pass through rehype-raw unchanged
const MDX_NODE_TYPES = [
  'mdxjsEsm',
  'mdxFlowExpression',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
  'mdxTextExpression',
];

/**
 * Create the MDX plugin with remark/rehype preprocessing and cross-build caching.
 *
 * The compiled MDX output is cached by file path so the second build (client)
 * reuses the compilation results from the first build (server), avoiding
 * duplicate MDX processing of every file.
 */
async function createMdxBuildPlugin(ctx: BuildContext): Promise<BunPlugin> {
  const componentMap = await ctx.getComponentMap();
  const componentConflicts = ctx.getComponentConflicts();

  // Compute a fingerprint of the entire plugin pipeline configuration.
  // This is included in disk cache keys so that config changes (strict mode,
  // highlight mode, component additions/removals) invalidate stale entries.
  const pipelineFingerprint = JSON.stringify({
    v: MDX_DISK_CACHE_VERSION,
    strict: !!ctx.options.strict,
    highlight: ctx.options.highlight || 'auto',
    base: ctx.options.base || '',
    components: Object.entries(componentMap).sort((a, b) => a[0].localeCompare(b[0])),
    conflicts: [...componentConflicts].sort(),
  });

  // Initialize module-level cache on first use (rootDir determines disk location)
  if (!mdxCache) {
    mdxCache = new BuildCache({ name: 'mdx', rootDir: ctx.rootDir, extension: '.js' });
  }

  // Lazy-initialized MDX processor. The remark/rehype pipeline (including Shiki
  // highlighter) is only created when the first cache miss requires actual compilation.
  // On warm builds where every file hits the disk or in-memory cache, the expensive
  // Shiki WASM initialization and processor setup are skipped entirely.
  let processorPromise: Promise<(file: VFile) => Promise<VFile>> | null = null;

  function getProcessor(): Promise<(file: VFile) => Promise<VFile>> {
    if (!processorPromise) {
      processorPromise = (async () => {
        // Build remark plugins list
        const remarkPlugins: any[] = [remarkGfm, remarkFrontmatter];
        if (!ctx.options.strict) {
          remarkPlugins.push(createAutoImportPlugin(componentMap, componentConflicts));
          remarkPlugins.push(createNotProsePlugin());
        }

        // Build rehype plugins list
        const rehypePlugins: any[] = [[rehypeRaw, { passThrough: MDX_NODE_TYPES }]];
        rehypePlugins.push(createImagePathsPlugin(ctx));
        rehypePlugins.push(createLinkPathsPlugin(ctx));

        const shikiPlugin = await createShikiPlugin(ctx);
        if (shikiPlugin) {
          rehypePlugins.push(shikiPlugin);
        }

        if (!ctx.options.strict) {
          rehypePlugins.push(createFootnotesPlugin());
        }

        const { process } = createFormatAwareProcessors({
          providerImportSource: '@mdx-js/react',
          remarkPlugins,
          rehypePlugins,
          remarkRehypeOptions: { passThrough: MDX_NODE_TYPES },
        });

        return process;
      })();
    }
    return processorPromise;
  }

  return {
    name: 'mdx-cached',
    setup(build) {
      build.onLoad({ filter: /\.mdx?$/ }, async (args) => {
        const content = await Bun.file(args.path).text();
        const compiled = await mdxCache!.getOrCompute(
          args.path, content, pipelineFingerprint,
          async () => {
            const process = await getProcessor();
            const file = new VFile({ value: content, path: args.path });
            return String((await process(file)).value);
          },
        );
        return { contents: compiled, loader: 'js' as const, resolveDir: path.dirname(args.path) };
      });
    },
  };
}

/**
 * Get Bun.build() configuration for client build
 */
export async function getBunBuildConfig(
  ctx: BuildContext,
  options: BunBuildConfigOptions
): Promise<BuildConfig> {
  const nodeModulesDir = ctx.nodeModulesDir;
  const mdxPlugin = await createMdxBuildPlugin(ctx);

  return {
    entrypoints: options.entryPts,
    outdir: options.outDir,
    root: options.root,

    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: !ctx.options.development,
    sourcemap: ctx.options.development ? 'linked' : 'none',

    naming: {
      entry: '[dir]/[name]-[hash].[ext]',
      chunk: 'chunks/[name]-[hash].[ext]',
      asset: 'assets/[name]-[hash].[ext]',
    },

    define: {
      'process.env.NODE_ENV': ctx.options.development
        ? '"development"'
        : '"production"',
    },

    plugins: [createPackageResolverPlugin(nodeModulesDir), mdxPlugin],
  };
}

/**
 * Get Bun.build() configuration for server-side SSG build
 */
export async function getServerBunBuildConfig(
  ctx: BuildContext,
  options: BunBuildConfigOptions
): Promise<BuildConfig> {
  const nodeModulesDir = ctx.nodeModulesDir;
  const mdxPlugin = await createMdxBuildPlugin(ctx);

  return {
    entrypoints: options.entryPts,
    outdir: options.outDir,
    root: options.root,

    target: 'bun',
    format: 'esm',
    // Enable splitting to share common code (React, etc.) across server modules
    // This significantly reduces the size of each module and speeds up imports
    splitting: true,
    minify: false,
    sourcemap: 'none',

    naming: {
      entry: '[dir]/[name].[ext]',
      chunk: 'chunks/[name]-[hash].[ext]',
    },

    define: {
      // Always use development mode for SSG server build to get helpful React error messages.
      // This code only runs at build time and is never shipped to the browser.
      'process.env.NODE_ENV': '"development"',
    },

    plugins: [createPackageResolverPlugin(nodeModulesDir), mdxPlugin],
  };
}
