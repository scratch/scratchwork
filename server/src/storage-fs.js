/*
 * Filesystem storage — the backend the local server uses. Project metadata is a
 * JSON file per project; deploy files live under a per-deploy directory. Runs on
 * Bun (the local server's runtime) using node:fs.
 *
 * Layout under <dataDir>:
 *   meta/<projectId>.json          project record
 *   deploys/<deployId>/<path>      every uploaded file, verbatim
 */
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";

export function createFsStorage(dataDir) {
  const metaDir = join(dataDir, "meta");
  const deploysDir = join(dataDir, "deploys");

  // Resolve `key` under `base` and refuse anything that escapes it. The app
  // validates paths before we get here; this is defense in depth.
  function within(base, key) {
    const baseAbs = resolve(base);
    const abs = resolve(join(base, key));
    if (abs !== baseAbs && !abs.startsWith(baseAbs + sep)) return null;
    return abs;
  }

  return {
    async getProject(id) {
      if (!/^[a-z0-9]+$/i.test(id)) return null;
      try {
        return JSON.parse(await readFile(join(metaDir, id + ".json"), "utf8"));
      } catch {
        return null;
      }
    },

    async saveProject(project) {
      await mkdir(metaDir, { recursive: true });
      await writeFile(join(metaDir, project.id + ".json"), JSON.stringify(project, null, 2));
    },

    async putFiles(deployId, files) {
      const base = join(deploysDir, deployId);
      for (const f of files) {
        const abs = within(base, f.path);
        if (!abs) throw new Error("unsafe path in bundle: " + f.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.data);
      }
    },

    async getFile(deployId, key) {
      const abs = within(join(deploysDir, deployId), key);
      if (!abs) return null;
      try {
        const st = await stat(abs);
        if (!st.isFile()) return null;
        return {
          body: await readFile(abs),
          size: st.size,
          etag: `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`,
        };
      } catch {
        return null;
      }
    },
  };
}
