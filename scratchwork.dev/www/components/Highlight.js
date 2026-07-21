// Inline highlight. Components self-style (the renderer ships no Tailwind),
// here with a plain inline style object.
const React = window.React;
const e = React.createElement;

export default function Highlight({ children }) {
  return e(
    "span",
    { style: { background: "#fef08a", padding: "0 0.25rem", borderRadius: "0.25rem" } },
    children,
  );
}
