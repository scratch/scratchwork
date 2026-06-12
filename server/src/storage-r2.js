/*
 * Cloudflare R2 storage — the backend the Worker uses in production. One R2
 * bucket holds everything: project metadata as JSON objects, deploy files as
 * blobs. No D1, no KV, no SQL — a single binding, which is what keeps the
 * Cloudflare deploy down to "make a bucket, set a token, publish".
 *
 * Keys mirror the filesystem layout:
 *   meta/<projectId>.json
 *   deploys/<deployId>/<path>
 *
 * R2 gives strong read-after-write consistency per key, so a freshly published
 * project's metadata and files are immediately readable.
 */
import { contentType } from "./util.js";

export function createR2Storage(bucket) {
  return {
    async getProject(id) {
      if (!/^[a-z0-9]+$/i.test(id)) return null;
      const obj = await bucket.get(`meta/${id}.json`);
      if (!obj) return null;
      try {
        return await obj.json();
      } catch {
        return null;
      }
    },

    async saveProject(project) {
      await bucket.put(`meta/${project.id}.json`, JSON.stringify(project), {
        httpMetadata: { contentType: "application/json" },
      });
    },

    async putFiles(deployId, files) {
      // R2 has no batch put; cap concurrency so a large deploy doesn't open
      // hundreds of simultaneous requests.
      const BATCH = 12;
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        await Promise.all(
          batch.map((f) =>
            // Copy the view to its own buffer: f.data is a subarray into the
            // shared bundle buffer, and we want only its bytes stored. Store the
            // content type so the object is self-describing in R2.
            bucket.put(`deploys/${deployId}/${f.path}`, f.data.slice(), {
              httpMetadata: { contentType: contentType(f.path) },
            }),
          ),
        );
      }
    },

    async getFile(deployId, key) {
      const obj = await bucket.get(`deploys/${deployId}/${key}`);
      if (!obj) return null;
      return { body: obj.body, size: obj.size, etag: obj.httpEtag };
    },
  };
}
