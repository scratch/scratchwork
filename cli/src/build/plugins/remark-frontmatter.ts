/**
 * Remark plugin that extracts frontmatter and stores it for later HTML injection.
 *
 * This runs during MDX compilation and stores frontmatter data on the entry
 * for later use by the inject-frontmatter build step.
 */
import matter from 'gray-matter';
import { realpathSync } from 'fs';
import type { VFile } from 'vfile';
import type { BuildContext, Entry } from '../context';

/**
 * Create a remark plugin that extracts frontmatter and stores it on the entry.
 */
export function createFrontmatterPlugin(ctx: BuildContext) {
  let entryByRealPathPromise: Promise<Map<string, Entry>> | null = null;

  async function getEntryByRealPath(): Promise<Map<string, Entry>> {
    if (!entryByRealPathPromise) {
      entryByRealPathPromise = (async () => {
        const entries = await ctx.getEntries();
        const map = new Map<string, Entry>();
        for (const entry of Object.values(entries)) {
          try {
            map.set(realpathSync(entry.absPath), entry);
          } catch {
            // Entry file might not exist, skip
          }
        }
        return map;
      })();
    }
    return entryByRealPathPromise;
  }

  return () => {
    return async (tree: unknown, file: VFile) => {
      if (!file.path) return;

      const fileValue = file.value;
      const code =
        typeof fileValue === 'string'
          ? fileValue
          : fileValue instanceof Uint8Array
            ? Buffer.from(fileValue).toString('utf-8')
            : await Bun.file(file.path).text();
      const extracted = matter(code);

      // Store frontmatter for later HTML injection
      const realFilePath = realpathSync(file.path);
      const entryByRealPath = await getEntryByRealPath();
      const entry = entryByRealPath.get(realFilePath);
      if (entry) {
        entry.frontmatterData = extracted.data;
      }
    };
  };
}
