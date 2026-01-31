import React from "react";

interface MarquisProps {
  children: React.ReactNode;
}

export default function Marquis({ children }: MarquisProps): React.ReactElement {
  return (
    <span className="inline-flex overflow-hidden max-w-32 align-baseline items-end">
      <span className="inline-flex animate-marquis whitespace-nowrap leading-none">
        <span>{children}</span>
        <span className="mx-4">{children}</span>
      </span>
      <style>{`
        @keyframes marquis {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .animate-marquis {
          animation: marquis 3s linear infinite;
        }
      `}</style>
    </span>
  );
}
