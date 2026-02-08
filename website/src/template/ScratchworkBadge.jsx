export default function ScratchworkBadge() {
  return (
    <a
      href="https://scratchwork.dev"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center text-black text-base font-normal no-underline hover:no-underline"
    >
      <span className="text-lg">Made from</span>
      <img src="/scratchwork-logo.svg" alt="Scratchwork" className="h-13 pb-1" />
    </a>
  );
}
