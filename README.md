# scratch

Scratch is an opinionated static site generator for MDX files.

## Using Tailwind CSS

Tailwind works out-of-the-box – no extra configuration required.
Simply reference Tailwind utility classes in your MDX files or React components
and Scratch will automatically generate and bundle the corresponding stylesheet
for you. During development the styles are served live; in production builds
`/tailwind.css` is emitted and linked from every generated HTML page.

## Installation

```bash
npm install -g scratch
```

## Usage

### Project Structure

Your source files should be arranged as follows in your project directory:

```
/
├── pages/
│   ├── index.mdx
│   └── about.mdx
│   └── articles/
│       ├── index.mdx
│       ├── article1.mdx
│       └── article2.mdx
├── components/
│   ├── PageWrapper.tsx    # A component that wraps every page
│   └── Header.tsx
│
└── static/
    └── favicon.ico
```

### Global Options

These options can be used with any command:

- `-v, --verbose` - Show detailed output
- `-q, --quiet` - Show only errors

### Commands

#### Create a new project

```bash
scratch create [path]
```

Creates a new Scratch project in the specified directory (defaults to current directory).

#### Build the site

```bash
scratch build [path] [options]
```

Builds the site for production.

**Options:**
- `-b, --build <path>` - Build directory
- `-d, --development` - Development mode
- `-s, --ssg [value]` - Static site generation (default: true)
- `--strict` - Do not inject PageWrapper component or missing imports

#### Development server

```bash
scratch dev [path] [options]
```

Starts a development server with hot reloading.

**Options:**
- `-d, --development` - Development mode
- `-n, --no-open` - Do not open dev server endpoint automatically
- `-p, --port <port>` - Port for dev server (default: 5173)
- `--strict` - Do not inject PageWrapper component or missing imports

#### Preview server

```bash
scratch preview [path] [options]
```

Serves the built site locally for a production-like preview.

**Options:**
- `-n, --no-open` - Do not open preview server endpoint automatically
- `-p, --port <port>` - Port for preview server (default: 4173)

#### Clean build directory

```bash
scratch clean [path]
```

Cleans the build directory and temporary files.

## Architecture

1. Scan `./pages` for MDX files
2. Create TSX entry files in `.temp/client-src/` from templates
3. Build Tailwind CSS using the Tailwind CLI
4. (If SSG enabled) Build and render server modules:
   - Create server JSX entry files in `.temp/server-src/`
   - Run `Bun.build()` with server target
   - Import compiled modules and render to HTML strings
5. Run `Bun.build()` with browser target and MDX plugin:
   - Wrap MDX components with `PageWrapper` via `createPreprocessMdxPlugin()`
   - Inject missing component imports via `createPreprocessMdxPlugin()`
   - Transform MDX files into React components
6. Create HTML files with script/CSS references
7. Inject frontmatter metadata into HTML
8. Copy assets to `./build`
