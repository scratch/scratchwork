/*
 * Type declarations for Bun's `with { type: "text" }` imports, which load
 * markdown and text assets as plain strings.
 */
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.txt" {
  const text: string;
  export default text;
}
