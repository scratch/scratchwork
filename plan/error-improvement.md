# Error Message Improvement Summary

I reproduced and improved the error output for the CLI build pipeline.

## What I ran
- Built the CLI:
  - `cd /Users/koomen/git/scratch/scratchwork/cli`
  - `bun install`
  - `bun run build`
- Tried the requested target path:
  - `./dist/scratch build /Users/koomen/git/temp/large-scratch-project`
  - The path does not exist in this environment.
- Used the available large project instead:
  - `./dist/scratch build /Users/koomen/git/large-scratch-project`

## What I observed
- The initial failure output was:
  - `Build failed: MDX syntax error: ...` (no source file context)
- The thrown build error that surfaced in CLI formatting had metadata that was being lost when rethrown.
- The underlying failure was in `05b-render-server` and reported:
  - `Failed to render docs/doc-207.mdx: Element type is invalid ...`

## Code changes made
- Updated `cli/src/build/errors.ts`:
  - Added an `ErrorSourceLocation` type for optional `filePath`, `line`, `column`, and `lineText`.
  - Replaced the simple path-only extractor with `extractSourceLocation(...)`:
    - parses `Failed to render ... .mdx|.md:` from MDX render errors
    - parses direct `path:line:column` references
    - parses `line | content` snippets from Bun output
    - resolves `server-compiled|client-compiled/.../index.js` back to `pages/... .mdx` paths
  - Added `formatSourceReference(...)` so matching MDX error templates include ` in <file>[:line[:column]]`.
  - Updated all MDX pattern messages to use the new location formatter.
  - Added fallback behavior for non-pattern matches to append `at <location>` when location can be extracted.

## Result
- Rebuilt CLI after the change and reran:
  - `./dist/scratch build /Users/koomen/git/large-scratch-project`
- New output now includes source context:
  - `Build failed: MDX syntax error in docs/doc-207.mdx: ...`

## Scope notes
- I did not change the underlying document/content causing the failure.
- No behavioral fixes were made to build logic itself, only error message formatting/diagnostics.
