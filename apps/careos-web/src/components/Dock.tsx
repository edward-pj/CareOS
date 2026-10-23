export type Menu = "home" | "card" | "orders" | "settings";

const W = 84;
const H = 52;
const icon = { width: 26, height: 26, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

const ITEMS: Array<{ id: Menu; label: string; svg: React.ReactNode }> = [
  { id: "home", label: "Home", svg: <svg {...icon}><circle cx="12" cy="12" r="8" /><path d="M8.5 9.5a5 5 0 0 1 4-2" /></svg> },
  { id: "card", label: "Card", svg: <svg {...icon}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 10h4M7 14h7" /></svg> },
  { id: "orders", label: "Orders", svg: <svg {...icon}><path d="M6 8h12l-1 11H7L6 8z" /><path d="M9 8V7a3 3 0 0 1 6 0v1" /></svg> },
  { id: "settings", label: "Settings", svg: <svg {...icon}><path d="M4 8h9M17 8h3M4 16h3M11 16h9" /><circle cx="15" cy="8" r="2" /><circle cx="9" cy="16" r="2" /></svg> },
];

export interface DockProps {
  active: Menu;
  onSelect: (menu: Menu) => void;
  /** Items in the cart plus orders still on their way. */
  shopBadge: number;
}

/** Bottom navigation: Home, Care card, Orders, Settings. A goo pill slides under the active item. */
export function Dock({ active, onSelect, shopBadge }: DockProps) {
  const index = ITEMS.findIndex((i) => i.id === active);
  const slide = { width: W, height: H, borderRadius: H / 2, background: "#1b6064" };
  return (
    <nav className="glass flex shrink-0 rounded-full p-1.5" aria-label="Menu">
      <div aria-hidden className="pointer-events-none absolute inset-1.5 [filter:url(#goo)]">
        <div className="absolute left-0 top-0" style={{ ...slide, transform: `translateX(${index * W}px)`, transition: "transform .45s cubic-bezier(.3,1.35,.4,1)" }} />
        <div className="absolute left-0 top-0" style={{ ...slide, transform: `translateX(${index * W}px)`, transition: "transform .75s cubic-bezier(.3,1,.3,1)" }} />
      </div>
      {ITEMS.map((i) => (
        <button
          key={i.id}
          onClick={() => onSelect(i.id)}
          aria-label={i.id === "orders" && shopBadge > 0 ? `Orders, ${shopBadge} active` : i.label}
          aria-current={active === i.id ? "page" : undefined}
          style={{ width: W, height: H }}
          className={`relative flex flex-col items-center justify-center gap-1 rounded-full text-[12px] font-medium transition-colors duration-300 ${active === i.id ? "text-white" : "text-[#a9bbcf]"}`}
        >
          {i.svg}
          {i.label}
          {i.id === "orders" && shopBadge > 0 && <span className="absolute right-1.5 top-1 flex h-7 min-w-7 items-center justify-center rounded-full bg-[#ff9900] px-1.5 text-[12px] font-extrabold text-slate-950">{shopBadge}</span>}
        </button>
      ))}
    </nav>
  );
}
