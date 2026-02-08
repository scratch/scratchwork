export default function Header() {
  return (
    <header className="not-prose flex justify-between items-center mb-4">
      <a href="/" className="opacity-60 hover:opacity-100 transition-opacity">
        <img src="/scratchwork-logo.svg" alt="Scratchwork" className="h-10" />
      </a>
      <nav className="flex gap-6">
        <a href="/docs/" className="opacity-60 hover:opacity-100 transition-opacity">Docs</a>
      </nav>
      <div className="flex gap-4">
        <a href="https://github.com/scratchwork/scratchwork" target="_blank" rel="noopener noreferrer" className="opacity-60 hover:opacity-100 transition-opacity">
          <img src="/github-mark.svg" alt="GitHub" className="w-6 h-6" />
        </a>
        <a href="https://x.com/koomen" target="_blank" rel="noopener noreferrer" className="opacity-60 hover:opacity-100 transition-opacity">
          <img src="/x-logo.svg" alt="X" className="w-6 h-6" />
        </a>
      </div>
    </header>
  );
}
