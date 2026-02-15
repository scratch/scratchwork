import path from 'path';
import type { BuildContext, Entry } from '../context';
import type { ErrorSourceLocation } from '../errors';
import { enrichRenderError, aggregateRenderFailures } from '../errors';
import type { BuildPipelineState } from '../types';
import type { BuildStep } from '../types';
import log from '../../logger';

async function extractRenderElementHint(
  ctx: BuildContext,
  entry: Entry
): Promise<ErrorSourceLocation | null> {
  const serverEntryPath = entry.getArtifactPath('.jsx', ctx.serverSrcDir);
  const renderEntryPath = path.relative(ctx.rootDir, serverEntryPath) || serverEntryPath;

  let source: string;
  try {
    source = await Bun.file(serverEntryPath).text();
  } catch {
    return null;
  }

  const mdxImportMatch = source.match(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+["'][^"']+\.(?:mdx|md)["'];?/
  );
  const componentName = mdxImportMatch?.[1];
  if (!componentName) {
    return { renderEntryPath };
  }

  const jsxElement = `<${componentName} />`;
  const lines = source.split('\n');
  const targetPattern = new RegExp(`<${componentName}(\\s|/|>)`);
  const lineIndex = lines.findIndex((line) => targetPattern.test(line));

  if (lineIndex < 0) {
    return { jsxElement, renderEntryPath };
  }

  const renderEntryLine = lineIndex + 1;
  const lineText = lines[lineIndex]!.trim();

  return {
    jsxElement,
    renderEntryPath,
    renderEntryLine,
    lineText,
  };
}

export const renderServerStep: BuildStep = {
  name: '05b-render-server',
  description: 'Render server modules to HTML for SSG',

  shouldRun(_ctx: BuildContext, state: BuildPipelineState): boolean {
    return state.options.ssg === true && state.outputs.serverBuildResult !== null;
  },

  async execute(ctx: BuildContext, state: BuildPipelineState): Promise<void> {
    const entries = state.outputs.entries!;
    const renderedContent = new Map<string, string>();

    log.debug(`  Rendering ${Object.keys(entries).length} pages...`);

    // Import each server module and call render() - in parallel for performance
    const renderPromises = Object.entries(entries).map(async ([name, entry]) => {
      const modulePath = entry.getArtifactPath('.js', ctx.serverCompiledDir);
      const serverModule = await import(modulePath);

      // Validate the module has a render function
      if (typeof serverModule.render !== 'function') {
        const exportedKeys = Object.keys(serverModule);
        const sourcePath = entry.relPath;
        throw new Error(
          `Failed to compile ${sourcePath}: server module is missing render() function.\n` +
            `  Module exports: ${exportedKeys.length > 0 ? exportedKeys.join(', ') : '(empty)'}\n` +
            `  This usually means the MDX file has a syntax error that was not reported.\n` +
            `  Check the file for special characters or invalid JSX syntax.`
        );
      }

      try {
        const html = await serverModule.render();
        renderedContent.set(name, html);
      } catch (err: any) {
        const sourcePath = entry.relPath;
        const hint = err.message?.includes('Element type is invalid')
          ? await extractRenderElementHint(ctx, entry)
          : null;
        throw enrichRenderError(sourcePath, err, hint);
      }
    });

    const renderResults = await Promise.allSettled(renderPromises);
    const failures = renderResults
      .filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      .map((result) =>
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason))
      );

    if (failures.length > 0) {
      throw aggregateRenderFailures(failures);
    }

    state.outputs.renderedContent = renderedContent;
  },
};
