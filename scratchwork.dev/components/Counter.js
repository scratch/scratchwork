// A small stateful counter. The renderer ships no Tailwind, so components
// style themselves. For anything inline styles can't express (:hover, focus,
// keyframes) we inject a tiny scoped stylesheet once via injectOnce().
const React = window.React;
const { useState } = React;
const e = React.createElement;

function injectOnce(id, css) {
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

injectOnce(
  "sc-counter",
  `.sc-counter { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; }
   .sc-counter button {
     width: 2rem; height: 2rem; display: flex; align-items: center; justify-content: center;
     border: 0; border-radius: 0.375rem; background: #f3f4f6; color: #4b5563;
     font-size: 1.125rem; cursor: pointer; transition: background-color 150ms ease;
   }
   .sc-counter button:hover { background: #e5e7eb; }
   .sc-counter .sc-count { font-size: 1.25rem; font-weight: 500; color: #111827; width: 2rem; text-align: center; font-variant-numeric: tabular-nums; }`,
);

export default function Counter() {
  const [count, setCount] = useState(0);
  return e(
    "div",
    { className: "sc-counter" },
    e("button", { onClick: () => setCount((c) => c - 1), "aria-label": "Decrement" }, "-"),
    e("span", { className: "sc-count" }, count),
    e("button", { onClick: () => setCount((c) => c + 1), "aria-label": "Increment" }, "+"),
  );
}
