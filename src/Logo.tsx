// The Sniffo mascot (same drawing as assets/icon.svg). `tile` adds the graphite app-icon square and the sniffed streams.
export function Logo({ size = 22, tile = false }: { size?: number; tile?: boolean }) {
  if (!tile) {
    return (
      <svg className="logo" width={size} height={size} viewBox="10 14 80 70" aria-hidden="true">
        <path d="M29 37 Q35 28 41 37 M59 37 Q65 28 71 37" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
        <circle cx="36" cy="64" r="10" fill="#c6f24e" />
        <circle cx="64" cy="64" r="10" fill="#c6f24e" />
        <circle cx="50" cy="58" r="17" fill="#c6f24e" />
        <ellipse cx="43" cy="70" rx="3.8" ry="2.4" fill="#111214" />
        <ellipse cx="57" cy="70" rx="3.8" ry="2.4" fill="#111214" />
      </svg>
    );
  }
  return (
    <svg className="logo tile" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="22.5" fill="#17181b" />
      <g fill="none" stroke="#c6f24e" strokeWidth="4" strokeLinecap="round" strokeDasharray="0.1 8" opacity="0.7">
        <path d="M14 97 C24 91 34 86 42 77" />
        <path d="M86 97 C76 91 66 86 58 77" />
      </g>
      <path d="M29 37 Q35 28 41 37 M59 37 Q65 28 71 37" fill="none" stroke="#ececef" strokeWidth="4" strokeLinecap="round" />
      <circle cx="36" cy="64" r="9" fill="#c6f24e" />
      <circle cx="64" cy="64" r="9" fill="#c6f24e" />
      <circle cx="50" cy="58" r="16" fill="#c6f24e" />
      <ellipse cx="44" cy="51" rx="4.5" ry="2.5" fill="#fff" opacity="0.55" transform="rotate(-30 44 51)" />
      <ellipse cx="43" cy="70" rx="3.6" ry="2.3" fill="#111214" />
      <ellipse cx="57" cy="70" rx="3.6" ry="2.3" fill="#111214" />
    </svg>
  );
}
