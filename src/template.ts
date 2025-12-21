import fs from 'fs/promises';
import path from 'path';
import log from './logger';

// ============================================================================
// EMBEDDED TEMPLATE CONTENTS
// ============================================================================

export const templates = {
  internal: {
    'entry-client.tsx': `import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { MDXProvider } from '@mdx-js/react';

// The source .mdx file for this page
import Component from '{{entrySourceMdxImportPath}}';

// Base Markdown components (maps lowercase tag names to styled components)
import { MDXComponents } from '{{markdownComponentsPath}}';

const component = React.createElement(
  MDXProvider,
  { components: MDXComponents },
  React.createElement(Component)
);

// If static site generation was used, hydrate the component container. If not,
// render and insert the component
const mdxElement = document.getElementById('mdx')!;
if ((window as any).__scratch_ssg) {
  console.log('Hydrating mdx component');
  hydrateRoot(mdxElement, component);
} else {
  console.log('Rendering mdx component');
  createRoot(mdxElement).render(component);
}
`,

    'entry-server.jsx': `// Server-side entry for SSG rendering
import { renderToString } from "react-dom/server";
import { MDXProvider } from "@mdx-js/react";
import Component from "{{entrySourceMdxImportPath}}";
import { MDXComponents } from "{{markdownComponentsPath}}";

/**
 * Render the application to an HTML string.
 */
export async function render(url = "/") {
  let rendered = renderToString(
    <MDXProvider components={MDXComponents}>
      <Component />
    </MDXProvider>
  );

  return rendered;
}
`,
  },

  default: {
    'theme.css': `@import "tailwindcss";

/*
 * Prose styling for markdown content
 * These classes replicate @tailwindcss/typography styling but are fully customizable.
 * Applied via PageWrapper component.
 */

/* Light mode prose */
.scratch-prose {
  @apply text-gray-700 leading-7;
}

.scratch-prose :where(p):not(:where([class~="not-prose"] *)) {
  @apply my-5;
}

.scratch-prose :where([class~="lead"]):not(:where([class~="not-prose"] *)) {
  @apply text-xl text-gray-600 leading-8;
}

.scratch-prose :where(a):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 underline underline-offset-2 decoration-gray-300 hover:decoration-gray-500 font-medium;
}

.scratch-prose :where(strong):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-semibold;
}

.scratch-prose :where(a strong):not(:where([class~="not-prose"] *)),
.scratch-prose :where(blockquote strong):not(:where([class~="not-prose"] *)),
.scratch-prose :where(thead th strong):not(:where([class~="not-prose"] *)) {
  @apply text-inherit;
}

.scratch-prose :where(ol):not(:where([class~="not-prose"] *)) {
  @apply list-decimal my-5 pl-6;
}

.scratch-prose :where(ol[type="A"]):not(:where([class~="not-prose"] *)) {
  @apply list-[upper-alpha];
}

.scratch-prose :where(ol[type="a"]):not(:where([class~="not-prose"] *)) {
  @apply list-[lower-alpha];
}

.scratch-prose :where(ol[type="I"]):not(:where([class~="not-prose"] *)) {
  @apply list-[upper-roman];
}

.scratch-prose :where(ol[type="i"]):not(:where([class~="not-prose"] *)) {
  @apply list-[lower-roman];
}

.scratch-prose :where(ol[type="1"]):not(:where([class~="not-prose"] *)) {
  @apply list-decimal;
}

.scratch-prose :where(ul):not(:where([class~="not-prose"] *)) {
  @apply list-disc my-5 pl-6;
}

.scratch-prose :where(ol > li):not(:where([class~="not-prose"] *))::marker,
.scratch-prose :where(ul > li):not(:where([class~="not-prose"] *))::marker {
  @apply text-gray-400;
}

.scratch-prose :where(li):not(:where([class~="not-prose"] *)) {
  @apply my-2;
}

.scratch-prose :where(ol > li):not(:where([class~="not-prose"] *)),
.scratch-prose :where(ul > li):not(:where([class~="not-prose"] *)) {
  @apply pl-1.5;
}

.scratch-prose :where(.scratch-prose > ul > li p):not(:where([class~="not-prose"] *)) {
  @apply my-3;
}

.scratch-prose :where(.scratch-prose > ul > li > p:first-child):not(:where([class~="not-prose"] *)) {
  @apply mt-0;
}

.scratch-prose :where(.scratch-prose > ul > li > p:last-child):not(:where([class~="not-prose"] *)) {
  @apply mb-0;
}

.scratch-prose :where(.scratch-prose > ol > li > p:first-child):not(:where([class~="not-prose"] *)) {
  @apply mt-0;
}

.scratch-prose :where(.scratch-prose > ol > li > p:last-child):not(:where([class~="not-prose"] *)) {
  @apply mb-0;
}

.scratch-prose :where(ul ul, ul ol, ol ul, ol ol):not(:where([class~="not-prose"] *)) {
  @apply my-3;
}

.scratch-prose :where(dl):not(:where([class~="not-prose"] *)) {
  @apply my-5;
}

.scratch-prose :where(dt):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-semibold mt-5;
}

.scratch-prose :where(dd):not(:where([class~="not-prose"] *)) {
  @apply mt-2 pl-6;
}

.scratch-prose :where(hr):not(:where([class~="not-prose"] *)) {
  @apply border-gray-200 my-12;
}

.scratch-prose :where(blockquote):not(:where([class~="not-prose"] *)) {
  @apply border-l-4 border-gray-200 pl-6 my-6 text-gray-900 font-normal italic;
}

.scratch-prose :where(blockquote p:first-of-type):not(:where([class~="not-prose"] *))::before {
  content: none;
}

.scratch-prose :where(blockquote p:last-of-type):not(:where([class~="not-prose"] *))::after {
  content: none;
}

.scratch-prose :where(h1):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-extrabold text-4xl mt-0 mb-6 leading-tight;
}

.scratch-prose :where(h1 strong):not(:where([class~="not-prose"] *)) {
  @apply font-black text-inherit;
}

.scratch-prose :where(h2):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-bold text-2xl mt-12 mb-4 leading-snug;
}

.scratch-prose :where(h2 strong):not(:where([class~="not-prose"] *)) {
  @apply font-extrabold text-inherit;
}

.scratch-prose :where(h3):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-semibold text-xl mt-8 mb-3 leading-snug;
}

.scratch-prose :where(h3 strong):not(:where([class~="not-prose"] *)) {
  @apply font-bold text-inherit;
}

.scratch-prose :where(h4):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-semibold mt-6 mb-2 leading-normal;
}

.scratch-prose :where(h4 strong):not(:where([class~="not-prose"] *)) {
  @apply font-bold text-inherit;
}

.scratch-prose :where(img):not(:where([class~="not-prose"] *)) {
  @apply my-8;
}

.scratch-prose :where(picture):not(:where([class~="not-prose"] *)) {
  @apply block my-8;
}

.scratch-prose :where(video):not(:where([class~="not-prose"] *)) {
  @apply my-8;
}

.scratch-prose :where(kbd):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-semibold text-sm bg-gray-100 rounded px-1.5 py-0.5 border border-gray-300 shadow-sm;
}

.scratch-prose :where(code):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-medium text-sm bg-gray-100 px-1.5 py-0.5 rounded;
}

.scratch-prose :where(a code):not(:where([class~="not-prose"] *)),
.scratch-prose :where(h1 code):not(:where([class~="not-prose"] *)),
.scratch-prose :where(h2 code):not(:where([class~="not-prose"] *)),
.scratch-prose :where(h3 code):not(:where([class~="not-prose"] *)),
.scratch-prose :where(h4 code):not(:where([class~="not-prose"] *)),
.scratch-prose :where(blockquote code):not(:where([class~="not-prose"] *)),
.scratch-prose :where(thead th code):not(:where([class~="not-prose"] *)) {
  @apply text-inherit;
}

.scratch-prose :where(pre):not(:where([class~="not-prose"] *)) {
  @apply text-gray-200 bg-gray-800 rounded-lg overflow-x-auto py-3 px-4 my-5 text-sm leading-relaxed;
}

.scratch-prose :where(pre code):not(:where([class~="not-prose"] *)) {
  @apply bg-transparent border-0 rounded-none p-0 font-normal text-inherit text-inherit;
}

.scratch-prose :where(pre code):not(:where([class~="not-prose"] *))::before {
  content: none;
}

.scratch-prose :where(pre code):not(:where([class~="not-prose"] *))::after {
  content: none;
}

.scratch-prose :where(table):not(:where([class~="not-prose"] *)) {
  @apply w-full table-auto text-left text-sm my-8;
}

.scratch-prose :where(thead):not(:where([class~="not-prose"] *)) {
  @apply border-b border-gray-300;
}

.scratch-prose :where(thead th):not(:where([class~="not-prose"] *)) {
  @apply text-gray-900 font-semibold align-bottom pb-3 pr-3 pl-0;
}

.scratch-prose :where(thead th:first-child):not(:where([class~="not-prose"] *)) {
  @apply pl-0;
}

.scratch-prose :where(thead th:last-child):not(:where([class~="not-prose"] *)) {
  @apply pr-0;
}

.scratch-prose :where(tbody tr):not(:where([class~="not-prose"] *)) {
  @apply border-b border-gray-200;
}

.scratch-prose :where(tbody tr:last-child):not(:where([class~="not-prose"] *)) {
  @apply border-b-0;
}

.scratch-prose :where(tbody td):not(:where([class~="not-prose"] *)) {
  @apply align-baseline py-3 pr-3 pl-0;
}

.scratch-prose :where(tbody td:first-child):not(:where([class~="not-prose"] *)) {
  @apply pl-0;
}

.scratch-prose :where(tbody td:last-child):not(:where([class~="not-prose"] *)) {
  @apply pr-0;
}

.scratch-prose :where(tfoot):not(:where([class~="not-prose"] *)) {
  @apply border-t border-gray-300;
}

.scratch-prose :where(tfoot td):not(:where([class~="not-prose"] *)) {
  @apply align-top py-3 pr-3 pl-0;
}

.scratch-prose :where(figure):not(:where([class~="not-prose"] *)) {
  @apply my-8;
}

.scratch-prose :where(figure > *):not(:where([class~="not-prose"] *)) {
  @apply my-0;
}

.scratch-prose :where(figcaption):not(:where([class~="not-prose"] *)) {
  @apply text-gray-500 text-sm mt-3;
}

/* Dark mode prose */
.dark .scratch-prose {
  @apply text-gray-300;
}

.dark .scratch-prose :where([class~="lead"]):not(:where([class~="not-prose"] *)) {
  @apply text-gray-400;
}

.dark .scratch-prose :where(a):not(:where([class~="not-prose"] *)) {
  @apply text-white decoration-gray-600 hover:decoration-gray-400;
}

.dark .scratch-prose :where(strong):not(:where([class~="not-prose"] *)) {
  @apply text-white;
}

.dark .scratch-prose :where(ol > li):not(:where([class~="not-prose"] *))::marker,
.dark .scratch-prose :where(ul > li):not(:where([class~="not-prose"] *))::marker {
  @apply text-gray-500;
}

.dark .scratch-prose :where(dt):not(:where([class~="not-prose"] *)) {
  @apply text-white;
}

.dark .scratch-prose :where(hr):not(:where([class~="not-prose"] *)) {
  @apply border-gray-700;
}

.dark .scratch-prose :where(blockquote):not(:where([class~="not-prose"] *)) {
  @apply border-gray-700 text-gray-100;
}

.dark .scratch-prose :where(h1):not(:where([class~="not-prose"] *)),
.dark .scratch-prose :where(h2):not(:where([class~="not-prose"] *)),
.dark .scratch-prose :where(h3):not(:where([class~="not-prose"] *)),
.dark .scratch-prose :where(h4):not(:where([class~="not-prose"] *)) {
  @apply text-white;
}

.dark .scratch-prose :where(kbd):not(:where([class~="not-prose"] *)) {
  @apply text-white bg-gray-700 border-gray-600;
}

.dark .scratch-prose :where(code):not(:where([class~="not-prose"] *)) {
  @apply text-gray-100 bg-gray-800;
}

.dark .scratch-prose :where(pre):not(:where([class~="not-prose"] *)) {
  @apply bg-gray-950 text-gray-200;
}

.dark .scratch-prose :where(thead):not(:where([class~="not-prose"] *)) {
  @apply border-gray-600;
}

.dark .scratch-prose :where(thead th):not(:where([class~="not-prose"] *)) {
  @apply text-white;
}

.dark .scratch-prose :where(tbody tr):not(:where([class~="not-prose"] *)) {
  @apply border-gray-700;
}

.dark .scratch-prose :where(tfoot):not(:where([class~="not-prose"] *)) {
  @apply border-gray-600;
}

.dark .scratch-prose :where(figcaption):not(:where([class~="not-prose"] *)) {
  @apply text-gray-400;
}

/* Custom interactive elements */
.copy-button {
  @apply absolute top-2 right-2 px-2 py-1 text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity;
  @apply text-gray-400 hover:text-gray-200 bg-gray-800;
}
.dark .copy-button {
  @apply text-gray-500 hover:text-gray-300 bg-gray-700;
}

.heading-anchor {
  @apply absolute -left-6 top-0 opacity-0 group-hover:opacity-100 transition-opacity no-underline select-none;
  @apply text-gray-400 hover:text-gray-600;
}
.dark .heading-anchor {
  @apply text-gray-500 hover:text-gray-300;
}
`,

    '.gitignore': `.scratch-build-cache

# dependencies (bun install)
node_modules

# output
out
dist
*.tgz

# code coverage
coverage
*.lcov

# logs
logs
_.log
report.[0-9]_.[0-9]_.[0-9]_.[0-9]_.json

# dotenv environment variable files
.env
.env.development.local
.env.test.local
.env.production.local
.env.local

# caches
.eslintcache
.cache
*.tsbuildinfo

# IntelliJ based IDEs
.idea

# Finder (MacOS) folder config
.DS_Store

# End to end test artifacts
test-artifacts
.test-artifacts
`,

    'AGENTS.md': `# AGENTS.md

This is a **scratch** project - a static site built from MDX files using the scratch CLI.

## What is scratch?

scratch is a CLI tool that compiles MDX (Markdown + JSX) files into a static website. It uses Bun as the build tool and bundler, React for rendering, and Tailwind CSS for styling.

## CLI Commands

Run \`scratch --help\` to see all available commands.

### Important Commands

- \`scratch dev\` - Start development server with hot reload
- \`scratch build\` - Build the static site to \`dist/\`
- \`scratch preview\` - Preview the built site locally
- \`scratch clean\` - Clean build artifacts

### Common Flags

- \`-v, --verbose\` - Verbose output for debugging
- \`-p, --port <port>\` - Custom port for dev/preview servers
- \`-n, --no-open\` - Don't auto-open browser

## Project Structure

\`\`\`
project/
\u251c\u2500\u2500 pages/           # MDX and Markdown content (required)
\u2502   \u251c\u2500\u2500 index.mdx    # Homepage (resolves to /)
\u2502   \u2514\u2500\u2500 posts/
\u2502       \u2514\u2500\u2500 hello.mdx  # Resolves to /posts/hello/
\u251c\u2500\u2500 components/      # React components (optional)
\u2502   \u2514\u2500\u2500 Button.jsx
\u251c\u2500\u2500 public/          # Static assets (optional, copied as-is)
\u2502   \u2514\u2500\u2500 logo.png
\u251c\u2500\u2500 theme.css        # Tailwind theme customization (optional)
\u2514\u2500\u2500 dist/            # Build output (generated)
\`\`\`

## Writing Content

### MDX Files

Place \`.mdx\` or \`.md\` files in \`pages/\`. MDX lets you use React components directly in Markdown:

\`\`\`mdx
---
title: My Page
description: A description for SEO
---

# Hello World

This is markdown with a <Button>React component</Button> inline.
\`\`\`

### Frontmatter

YAML frontmatter is automatically extracted and injected as HTML meta tags:

- \`title\` - Page title and og:title
- \`description\` - Meta description and og:description
- \`image\` - og:image
- \`keywords\` - Meta keywords
- \`author\` - Meta author

### URL Path Resolution

- \`pages/index.mdx\` \u2192 \`/\`
- \`pages/about.mdx\` \u2192 \`/about/\`
- \`pages/posts/hello.mdx\` \u2192 \`/posts/hello/\`
- \`pages/posts/index.mdx\` \u2192 \`/posts/\`

The pattern: \`index.mdx\` resolves to its parent directory path, other files get their own directory.

## Components

### Auto-Import (No Explicit Imports Needed!)

Components in \`components/\` or \`pages/\` are **automatically available** in MDX files without importing them. Just use them:

\`\`\`mdx
# My Page

<MyComponent prop="value" />

<Button>Click me</Button>
\`\`\`

The build automatically injects the necessary imports.

**Important:** The component name must match the filename:
- \`components/Button.jsx\` \u2192 \`<Button />\` works
- \`components/ui/Card.tsx\` \u2192 \`<Card />\` works (subdirectories are fine)
- \`pages/Counter.jsx\` \u2192 \`<Counter />\` works (co-located components)
- But a component named \`Button\` defined inside \`helpers.jsx\` will NOT auto-import

If two files have the same basename (e.g., \`components/Button.jsx\` and \`pages/Button.jsx\`), only one will be available.

### Styling with Tailwind

Components can use Tailwind CSS utility classes - they're globally available:

\`\`\`jsx
// components/Card.jsx
export function Card({ children }) {
  return (
    <div className="p-4 rounded-lg shadow-md bg-white hover:shadow-lg transition-shadow">
      {children}
    </div>
  );
}
\`\`\`

### PageWrapper Component

If you create a \`components/PageWrapper.jsx\`, it will **automatically wrap all page content**. Useful for layouts:

\`\`\`jsx
// components/PageWrapper.jsx
export default function PageWrapper({ children }) {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <nav>...</nav>
      <main>{children}</main>
      <footer>...</footer>
    </div>
  );
}
\`\`\`

### Markdown Components

Components in \`components/markdown/\` override default Markdown element rendering:

- \`Heading.tsx\` - Custom heading rendering (h1-h6)
- \`CodeBlock.tsx\` - Custom code block rendering with syntax highlighting

## Static Assets

Files in \`public/\` are copied directly to the build output. Reference them with absolute paths:

\`\`\`mdx
![Logo](/logo.png)
\`\`\`

## Theming

Scratch uses custom prose styling defined in \`theme.css\` for markdown content. The default template includes:

- \`scratch-prose\` class for typography styling
- Dark mode support (follows system preference via \`.dark\` class)

### Customizing the Theme

The \`theme.css\` file contains all prose styling for markdown elements. You can customize:

- Headings (h1-h4), paragraphs, links, lists
- Code blocks and inline code
- Blockquotes, tables, images
- Light and dark mode colors

Simply edit the \`.scratch-prose\` rules in \`theme.css\` to match your design.

### Dark Mode

Dark mode is enabled by default and follows system preferences. The \`PageWrapper\` component uses the \`scratch-prose\` class, and dark mode styles are automatically applied when the \`.dark\` class is present on a parent element.

## Generated Files

These are generated and should be in \`.gitignore\`:

- \`dist/\` - Build output
- \`.scratch-build-cache/\` - Build cache and auto-installed dependencies
`,

    'pages/index.mdx': `---
title: "Scratch"
description: "A CLI for building static MDX websites with Bun"
keywords: ["MDX", "static site", "React", "Bun", "markdown"]
author: "Scratch"
type: "website"
lang: "en"
---


<div className="flex items-center justify-center gap-4 mr-10">
  <img src="/scratch.svg" alt="Scratch" className="h-20 w-16 pb-4" />
  <h1 className="text-4xl font-bold">Scratch</h1>
</div>

Scratch compiles MDX files into beatiful static websites. Write in Markdown, embed React components, and publish in seconds.

## Quick Start

\`\`\`bash
# Install scratch
brew install scratch

# Start the dev server
scratch dev

# Build for production
scratch build

# Publish
scratch push
\`\`\`

## Why use Scratch?

Scratch lets you write in Markdown and embed interactive react components, like this counter:

<Counter />

It's great for building personal websites like [koomen.dev](https://koomen.dev) or writing technical content with interactive components like [this essay](https://koomen.dev/essays/horseless-carriages).

## Features

- **Zero config** - Create a new project with \`scratch create\` and start writing
- **No boilerplate** - Just put markdown in \`pages/\`, code in \`components/\`
- **MDX support** - Embed interactive react components in your writing
- **Built on [Bun](https://bun.com/)** - Fast builds, hot reloads, and built-in typescript support

## Examples

If you included examples when creating this project, you can view them [here](/examples).

[View on GitHub](https://github.com/koomen/scratch)
`,

    'pages/Counter.jsx': `import React, { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div className="flex justify-center items-center gap-3 py-2">
      <button
        onClick={() => setCount((c) => c - 1)}
        className="w-8 h-8 flex items-center justify-center rounded-full border border-gray-300 hover:border-gray-400 text-gray-600 transition-colors"
      >
        -
      </button>
      <span className="text-xl font-medium text-gray-900 w-8 text-center tabular-nums">
        {count}
      </span>
      <button
        onClick={() => setCount((c) => c + 1)}
        className="w-8 h-8 flex items-center justify-center rounded-full border border-gray-300 hover:border-gray-400 text-gray-600 transition-colors"
      >
        +
      </button>
    </div>
  );
}
`,

    'public/scratch.svg': `<svg width="98" height="96" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="#24292f"/></svg>`,

    'components/PageWrapper.jsx': `import React from 'react';

/**
 * A simple wrapper applied to every page in the demo project. Feel free to
 * replace this with your own layout \u2013 the scratch CLI will automatically detect
 * the component and wrap each MDX page with it during the build.
 */
export default function PageWrapper({ children }) {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 scratch-prose max-w-2xl mx-auto px-6 py-16">
      {children}
    </div>
  );
}
`,

    'components/markdown/index.ts': `export { CodeBlock } from './CodeBlock';
export { H2, H3 } from './Heading';
export { default as Link } from './Link';

import { CodeBlock } from './CodeBlock';
import { H2, H3 } from './Heading';
import Link from './Link';

// Only override elements that need interactivity
// All other styling is handled by .scratch-prose CSS class
export const MDXComponents = {
  pre: CodeBlock,
  h2: H2,
  h3: H3,
  a: Link,
};
`,

    'components/markdown/CodeBlock.tsx': `import React, { useState, useRef } from 'react';

interface CodeBlockProps {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function CodeBlock({ children, className, style, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = async () => {
    if (!preRef.current) return;

    const code = preRef.current.textContent || '';
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      <button
        onClick={handleCopy}
        className="copy-button"
        aria-label="Copy code"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre ref={preRef} className={className} style={style} {...props}>
        {children}
      </pre>
    </div>
  );
}
`,

    'components/markdown/Heading.tsx': `import React from 'react';

interface HeadingProps {
  children?: React.ReactNode;
  level: 2 | 3;
}

function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\\s+/g, '-')
    .replace(/[^\\w\\-]+/g, '')
    .replace(/\\-\\-+/g, '-');
}

function getTextContent(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(getTextContent).join('');
  if (React.isValidElement(children) && children.props?.children) {
    return getTextContent(children.props.children);
  }
  return '';
}

export function Heading({ children, level }: HeadingProps) {
  const text = getTextContent(children);
  const id = slugify(text);
  const Tag = \`h\${level}\` as const;

  return (
    <Tag id={id} className="group relative">
      <a
        href={\`#\${id}\`}
        className="heading-anchor"
        aria-label={\`Link to \${text}\`}
      >
        #
      </a>
      {children}
    </Tag>
  );
}

export function H2(props: Omit<HeadingProps, 'level'>) {
  return <Heading {...props} level={2} />;
}

export function H3(props: Omit<HeadingProps, 'level'>) {
  return <Heading {...props} level={3} />;
}
`,

    'components/markdown/Link.tsx': `import React from 'react';

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string;
  children?: React.ReactNode;
}

export default function Link({ href, children, ...props }: LinkProps) {
  const isExternal = href?.startsWith('http://') || href?.startsWith('https://');

  return (
    <a
      href={href}
      {...(isExternal && { target: '_blank', rel: 'noopener noreferrer' })}
      {...props}
    >
      {children}
    </a>
  );
}
`,
  },

  examples: {
    'pages/examples/index.md': `# Examples

These examples demonstrate Scratch features.

## Pages

- [Markdown](/examples/markdown/)  Common markdown formatting: headings, lists, code blocks, tables, and more
- [TodoList](/examples/todolist-spec/)  Interactive React component with state management and localStorage persistence
`,

    'pages/examples/markdown.md': `---
title: Markdown Features | Scratch
description: A comprehensive showcase of all markdown features supported by Scratch
---

# Markdown Features

This page demonstrates the full range of markdown features you can use in your Scratch projects.

## Headings

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

## Text Formatting

This is **bold text** and this is *italic text*.

You can also use __underscores for bold__ and _underscores for italic_.

Combine them for ***bold and italic*** text.

Use ~~strikethrough~~ to cross out text.

## Links

[Inline link](https://example.com)

[Link with title](https://example.com "Example Website")

[Reference-style link][reference]

[reference]: https://example.com

Autolinks: <https://example.com>

## Images

![Alt text for image](/scratch.svg "Scratch logo")

## Lists

### Unordered Lists

- Item one
- Item two
  - Nested item A
  - Nested item B
    - Deeply nested
- Item three

### Ordered Lists

1. First item
2. Second item
   1. Nested numbered item
   2. Another nested item
3. Third item

### Task Lists

- [x] Completed task
- [ ] Incomplete task
- [ ] Another task to do

## Blockquotes

> This is a blockquote.
>
> It can span multiple paragraphs.

> Nested blockquotes:
>
> > This is nested inside another blockquote.

## Code

Inline \`code\` looks like this.

### Fenced Code Blocks

\`\`\`javascript
function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

greet('World');
\`\`\`

\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

print(fibonacci(10))
\`\`\`

\`\`\`css
.container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
}
\`\`\`

\`\`\`bash
# Install dependencies
bun install

# Start development server
bun run dev
\`\`\`

## Tables

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Headers | Yes | Required |
| Alignment | Yes | Left, center, right |
| Inline formatting | Yes | **Bold**, *italic*, \`code\` |

### Right-Aligned Table

| Item | Quantity | Price |
|------|:--------:|------:|
| Apples | 4 | $1.00 |
| Oranges | 6 | $1.50 |
| Bananas | 3 | $0.75 |
| **Total** | **13** | **$3.25** |

## Footnotes

Here's a sentence with a footnote[^1].

And another one[^note].

[^1]: This is the first footnote.
[^note]: This is a named footnote with more content.

## Escaping Characters

Use backslashes to escape special characters:

\\*Not italic\\*

\\\`Not code\\\`

\\# Not a heading

## HTML in Markdown

<details>
<summary>Click to expand</summary>

This content is hidden by default but can be revealed by clicking the summary.

You can include any markdown here:
- Lists
- **Formatting**
- [Links](/)

</details>

<div style="padding: 1rem; background: #f0f0f0; border-radius: 8px;">
  <strong>Custom styled box</strong>
  <p>HTML can be embedded directly in markdown for custom layouts.</p>
</div>

## Line Breaks

First line with two trailing spaces
Second line (soft break)

First line

Second line (hard break with blank line)

## Special Characters

- Em dash: \u2014
- En dash: \u2013
- Ellipsis: \u2026
- Copyright: \u00a9
- Trademark: \u2122
- Arrows: \u2192 \u2190 \u2191 \u2193
- Math: \u00b1 \u00d7 \u00f7 \u2260 \u2264 \u2265

## Emoji

\ud83d\ude0a \ud83d\ude80 \u2764\ufe0f

[Back to Home](/)
`,

    'pages/examples/todolist-spec.mdx': `---
title: Todo List App Design | Scratch
description: A design document for a simple todo list app, with live interactive demos
---

# Todo List App Design

This document outlines a simple todo list application built with TypeScript and React. It demonstrates how MDX lets you embed working components directly in documentation.

## Overview

The todo list app lets users:
- Add new tasks
- Mark tasks as complete or incomplete
- Delete tasks
- Persist data across page reloads

## Data Model

The core data structure is a \`Todo\` interface:

\`\`\`typescript
interface Todo {
  id: number;
  text: string;
  completed: boolean;
}
\`\`\`

Each todo has a unique \`id\` (generated from \`Date.now()\`), the task \`text\`, and a \`completed\` boolean.

## Shared State

Both components below share state via a \`useTodos\` hook. Adding a todo in one component immediately appears in the other:

\`\`\`typescript
const { todos, addTodo, toggleTodo, deleteTodo, reset } = useTodos();
\`\`\`

The hook uses a module-level variable with a listener pattern, so all components stay in sync. State persists to localStorage automatically.

## Components

### TodoInput

A simple input for adding new items:

<TodoInput />

### TodoList

The complete todo list with checkboxes, delete buttons, and item count:

<TodoList />

## Persistence

The \`useTodos\` hook handles localStorage automatically:

\`\`\`typescript
function getTodos(): Todo[] {
  if (globalTodos === null) {
    const stored = localStorage.getItem(STORAGE_KEY);
    globalTodos = stored ? JSON.parse(stored) : [];
  }
  return globalTodos;
}

function updateTodos(newTodos: Todo[]) {
  globalTodos = newTodos;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(newTodos));
  notifyListeners();
}
\`\`\`

Data loads lazily on first access and saves on every change.

## Implementation Notes

This design prioritizes simplicity:
- Shared state via a custom hook (no Redux or Context)
- localStorage for persistence
- Tailwind CSS for styling
- TypeScript for type safety

[Back to Home](/)
`,

    'pages/examples/TodoList.tsx': `import React, { useState } from "react";
import { useTodos } from "./useTodos";

export default function TodoList() {
  const { todos, addTodo, toggleTodo, deleteTodo, reset } = useTodos();
  const [input, setInput] = useState("");

  const handleAdd = () => {
    addTodo(input);
    setInput("");
  };

  return (
    <div className="not-prose border border-gray-200 dark:border-gray-700 rounded-lg p-4 my-4">
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Add a todo..."
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400"
        />
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors"
        >
          Add
        </button>
      </div>

      {todos.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-center py-4">No todos yet. Add one above!</p>
      ) : (
        <ul className="space-y-2">
          {todos.map((todo) => (
            <li
              key={todo.id}
              className="flex items-center gap-3 p-2 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => toggleTodo(todo.id)}
                className="w-4 h-4 rounded border-gray-300 dark:border-gray-600"
              />
              <span
                className={\`flex-1 \${
                  todo.completed ? "line-through text-gray-400 dark:text-gray-500" : "text-gray-900 dark:text-gray-100"
                }\`}
              >
                {todo.text}
              </span>
              <button
                onClick={() => deleteTodo(todo.id)}
                className="text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 transition-colors"
                aria-label="Delete todo"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center">
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {todos.filter((t) => !t.completed).length} remaining
        </span>
        <button
          onClick={reset}
          className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
`,

    'pages/examples/TodoInput.tsx': `import React, { useState } from "react";
import { useTodos } from "./useTodos";

export default function TodoInput() {
  const { todos, addTodo, reset } = useTodos();
  const [input, setInput] = useState("");

  const handleAdd = () => {
    addTodo(input);
    setInput("");
  };

  return (
    <div className="not-prose border border-gray-200 dark:border-gray-700 rounded-lg p-4 my-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Add a todo..."
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400"
        />
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md hover:bg-gray-700 dark:hover:bg-gray-300 transition-colors"
        >
          Add
        </button>
      </div>

      {todos.length > 0 && (
        <div className="mt-3">
          <ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
            {todos.map((todo) => (
              <li key={todo.id}>+ {todo.text}</li>
            ))}
          </ul>
          <button
            onClick={reset}
            className="mt-2 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
`,

    'pages/examples/useTodos.ts': `import { useState, useEffect } from "react";

export interface Todo {
  id: number;
  text: string;
  completed: boolean;
}

const STORAGE_KEY = "scratch-demo-todos";

let globalTodos: Todo[] | null = null;
let listeners: Set<(todos: Todo[]) => void> = new Set();

function getTodos(): Todo[] {
  if (globalTodos === null) {
    if (typeof window === "undefined") {
      globalTodos = [];
    } else {
      const stored = localStorage.getItem(STORAGE_KEY);
      globalTodos = stored ? JSON.parse(stored) : [];
    }
  }
  return globalTodos;
}

function saveToStorage(todos: Todo[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}

function notifyListeners() {
  listeners.forEach((listener) => listener(getTodos()));
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>(() => getTodos());

  useEffect(() => {
    // Sync state with global on mount (in case another component already loaded)
    setTodos(getTodos());

    // Subscribe to changes
    const listener = (newTodos: Todo[]) => setTodos(newTodos);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const updateTodos = (newTodos: Todo[]) => {
    globalTodos = newTodos;
    saveToStorage(newTodos);
    notifyListeners();
  };

  const addTodo = (text: string) => {
    if (!text.trim()) return;
    updateTodos([...getTodos(), { id: Date.now(), text: text.trim(), completed: false }]);
  };

  const toggleTodo = (id: number) => {
    updateTodos(getTodos().map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));
  };

  const deleteTodo = (id: number) => {
    updateTodos(getTodos().filter((t) => t.id !== id));
  };

  const reset = () => {
    updateTodos([]);
  };

  return { todos, addTodo, toggleTodo, deleteTodo, reset };
}
`,
  },
} as const;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export type TemplateCategory = keyof typeof templates;

