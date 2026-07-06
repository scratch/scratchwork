/*
 * EDITABLE REGION — page shell & components.
 *
 * This is the part of the rendered page you're meant to hand-edit. It defines:
 *   • window.SCRATCHWORK.layout      — the page chrome wrapped around your markdown
 *   • window.SCRATCHWORK.components  — components your markdown references as <Tag/>
 *
 * Author UI as JSX with the `html` tagged template (htm). `html`, `React`,
 * `ReactDOM`, and `Prism` are provided as globals by the engine. Use React DOM
 * prop names: `className` (not `class`), `htmlFor`, inline `style` objects.
 */

window.SCRATCHWORK = window.SCRATCHWORK || {};
window.SCRATCHWORK.components = window.SCRATCHWORK.components || {};

/* ---------- Page chrome ----------
 * Wraps the rendered markdown, which lives inside `.scratchwork-prose` (styled by
 * the theme above). Edit freely — add a header or footer, rebrand, etc.
 * Props: `children` (the rendered markdown) and `author` (the frontmatter
 * author, if any — handy for a footer credit). */
window.SCRATCHWORK.layout = ({ children }) => html`
  <div className="scratchwork-page">
    <main className="scratchwork-prose">${children}</main>
  </div>
`;

/* ---------- Inline components ----------
 * Define components your markdown uses as <Tag/>. An inline definition here
 * takes precedence; any <Tag/> NOT defined here is lazy-loaded from
 * ./components/<Tag>.js instead. Example:
 *
 * window.SCRATCHWORK.components.Hello = ({ name }) =>
 *   html`<strong>Hello, ${name}!</strong>`;
 */
