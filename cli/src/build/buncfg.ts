/**
 * Bun.build() configuration for client and server builds.
 *
 * This module provides build configuration factories that assemble
 * plugins from ./plugins for MDX compilation.
 */
import type { BunPlugin, BuildConfig } from 'bun';
import path from 'path';
import fs from 'fs/promises';
import { createFormatAwareProcessors } from '@mdx-js/mdx/internal-create-format-aware-processors';
import { VFile } from 'vfile';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { BuildContext } from './context';
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
import log from '../logger';

/**
 * Module-level cache for MDX compilation results.
 * Keyed by absolute file path. Since the remark/rehype plugin chain is identical
 * for server and client builds (frontmatter extraction is handled separately in
 * step 03), the compiled output can be safely reused across both builds.
 */
const mdxCompilationCache = new Map<string, { contents: string; loader: 'js'; resolveDir: string }>();

/**
 * In-flight MDX compilation promises for deduplication.
 * When server and client builds run in parallel, both may request the same file
 * simultaneously. The first request starts the compilation and stores the promise;
 * subsequent requests await the same promise instead of compiling again.
 */
const mdxCompilationInFlight = new Map<string, Promise<{ contents: string; loader: 'js'; resolveDir: string }>>();

/**
 * Reset the MDX compilation cache. Called between full builds.
 */
export function resetMdxCache(): void {
  mdxCompilationCache.clear();
  mdxCompilationInFlight.clear();
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

  // Disk cache lives outside the temp dir so it survives resetTempDir() between builds.
  const diskCacheDir = path.join(ctx.rootDir, '.scratchwork', 'mdx-cache');
  const diskCacheReady = fs.mkdir(diskCacheDir, { recursive: true }).catch(() => {});

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
        // 1. Check in-memory cache (instant, populated by earlier build in same run)
        const cached = mdxCompilationCache.get(args.path);
        if (cached) {
          return cached;
        }

        // 2. Check if compilation is already in-flight (parallel build deduplication)
        const inFlight = mdxCompilationInFlight.get(args.path);
        if (inFlight) {
          return inFlight;
        }

        // 3. Read file, check disk cache, or compile
        const promise = (async () => {
          const content = await Bun.file(args.path).text();
          const resolveDir = path.dirname(args.path);

          // Disk cache key: hash of pipeline config + file path + file content
          const cacheKey = Bun.hash(pipelineFingerprint + '\0' + args.path + '\0' + content).toString(16);
          await diskCacheReady;
          const diskCachePath = path.join(diskCacheDir, cacheKey + '.js');

          // Check disk cache (persists across builds)
          try {
            const diskFile = Bun.file(diskCachePath);
            if (await diskFile.exists()) {
              const diskContents = await diskFile.text();
              const result = {
                contents: diskContents,
                loader: 'js' as const,
                resolveDir,
              };
              mdxCompilationCache.set(args.path, result);
              mdxCompilationInFlight.delete(args.path);
              return result;
            }
          } catch {
            // Disk cache miss or read error — fall through to compile
          }

          // 4. Compile MDX (expensive: remark/rehype + Shiki highlighting)
          const process = await getProcessor();
          const file = new VFile({ value: content, path: args.path });
          const compiled = await process(file);
          const compiledContents = String(compiled.value);

          const result = {
            contents: compiledContents,
            loader: 'js' as const,
            resolveDir,
          };

          mdxCompilationCache.set(args.path, result);
          mdxCompilationInFlight.delete(args.path);

          // Write to disk cache for next build (fire-and-forget)
          Bun.write(diskCachePath, compiledContents).catch(() => {});

          return result;
        })();

        mdxCompilationInFlight.set(args.path, promise);
        return promise;
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
