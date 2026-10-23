/** Shared SVG filters (goo for the sliding pills, liquid for the orb). Rendered once at the top of the device. */
export function GlassDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden focusable="false">
      <defs>
        <filter id="goo" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b" />
          <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10" />
        </filter>
        <filter id="liquid" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="4" result="n">
            <animate attributeName="baseFrequency" dur="18s" values="0.012 0.018;0.02 0.01;0.012 0.018" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="38" />
        </filter>
      </defs>
    </svg>
  );
}

/** The living orb. `hue` shifts it from teal toward amber or red; `active` (listening or thinking) quickens the breathing. */
export function Orb({ size = 300, hue = 0, active = false, ring = false }: { size?: number; hue?: number; active?: boolean; ring?: boolean }) {
  return (
    <div className="orb" data-active={active} style={{ width: size, ["--hue" as string]: `${hue}deg` }} aria-hidden>
      <div className="orb-halo" />
      <div className="orb-body">
        <div className="orb-base" />
        <div className="orb-a" />
        <div className="orb-b" />
        <div className="orb-c" />
        <div className="orb-swirl" />
        <div className="orb-floor" />
        <div className="orb-spec" />
        <div className="orb-rim" />
      </div>
      {ring && <div className="orb-ring absolute inset-0 rounded-full border-2 border-alert" style={{ animation: "ring 1.8s ease-out infinite" }} />}
    </div>
  );
}
