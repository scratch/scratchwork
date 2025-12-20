# AGENTS.md

## Project Overview

scratch is a CLI tool for building static MDX-based websites using Bun. Users create `.md` and `.mdx` files in a `pages/` directory and custom React components in `components/`, and the CLI compiles them into a static site.

## Architecture

### CLI Commands (`src/index.ts`)
- `create [path]` - Scaffold a new project from templates
- `build [path]` - Build the static site
- `dev [path]` - Development server with hot reload
- `preview [path]` - Preview the built site
- `clean [path]` - Clean build artifacts

### Build Pipeline (`src/cmd/build.ts`)
1. Ensure build dependencies are installed (react, react-dom, @mdx-js/react, tailwindcss, @tailwindcss/cli)
2. Reset temp directories (preserving node_modules cache)
3. Create TSX entry files from MD and MDX pages
4. Build Tailwind CSS
5. Build server modules for SSG (if enabled)
6. Run Bun.build() for client bundles
7. Generate HTML files
8. Inject frontmatter meta tags
9. Copy to dist/

### Component Resolution
Components can be placed in two locations:
- `components/` - Shared components available to all pages
- `pages/` - Co-located components alongside MDX files (useful for page-specific components)

Components from both directories are auto-imported into MDX files by basename.

### Key Files
- `src/context.ts` - BuildContext class managing paths, entries, and dependency resolution
- `src/buncfg.ts` - Bun.build() configuration and plugins
- `src/cmd/build.ts` - Main build logic
- `src/cmd/dev.ts` - Development server with live reload
- `src/cmd/preview.ts` - Preview server for built sites

### Template System
- `template/default/` - Default project template (pages, components, theme.css, .gitignore)
- `template/examples/` - Example pages and components (Counter, TodoList, markdown examples)
- `template/internal/` - Internal build infrastructure (entry-client.tsx, entry-server.jsx)
- Templates are resolved with fallback: project root → default template → internal template

### Build Cache (`.scratch-build-cache/`)
- `node_modules/` - Auto-installed build dependencies (react, react-dom, @mdx-js/react, tailwindcss, @tailwindcss/cli)
- `client-src/` - Generated TSX entry files
- `client-compiled/` - Bun.build() output
- `server-src/` - SSG JSX entries
- `server-compiled/` - SSG compiled modules

### Dependency Resolution
- If user has `node_modules/` in project root, uses their dependencies
- Otherwise, auto-installs build essentials to `.scratch-build-cache/node_modules/`
- Tailwind CSS input is symlinked to cache directory so `@import "tailwindcss"` resolves correctly

## Testing

Tests are in `test/` directory. Run with:
```bash
bun test
```

### Testing the Default Template

Do NOT build directly in `template/default/` - this pollutes the template with build artifacts. Instead, create a temp directory and use the CLI:

```bash
# Create a temp project from the template
rm -rf /tmp/test-scratch && mkdir /tmp/test-scratch
bun run src/index.ts create /tmp/test-scratch

# Test the build
bun run src/index.ts build /tmp/test-scratch

# Or test dev server
bun run src/index.ts dev /tmp/test-scratch
```

## Common Patterns

### Adding a new CLI command
1. Create handler in `src/cmd/`
2. Register in `src/index.ts` using Commander

### Modifying build pipeline
1. Update `src/cmd/build.ts`
2. Build config is in `src/buncfg.ts`

### Adding template files
1. Add to `template/default/` for user-facing files (copied to new projects)
2. Add to `template/internal/` for internal build infrastructure (not user-facing)
