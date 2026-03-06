import fs from 'fs/promises';
import path from 'path';
import type { BuildContext, Entry } from '../context';
import type { BuildPipelineState, BuildStep } from '../types';
import { normalizeBase } from '../util';
import { buildGlobals, generateGlobalsScript } from '../globals';
import { escapeHtml } from '../../util';
import { resolveImageUrl } from './08-inject-frontmatter';
import log from '../../logger';

export const generateHtmlStep: BuildStep = {
  name: '07-generate-html',
  description: 'Generate HTML files',

  async execute(ctx: BuildContext, state: BuildPipelineState): Promise<void> {
    const entries = state.outputs.entries!;
    const cssFilename = state.outputs.cssFilename;
    const jsOutputMap = state.outputs.jsOutputMap!;
    const ssg = state.options.ssg ?? false;
    const renderedContent = state.outputs.renderedContent ?? new Map();

    // Normalize base path for URL prefixing
    const base = normalizeBase(ctx.options.base);

    // Detect favicons once for all entries
    const faviconLinks = await getFaviconLinkTags(ctx, base);

    // Build CSS link tag (only if CSS was built)
    const cssLinkTag = cssFilename
      ? `<link rel="stylesheet" href="${base}/${cssFilename}" />`
      : '';

    // Build globals script for client-side access (base path, SSG flag, etc.)
    const globals = buildGlobals({ base, ssg });
    const globalsScript = generateGlobalsScript(globals);

    // Generate all HTML files in parallel (each entry writes to a unique path)
    await Promise.all(Object.entries(entries).map(async ([name, entry]) => {
      const htmlPath = entry.getArtifactPath('.html', ctx.clientCompiledDir);

      // Look up the actual hashed JS path from the build output
      const jsPath = jsOutputMap[name];
      if (!jsPath) {
        throw new Error(`No JS output found for entry: ${name}`);
      }

      // Calculate relative path from HTML to JS (with base path prefix)
      const relativeJsPath =
        base + '/' + path.relative(ctx.clientCompiledDir, jsPath);

      // Get SSG content if available
      const ssgContent =
        ssg && renderedContent.has(name) ? renderedContent.get(name)! : '';

      // Build frontmatter meta tags inline (avoids a separate read-back pass)
      const frontmatterTags = buildFrontmatterTags(entry);
      const langAttr = entry.frontmatterData?.lang
        ? escapeHtml(String(entry.frontmatterData.lang))
        : 'en';

      // Build HTML
      const html = `<!doctype html>
<html lang="${langAttr}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${cssLinkTag}
    ${faviconLinks}
    ${globalsScript}
    ${frontmatterTags}
  </head>
  <body>
    <div id="mdx">${ssgContent}</div>
    <script type="module" src="${relativeJsPath}"></script>
  </body>
</html>`;

      await fs.mkdir(path.dirname(htmlPath), { recursive: true });
      await Bun.write(htmlPath, html);
      log.debug(`  ${path.relative(ctx.rootDir, htmlPath)}`);
    }));
  },
};

/**
 * Detect favicons in the public directory and return appropriate link tags
 */
async function getFaviconLinkTags(
  ctx: BuildContext,
  base: string
): Promise<string> {
  const links: string[] = [];

  // Check for SVG favicon (preferred for modern browsers)
  const svgFaviconPath = path.join(ctx.staticDir, 'favicon.svg');
  if (await fs.exists(svgFaviconPath)) {
    links.push(
      `<link rel="icon" type="image/svg+xml" href="${base}/favicon.svg" />`
    );
  }

  // Check for ICO favicon (fallback for older browsers)
  const icoFaviconPath = path.join(ctx.staticDir, 'favicon.ico');
  if (await fs.exists(icoFaviconPath)) {
    links.push(`<link rel="icon" href="${base}/favicon.ico" />`);
  }

  return links.join('\n    ');
}

/**
 * Build frontmatter meta tags for an entry.
 * This is done inline during HTML generation to avoid a separate read-back pass.
 */
function buildFrontmatterTags(entry: Entry): string {
  const metadata = entry.frontmatterData;
  if (!metadata || Object.keys(metadata).length === 0) {
    return '';
  }

  const e = (val: unknown): string => escapeHtml(String(val));
  const siteUrl = metadata.siteUrl as string | undefined;

  const tags = [
    metadata.title && `<title>${e(metadata.title)}</title>`,
    metadata.description &&
      `<meta name="description" content="${e(metadata.description)}">`,
    metadata.keywords &&
      `<meta name="keywords" content="${e(Array.isArray(metadata.keywords) ? metadata.keywords.join(', ') : metadata.keywords)}">`,
    metadata.author && `<meta name="author" content="${e(metadata.author)}">`,
    metadata.robots && `<meta name="robots" content="${e(metadata.robots)}">`,

    // Open Graph
    metadata.title &&
      `<meta property="og:title" content="${e(metadata.title)}">`,
    metadata.description &&
      `<meta property="og:description" content="${e(metadata.description)}">`,
    metadata.image &&
      `<meta property="og:image" content="${e(resolveImageUrl(String(metadata.image), siteUrl))}">`,
    metadata.url && `<meta property="og:url" content="${e(metadata.url)}">`,
    `<meta property="og:type" content="${e(metadata.type || 'article')}">`,
    metadata.siteName &&
      `<meta property="og:site_name" content="${e(metadata.siteName)}">`,
    metadata.locale &&
      `<meta property="og:locale" content="${e(metadata.locale)}">`,

    // Twitter
    metadata.title &&
      `<meta name="twitter:title" content="${e(metadata.title)}">`,
    metadata.description &&
      `<meta name="twitter:description" content="${e(metadata.description)}">`,
    metadata.image &&
      `<meta name="twitter:image" content="${e(resolveImageUrl(String(metadata.image), siteUrl))}">`,
    `<meta name="twitter:card" content="${e(metadata.twitterCard || 'summary_large_image')}">`,
    metadata.twitterSite &&
      `<meta name="twitter:site" content="${e(metadata.twitterSite)}">`,
    metadata.twitterCreator &&
      `<meta name="twitter:creator" content="${e(metadata.twitterCreator)}">`,

    // Dates
    metadata.publishDate &&
      `<meta property="article:published_time" content="${e(metadata.publishDate)}">`,
    metadata.modifiedDate &&
      `<meta property="article:modified_time" content="${e(metadata.modifiedDate)}">`,

    // Canonical
    metadata.canonical &&
      `<link rel="canonical" href="${e(metadata.canonical)}">`,
  ].filter(Boolean);

  // Handle tags separately (multiple meta tags)
  if (metadata.tags) {
    const tagMetas = (
      Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags]
    ).map((tag: string) => `<meta property="article:tag" content="${e(tag)}">`);
    tags.push(...tagMetas);
  }

  // Add script to set window.__scratch_author__ if author is present
  if (metadata.author) {
    tags.push(`<script>window.__scratch_author__ = ${JSON.stringify(metadata.author)};</script>`);
  }

  return tags.join('\n    ');
}
