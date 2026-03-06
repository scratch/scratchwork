/**
 * Reusable build cache with 3-layer lookup: memory → inflight → disk → compute.
 *
 * Disk cache lives at `.scratchwork/{name}-cache/` which survives `resetTempDir()`
 * (that only clears `.scratchwork/cache/`). Memory and inflight caches are cleared
 * between builds via `resetMemory()`.
 */
import path from 'path';
import fs from 'fs/promises';

export class BuildCache {
  private memory = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();
  private diskCacheDir: string;
  private diskCacheReady: Promise<void>;
  private extension: string;

  constructor(options: { name: string; rootDir: string; extension?: string }) {
    this.extension = options.extension ?? '';
    this.diskCacheDir = path.join(options.rootDir, '.scratchwork', `${options.name}-cache`);
    this.diskCacheReady = fs.mkdir(this.diskCacheDir, { recursive: true }).catch(() => {});
  }

  /**
   * Get a value from cache or compute it.
   *
   * @param key - Dedup key (e.g., absolute file path)
   * @param content - Input content for disk cache key
   * @param fingerprint - Pipeline config fingerprint
   * @param compute - Called on full miss (memory + disk) to produce the value
   */
  async getOrCompute(
    key: string,
    content: string,
    fingerprint: string,
    compute: () => Promise<string>,
  ): Promise<string> {
    // 1. In-memory cache (instant)
    const cached = this.memory.get(key);
    if (cached !== undefined) return cached;

    // 2. In-flight deduplication (parallel build requests for same key)
    const existing = this.inflight.get(key);
    if (existing) return existing;

    // 3. Disk + compute
    const promise = (async () => {
      const cacheKey = Bun.hash(fingerprint + '\0' + key + '\0' + content).toString(16);
      await this.diskCacheReady;
      const diskPath = path.join(this.diskCacheDir, cacheKey + this.extension);

      // Check disk cache
      try {
        const diskFile = Bun.file(diskPath);
        if (await diskFile.exists()) {
          const result = await diskFile.text();
          this.memory.set(key, result);
          this.inflight.delete(key);
          return result;
        }
      } catch {
        // Disk cache miss or read error — fall through to compute
      }

      // 4. Compute (expensive)
      const result = await compute();
      this.memory.set(key, result);
      this.inflight.delete(key);

      // Write to disk cache for next build (fire-and-forget)
      Bun.write(diskPath, result).catch(() => {});

      return result;
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Clear in-memory and inflight caches. Disk cache is preserved.
   */
  resetMemory(): void {
    this.memory.clear();
    this.inflight.clear();
  }
}
