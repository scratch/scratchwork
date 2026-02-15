import path from 'path';
import type { BuildContext, Entry } from '../context';
import type { BuildPipelineState } from '../types';
import type { BuildStep } from '../types';
import log from '../../logger';

interface RenderElementHint {
  jsxElement?: string;
  renderEntryPath?: string;
  renderEntryLine?: number;
  renderEntryLineText?: string;
}

function extractFailureSourcePath(errorMessage: string): string {
  const match = errorMessage.match(/Failed to render\s+([^\n:]+\.(?:mdx|md))\s*:/);
  return match?.[1] ?? '';
}

function summarizeRenderFailure(errorMessage: string): string {
  const singleLine = errorMessage.split('\n')[0] ?? errorMessage;
  const match = singleLine.match(/Failed to render\s+([^\n:]+\.(?:mdx|md))\s*:\s*(.+)$/);
  if (match?.[1] && match?.[2]) {
    return `${match[1]}: ${match[2]}`;
  }
  return singleLine;
}

async function extractRenderElementHint(
  ctx: BuildContext,
  entry: Entry
): Promise<RenderElementHint | null> {
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
  const renderEntryLineText = lines[lineIndex]!.trim();

  return {
    jsxElement,
    renderEntryPath,
    renderEntryLine,
    renderEntryLineText,
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
        // Enhance React error messages with file context
        if (err.message?.includes('Element type is invalid')) {
          const hint = await extractRenderElementHint(ctx, entry);
          const gotTypeMatch = err.message.match(/but got:\s*([^.\n]+)/);
          const gotType = gotTypeMatch?.[1]?.trim();
          const extraLines = [
            gotType ? `  React received: ${gotType}` : null,
            hint?.jsxElement ? `  JSX element: ${hint.jsxElement}` : null,
            hint?.renderEntryPath
              ? `  Render entry: ${hint.renderEntryPath}${
                  hint.renderEntryLine !== undefined ? `:${hint.renderEntryLine}` : ''
                }`
              : null,
            hint?.renderEntryLine !== undefined && hint.renderEntryLineText
              ? `  ${hint.renderEntryLine} | ${hint.renderEntryLineText}`
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join('\n');

          throw new Error(
            `Failed to render ${sourcePath}: ${err.message}\n` +
              `${extraLines ? `${extraLines}\n` : ''}` +
              `  This usually means a component in the MDX file could not be resolved.\n` +
              `  Check for typos in component names or missing imports.`
          );
        }
        throw new Error(`Failed to render ${sourcePath}: ${err.message}`);
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
      failures.sort((a, b) => {
        const pathA = extractFailureSourcePath(a.message);
        const pathB = extractFailureSourcePath(b.message);
        return pathA.localeCompare(pathB);
      });

      const primary = failures[0]!;
      if (failures.length === 1) {
        throw primary;
      }

      const extraFailures = failures.slice(1, 100).map((failure) =>
        `  - ${summarizeRenderFailure(failure.message)}`
      );
      const hiddenCount = failures.length - 1 - extraFailures.length;
      const hiddenLine = hiddenCount > 0 ? `\n  ... and ${hiddenCount} more` : '';

      throw new Error(
        `${primary.message}\n` +
          `  Additional render errors (${failures.length - 1}):\n` +
          `${extraFailures.join('\n')}` +
          `${hiddenLine}`
      );
    }

    state.outputs.renderedContent = renderedContent;
  },
};
