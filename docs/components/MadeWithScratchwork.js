// A "Made with Scratchwork" attribution badge: the Scratchwork logo linking to
// scratchwork.dev. Drop <MadeWithScratchwork /> at the foot of any page. Uses
// scratchwork-logo.svg resolved relative to the page (so it works both at the
// site root in `scratchwork dev` and under a published /<id>/ URL); self-styled
// (the renderer ships no Tailwind).
const React = window.React;
const e = React.createElement;

export default function MadeWithScratchwork({ href = "https://scratchwork.dev" }) {
  return e(
    "div",
    { style: { display: "flex", justifyContent: "center", padding: "2rem 0" } },
    e(
      "a",
      {
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
          color: "#9ca3af",
          fontSize: "0.875rem",
          textDecoration: "none",
        },
      },
      e("span", null, "Made with"),
      e("img", {
        src: "scratchwork-logo.svg",
        alt: "Scratchwork",
        style: { height: "2.25rem", paddingBottom: "0.125rem", marginLeft: "-0.2rem" },
      }),
    ),
  );
}
