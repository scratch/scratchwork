<p align="center">
  <img src="./template/public/scratchwork-logo.svg" alt="Scratchwork" height="120" />
</p>

Scratchwork compiles Markdown and React into beautiful static websites that can be hosted anywhere.

## Quick Start

```bash
# Install scratch
curl -fsSL https://scratchwork.dev/install.sh | bash

# Create a new project
scratch create

# Start the dev server
scratch dev
```

## What can you do with Scratchwork?

Scratchwork lets you write in Markdown and embed interactive React components directly in your content.

Scratchwork was designed for collaborative writing with coding agents like [Claude Code](https://www.claude.com/product/claude-code). Use your favorite editor to write in Markdown, and ask a coding agent for help when it's easier to express yourself with code.

Scratchwork uses [Tailwind Typography](https://github.com/tailwindlabs/tailwindcss-typography) to render your prose with a clean aesthetic. Code blocks use syntax highlighting by [Shiki](https://shiki.style/).

Scratchwork also supports GitHub-flavored Markdown features like checklists and tables:

| Feature | Supported? |
|---------|-----------|
| Compiles Markdown, TS, JS & CSS | ✅ |
| Dev server with HMR | ✅ |
| Tailwind CSS styling | ✅ |
| Code syntax highlighting | ✅ |

Collaborating with AI makes writing more fun. Scratchwork makes that easy.

## No Boilerplate

Scratchwork uses an opinionated project structure and requires **no boilerplate or configuration**: just create a project, run the dev server with `scratch dev`, and start writing.

A simple Scratchwork project (created with `scratch create`) looks like this:

```
my-scratch-project/
├── pages/                    # put markdown and components here
│   ├── index.mdx
│   └── Counter.tsx
├── public/                   # static assets
│   └── favicon.svg
├── src/                      # global components and css
│   ├── PageWrapper.jsx
│   ├── tailwind.css
│   └── markdown/
│       ├── index.ts
│       ├── CodeBlock.tsx
├── AGENTS.md
├── package.json
└── .gitignore
```

Use `scratch build` to compile this project into a static website, like [scratchwork.dev](https://scratchwork.dev).

Component files and libraries can live anywhere in `pages/` and `src/`. They are auto-detected by Scratchwork and don't need to be explicitly imported in your .mdx files as long as the filename matches the component name.

Modify `src/tailwind.css` to change the styling of your document. Add headers, footers and other site-wide elements by modifying `src/PageWrapper.jsx`.

## Commands

```bash
# Create a new project
scratch create [path]         # create project at path (default: current directory)

# Start dev server with hot module reloading
scratch dev

# Build for production
scratch build
scratch build --no-ssg        # disable static site generation
scratch build --development   # unminified, with source maps

# Preview production build locally
scratch preview

# Remove build artifacts
scratch clean

# Revert a file to its template version
scratch checkout [file]            # revert a file to its template version
scratch checkout --force [file]    # overwrite without confirmation
scratch checkout --list            # list available template files

# Watch markdown file(s) with live reload
scratch watch <path>              # file or directory

# Update scratch to latest version
scratch update
```

## Acknowledgements

[Bun](https://bun.com/) for lightning-fast builds, development with HMR, native TypeScript support, and a portable executable.

[React](https://react.dev/) and [MDX](https://mdxjs.com/) make it possible to write with Markdown and code. [Tailwind CSS](https://tailwindcss.com/) makes component styling easy.

Content preprocessing relies on [unified](https://unifiedjs.com/), with [remark-gfm](https://github.com/remarkjs/remark-gfm) for GitHub Flavored Markdown and [remark-frontmatter](https://github.com/remarkjs/remark-frontmatter) plus [gray-matter](https://github.com/jonschlinkert/gray-matter) for parsing front matter.

[Shiki](https://shiki.style/) provides beautiful, accurate syntax highlighting with VS Code's grammar engine.

[Commander.js](https://github.com/tj/commander.js) scaffolds the CLI.

## License

MIT
