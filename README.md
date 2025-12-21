<p align="center">
  <img src="./template/public/scratch.svg" alt="Scratch" height="100" />
</p>

<h1 align="center">Scratch</h1>

<p align="center">
  A CLI for building static MDX websites with Bun
</p>

---

Scratch compiles MDX files into beautiful static websites. Write in Markdown, embed React components, and publish in seconds.

## Quick Start

```bash
# Install scratch
brew install koomen/tap/scratch

# Create a new project
scratch create mysite
cd mysite

# Start the dev server
scratch dev

# Build for production
scratch build
```

## Why Scratch?

Scratch lets you write in Markdown and embed interactive React components. It's great for building personal websites or writing technical content with interactive examples.

- **Zero config** - Create a new project with `scratch create` and start writing
- **No boilerplate** - Just put markdown in `pages/`, code in `components/`
- **MDX support** - Embed interactive React components in your writing
- **Built on [Bun](https://bun.sh/)** - Fast builds, hot reloads, and built-in TypeScript support
- **Tailwind CSS** - Works out-of-the-box with no configuration

## Project Structure

```
mysite/
├── pages/
│   ├── index.mdx
│   └── about.mdx
├── components/
│   └── Counter.jsx
├── public/
│   └── favicon.ico
└── theme.css
```

## Commands

| Command | Description |
|---------|-------------|
| `scratch init [path]` | Initialize a minimal project (flags: `--full`, `--examples`) |
| `scratch create [path]` | Create a project with interactive prompts |
| `scratch dev [path]` | Start the development server |
| `scratch build [path]` | Build for production |
| `scratch preview [path]` | Preview the production build |
| `scratch clean [path]` | Clean build artifacts |

## License

MIT
