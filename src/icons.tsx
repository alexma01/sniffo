// Stroke icons drawn in currentColor, sized to the text around them.
const PATHS = {
  pin: "M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  unlock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2",
  pause: "M9 5v14M15 5v14",
  phone: "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2",
  laptop: "M5 6h14v10H5zM3 19h18",
  android: "M6 10h12v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM8 10a4 4 0 0 1 8 0M9.5 7 8 5M14.5 7 16 5",
  x: "M6 6l12 12M18 6 6 18",
  check: "M5 12l5 5L20 7",
  alert: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 8v5M12 16.5v.01",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16.5 16.5 21 21",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={PATHS[name]} />
    </svg>
  );
}