/**
 * Write all templates from a category to a target directory.
 * Does not overwrite existing files unless overwrite is true.
 * Returns list of files that were created.
 */
export async function materializeTemplates(
  category: TemplateCategory,
  targetDir: string,
  options: { overwrite?: boolean } = {}
): Promise<string[]> {
  const { overwrite = false } = options;
  const created: string[] = [];
  const templateFiles = templates[category];

  await fs.mkdir(targetDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(templateFiles)) {
    const targetPath = path.join(targetDir, relativePath);
    const targetDirPath = path.dirname(targetPath);

    await fs.mkdir(targetDirPath, { recursive: true });

    const exists = await fs.exists(targetPath);
    if (exists && !overwrite) {
      log.debug(`Skipped ${relativePath}`);
      continue;
    }

    await fs.writeFile(targetPath, content);
    log.debug(`${exists ? 'Overwrote' : 'Wrote'} ${relativePath}`);
    created.push(relativePath);
  }

  return created;
}

/**
 * Write a single template file to a target path.
 * Creates parent directories as needed.
 */
export async function materializeTemplate(
  category: TemplateCategory,
  filename: string,
  targetPath: string
): Promise<void> {
  const templateFiles = templates[category] as Record<string, string>;
  const content = templateFiles[filename];

  if (!content) {
    throw new Error(`Template not found: ${category}/${filename}`);
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

/**
 * Get the content of a template file without writing to disk.
 */
export function getTemplateContent(
  category: TemplateCategory,
  filename: string
): string {
  const templateFiles = templates[category] as Record<string, string>;
  const content = templateFiles[filename];

  if (!content) {
    throw new Error(`Template not found: ${category}/${filename}`);
  }

  return content;
}

/**
 * Check if a template file exists.
 */
export function hasTemplate(
  category: TemplateCategory,
  filename: string
): boolean {
  const templateFiles = templates[category] as Record<string, string>;
  return filename in templateFiles;
}

/**
 * List all template files in a category.
 */
export function listTemplateFiles(category: TemplateCategory): string[] {
  return Object.keys(templates[category]);
}
