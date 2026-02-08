export default function ScratchworkBadge() {
  const base = globalThis.__SCRATCHWORK_BASE__ || '';
  return (
    <a
      href="https://scratchwork.dev"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center text-gray-400 text-sm font-normal no-underline hover:no-underline"
    >
      <span className="text-sm">Made from</span>
      <img src={`${base}/scratchwork-logo.svg`} alt="Scratchwork" className="h-9 pb-0.5" />
    </a>
  );
}
