// Decorative "fleet constellation": servers as glowing nodes linked by flowing data lines.
// Purely visual (aria-hidden); animation is disabled for users who prefer reduced motion.
const NODES = [
  { x: 60, y: 70, r: 5, d: 0 },
  { x: 170, y: 40, r: 3.5, d: 0.6 },
  { x: 290, y: 95, r: 6, d: 1.2 },
  { x: 120, y: 170, r: 4, d: 1.8 },
  { x: 250, y: 215, r: 5, d: 0.3 },
  { x: 360, y: 165, r: 3.5, d: 2.1 },
  { x: 70, y: 280, r: 3.5, d: 1.5 },
  { x: 190, y: 305, r: 6, d: 0.9 },
  { x: 330, y: 300, r: 4, d: 2.4 },
];
const LINKS: [number, number][] = [
  [0, 1], [1, 2], [0, 3], [2, 4], [3, 4], [4, 5], [2, 5], [3, 6], [6, 7], [4, 7], [7, 8], [5, 8],
];

export function Constellation({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 420 350" className={className} aria-hidden="true" fill="none">
      <defs>
        <linearGradient id="cn-line" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--color-cyan)" stopOpacity="0.9" />
        </linearGradient>
        <radialGradient id="cn-glow">
          <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </radialGradient>
      </defs>
      {LINKS.map(([a, b], i) => (
        <line
          key={i}
          x1={NODES[a].x}
          y1={NODES[a].y}
          x2={NODES[b].x}
          y2={NODES[b].y}
          stroke="url(#cn-line)"
          strokeWidth="1"
          strokeOpacity="0.55"
          className="link-flow"
          style={{ animationDelay: `${(i % 5) * -1}s` }}
        />
      ))}
      {NODES.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={n.r * 5} fill="url(#cn-glow)" />
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill="var(--color-cyan)"
            className="node-pulse"
            style={{ animationDelay: `${n.d}s` }}
          />
          <circle cx={n.x} cy={n.y} r={n.r + 4} stroke="url(#cn-line)" strokeOpacity="0.5" />
        </g>
      ))}
    </svg>
  );
}
