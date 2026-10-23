import type { Shop } from "../hooks/useShop";
import type { ShopChannel, ShopOrder, ShopScenario, ShopView } from "../api/types";
import { countdown, gaugeFill, progressFraction, relativeTime, touched } from "../lib/shop";
import { formatClock } from "../lib/time";

// The simulated Amazon storefront for the household, designed on the same 1920x1080 canvas as the Echo Show.
// Nothing here is computed: prices, totals, stock levels and stages are copied from GET /api/shop. The progress bar
// and gauge widths are layout only; the number printed beside each is always the server's.

const CHANNEL: Record<ShopChannel, { label: string; cls: string }> = {
  prime: { label: "Prime", cls: "border-sky-400/60 text-sky-300" },
  pharmacy: { label: "Pharmacy", cls: "border-violet-400/60 text-violet-300" },
  fresh: { label: "Fresh", cls: "border-emerald-400/60 text-emerald-300" },
};
const usd = (n: number) => `$${n.toFixed(2)}`;
const short = (name: string) => name.split(" (")[0]!;
const AMAZON = "bg-accent text-[#04201a] hover:brightness-110 disabled:opacity-50";

const ChannelChip = ({ channel }: { channel: ShopChannel }) => (
  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[13px] ${CHANNEL[channel].cls}`}>{CHANNEL[channel].label}</span>
);

function Panel({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={`glass flex min-h-0 flex-col rounded-[26px] p-5 ${className}`}>
      <h2 className="mb-3 flex shrink-0 items-center justify-between text-[16px] font-medium text-soft">
        <span>{title}</span>
        {right}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

function Button({ children, onClick, disabled, kind = "ghost" }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; kind?: "primary" | "ghost" | "danger" }) {
  const cls = kind === "primary" ? AMAZON : kind === "danger" ? "border border-alert/60 text-red-200 hover:bg-red-500/20" : "ghost border border-white/25 text-[#dbe6f2]";
  return (
    <button onClick={onClick} disabled={disabled} className={`min-h-[46px] rounded-full px-5 text-[16px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ cart

function Cart({ cart, shop }: { cart: ShopOrder | null; shop: Shop }) {
  if (!cart) {
    return <p className="text-[16px] text-slate-400">Your cart is empty. Say “Alexa, ask CareOS to restock the Motrin”, or add something below.</p>;
  }
  return (
    <div className="flex h-full flex-col">
      <ul className="space-y-2">
        {cart.lines.map((l) => (
          <li key={l.name} className="flex items-start gap-2 rounded-3xl bg-black/25 p-3">
            <ChannelChip channel={l.channel} />
            <span className="min-w-0 flex-1 text-[16px] leading-tight text-white">{short(l.name)}</span>
            <b className="text-[18px] text-white">{usd(l.price_usd)}</b>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-baseline justify-between border-t border-white/15 pt-3">
        <span className="text-[16px] text-slate-400">Total · arrives {cart.eta}</span>
        <b className="text-[32px] text-white">{usd(cart.total_usd)}</b>
      </div>
      <p className="mt-1 text-[14px] text-slate-400">Started by {cart.created_by ?? "someone"} · {relativeTime(shop.now, cart.created_at)}</p>
      <div className="mt-3 flex gap-2">
        <Button kind="primary" disabled={shop.busy === cart.cart_id} onClick={() => shop.order(cart.cart_id)}>Place order (simulated)</Button>
        <Button kind="ghost" disabled={shop.busy === cart.cart_id} onClick={() => shop.cancel(cart.cart_id)}>Clear cart</Button>
      </div>
    </div>
  );
}

function Suggestions({ view, shop }: { view: ShopView; shop: Shop }) {
  if (view.suggestions.length === 0) return <p className="text-[16px] text-slate-400">Nothing is running low.</p>;
  return (
    <ul className="space-y-2">
      {view.suggestions.map((s) => (
        <li key={s.inventory_id} className="flex items-center gap-2 rounded-3xl border border-warn/40 bg-warn/10 p-3">
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold leading-tight text-white">{short(s.name)}</div>
            <div className="text-[14px] text-amber-200">⚠ Low: {s.remaining} {s.unit === "mL" ? "mL" : "left"}</div>
          </div>
          <Button kind="primary" disabled={shop.busy === `add:${s.item_name}`} onClick={() => shop.add(s.item_name)}>Add · {usd(s.price_usd)}</Button>
        </li>
      ))}
    </ul>
  );
}

function Browse({ view, shop }: { view: ShopView; shop: Shop }) {
  return (
    <details className="mt-1 rounded-3xl border border-white/15 bg-black/25 p-3">
      <summary className="cursor-pointer text-[16px] font-semibold text-slate-200">Browse the store ({view.catalog.length})</summary>
      <ul className="mt-2 space-y-1.5">
        {view.catalog.map((c) => (
          <li key={c.name} className="flex items-center gap-2">
            <ChannelChip channel={c.channel} />
            <span className="min-w-0 flex-1 text-[14px] leading-tight text-slate-100">{short(c.name)}</span>
            <button onClick={() => shop.add(c.name)} disabled={shop.busy === `add:${c.name}`} aria-label={`Add ${short(c.name)} to cart`} className="ghost min-h-[44px] min-w-[69px] rounded-full border border-white/25 text-[14px] font-semibold disabled:opacity-50">+ {usd(c.price_usd)}</button>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ------------------------------------------------------------------ orders

function Stepper({ order, now, stages }: { order: ShopOrder; now: number; stages: ShopView["stages"] }) {
  const schedule = order.schedule!;
  const done = order.status === "DELIVERED";
  const frac = done ? 1 : progressFraction(schedule, now);
  const current = stages.findIndex((s) => s.stage === order.stage);
  const left = done ? "" : countdown(schedule, now);
  return (
    <div className="mt-3">
      <div className="relative">
        <div className="h-3 rounded-full bg-white/15" />
        <div className="progress-fill absolute left-0 top-0 h-3 rounded-full bg-accent" style={{ width: `${frac * 100}%` }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label={`${order.stage_label ?? "Order"} progress`} />
      </div>
      <ol className="mt-2 flex justify-between">
        {stages.map((s, i) => (
          <li key={s.stage} className={`flex w-[86px] flex-col items-center text-center text-[13px] leading-tight ${i <= current ? "font-semibold text-emerald-300" : "text-slate-500"}`}>
            <span aria-hidden className={`mb-1 flex h-9 w-9 items-center justify-center rounded-full border-2 text-[13px] ${i < current || done ? "border-emerald-400 bg-emerald-400 text-slate-950" : i === current ? "pulse-dot border-emerald-300 text-emerald-300" : "border-slate-600"}`}>{i < current || done ? "✓" : i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>
      {!done && (
        <p className="mt-2 text-[16px] text-slate-300">
          <b className="text-white">{order.stage_label}</b>
          {left && <> · demo delivery in <span className="tabular-nums text-white">{left}</span></>}
          <span className="text-slate-500"> · promised {order.eta}</span>
        </p>
      )}
    </div>
  );
}

function OrderCard({ order, view, shop, fresh }: { order: ShopOrder; view: ShopView; shop: Shop; fresh: boolean }) {
  const cancelled = order.status === "CANCELLED";
  const delivered = order.status === "DELIVERED";
  const nameOf = (id: string) => view.supplies.find((s) => s.id === id)?.name ?? id;
  const refilled = order.lines.filter((l) => l.restocks).map((l) => `${short(nameOf(l.restocks!.inventoryId))} +${l.restocks!.amount}${view.supplies.find((s) => s.id === l.restocks!.inventoryId)?.unit === "mL" ? " mL" : ""}`);
  const when = order.delivered_at ?? order.cancelled_at ?? order.ordered_at ?? order.created_at;
  return (
    <article className={`rounded-3xl border p-4 ${fresh ? "slide-in ring-flash border-[#ff9900]" : delivered ? "border-mint/40" : cancelled ? "border-white/10 opacity-60" : "border-white/20"} bg-black/25`} aria-label={`Order ${order.order_id ?? ""}`}>
      <header className="flex items-center gap-2">
        <span className="text-[16px] font-bold tracking-wide text-white">{order.order_id}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[13px] font-semibold ${cancelled ? "border-slate-500 text-slate-400" : delivered ? "border-emerald-400/60 text-emerald-300" : "border-amber-400/60 text-amber-300"}`}>
          {cancelled ? "Cancelled" : delivered ? "Delivered" : order.stage_label}
        </span>
        {fresh && <span className="rounded-full bg-[#ff9900] px-2 py-0.5 text-[13px] font-extrabold text-slate-950">NEW</span>}
        <b className={`ml-auto text-[22px] ${cancelled ? "text-slate-400 line-through" : "text-white"}`}>{usd(order.total_usd)}</b>
      </header>
      <p className="mt-1 text-[14px] text-slate-400">
        {order.ordered_by ? `Placed by ${order.ordered_by}` : "Placed"} · {relativeTime(shop.now, when)}
      </p>
      <ul className="mt-1.5 text-[16px] leading-snug text-slate-200">
        {order.lines.map((l) => <li key={l.name}>• {short(l.name)}</li>)}
      </ul>
      {!cancelled && order.schedule && <Stepper order={order} now={shop.now} stages={view.stages} />}
      {delivered && refilled.length > 0 && <p className="mt-2 rounded-2xl bg-mint/10 p-3 text-[16px] text-emerald-200">📦 Arrived. Restocked: {refilled.join(", ")}</p>}
      {order.can_cancel && (
        <div className="mt-2"><Button kind="danger" disabled={shop.busy === order.cart_id} onClick={() => shop.cancel(order.cart_id)}>Cancel order</Button></div>
      )}
      {order.status === "ORDERED" && !order.can_cancel && <p className="mt-2 text-[14px] text-slate-500">Already shipped, so it can’t be cancelled here.</p>}
    </article>
  );
}

// ------------------------------------------------------------------ supplies + activity

function Supplies({ view }: { view: ShopView }) {
  const items = view.supplies.filter((s) => s.unit !== "pantry");
  const pantry = view.supplies.filter((s) => s.unit === "pantry");
  return (
    <div>
      <ul className="space-y-3">
        {items.map((s) => (
          <li key={s.id}>
            <div className="flex items-baseline justify-between gap-2 text-[16px]">
              <span className="leading-tight text-slate-100">{short(s.name)}</span>
              <b className={`shrink-0 tabular-nums ${s.low ? "text-amber-300" : "text-white"}`}>{s.remaining} {s.unit === "mL" ? "mL" : ""}</b>
            </div>
            <div className="mt-1 h-4 overflow-hidden rounded-full bg-white/15" role="img" aria-label={`${short(s.name)}: ${s.remaining} ${s.unit === "mL" ? "milliliters" : "left"}${s.low ? ", running low" : ""}`}>
              <div className={`gauge-fill h-4 rounded-full ${s.low ? "bg-warn" : "bg-accent"}`} style={{ width: `${gaugeFill(s.remaining, s.low_threshold) * 100}%` }} />
            </div>
            {s.low && <div className="mt-1 text-[13px] text-amber-300">⚠ Running low</div>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[13px] text-slate-500">Pantry: {pantry.map((p) => `${p.name} ${p.remaining}`).join(" · ")}</p>
    </div>
  );
}

function Activity({ view, now }: { view: ShopView; now: number }) {
  if (view.activity.length === 0) return <p className="text-[16px] text-slate-400">Nothing yet.</p>;
  return (
    <ol className="space-y-2" aria-live="polite">
      {view.activity.slice(0, 12).map((a, i) => (
        <li key={`${a.cart_id}-${a.at}-${i}`} className={`border-l-4 pl-2 text-[14px] leading-snug ${i === 0 ? "border-[#ff9900] text-white" : "border-slate-600 text-slate-300"}`}>
          {a.text}
          <div className="text-[12px] text-slate-500">{relativeTime(now, a.at)}</div>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ presenter controls

const SCENARIOS: { id: ShopScenario; label: string; hint: string }[] = [
  { id: "dad_orders", label: "Dad orders Tylenol", hint: "Another caregiver orders from their phone" },
  { id: "low_stock", label: "Motrin runs low", hint: "A dose empties the bottle" },
  { id: "fast_forward", label: "Fast-forward delivery", hint: "Skip the wait" },
  { id: "reset_orders", label: "Clear orders", hint: "Start over" },
];

function Presenter({ shop, mode }: { shop: Shop; mode: "overlay" | "page" }) {
  return (
    <footer className="glass mx-4 mb-3 flex shrink-0 items-center gap-2 rounded-full px-4 py-2" aria-label="Presenter controls">
      <span className="text-[13px] font-medium text-muted">Demo controls</span>
      {SCENARIOS.map((s) => (
        <button key={s.id} title={s.hint} onClick={() => shop.scenario(s.id)} disabled={shop.busy === s.id} className="ghost min-h-[44px] rounded-full border border-white/20 px-3.5 text-[14px] text-[#dbe6f2] disabled:opacity-50">{s.label}</button>
      ))}
      {mode === "overlay" && (
        <a href="#/shop" target="_blank" rel="noreferrer" className="ghost ml-auto flex min-h-[44px] items-center rounded-full border border-glow/50 px-3.5 text-[14px] text-glow">Open in a second window ↗</a>
      )}
      {mode === "page" && <span className="ml-auto text-[14px] text-slate-500">Say it on the Echo, watch it appear here.</span>}
    </footer>
  );
}

// ------------------------------------------------------------------ the screen

export function ShopScreen({ shop, mode, onClose }: { shop: Shop; mode: "overlay" | "page"; onClose?: () => void }) {
  const view = shop.view;
  const flashing = touched(shop.events, shop.now);
  const header = (
    <header className="flex h-[69px] shrink-0 items-center gap-3.5 px-8.5 pt-3">
      <span className="font-display text-[24px] font-medium tracking-wide text-white">Household orders</span>
      <span className="rounded-full border border-warn/50 bg-warn/10 px-3.5 py-1 text-[13px] font-medium text-warn">Simulated store · nothing is really bought</span>
      <div className="ml-auto flex items-center gap-3.5">
        <span className={`flex items-center gap-1.5 text-[16px] font-semibold ${shop.connected ? "text-emerald-300" : "text-amber-300"}`} role="status">
          <span className={`h-3 w-3 rounded-full ${shop.connected ? "pulse-dot bg-emerald-400" : "bg-amber-400"}`} aria-hidden />
          {shop.connected ? "LIVE" : "RECONNECTING"}
        </span>
        <span className="text-[22px] font-semibold tabular-nums">{formatClock(shop.now)}</span>
        {onClose && <button onClick={onClose} aria-label="Close orders" className="ghost min-h-[46px] rounded-full border border-white/25 px-5 text-[16px] font-semibold text-[#dbe6f2]">✕ Close</button>}
      </div>
    </header>
  );

  return (
    <div className="ground relative flex h-full flex-col" data-testid="shop-screen">
      {header}
      {shop.error && <div role="alert" className="shrink-0 border-b-2 border-amber-400 bg-amber-400/15 px-5.5 py-1.5 text-[16px] text-amber-100">{shop.error}</div>}

      {!view ? (
        <div className="flex flex-1 items-center justify-center text-[22px] text-slate-400">Loading your orders…</div>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-[380px_1fr_340px] gap-4 px-8.5 py-3.5">
          <div className="flex min-h-0 flex-col gap-3">
            <Panel title="Your cart" right={view.cart ? <span className="text-[14px] normal-case text-slate-400">{view.cart.lines.length} item{view.cart.lines.length === 1 ? "" : "s"}</span> : undefined} className={view.cart && flashing.has(view.cart.cart_id) ? "ring-flash border-[#ff9900]" : ""}>
              <Cart cart={view.cart} shop={shop} />
            </Panel>
            <Panel title="Running low" className="max-h-[302px]">
              <Suggestions view={view} shop={shop} />
            </Panel>
            <Browse view={view} shop={shop} />
          </div>

          <Panel title="Orders" right={<span className="text-[14px] normal-case text-slate-400">Demo clock: delivery in {view.delivery_seconds}s</span>}>
            {view.orders.length === 0 ? (
              <p className="text-[16px] text-slate-400">No orders yet. Place the cart on the left, or say “confirm the order”.</p>
            ) : (
              <div className="space-y-3">
                {view.orders.map((o) => <OrderCard key={o.cart_id} order={o} view={view} shop={shop} fresh={flashing.has(o.cart_id)} />)}
              </div>
            )}
          </Panel>

          <div className="flex min-h-0 flex-col gap-3">
            <Panel title="Supplies in the house"><Supplies view={view} /></Panel>
            <Panel title="Activity" className="min-h-0 flex-1"><Activity view={view} now={shop.now} /></Panel>
          </div>
        </main>
      )}

      <Presenter shop={shop} mode={mode} />

      <div className="pointer-events-none absolute bottom-[75px] left-4 z-50 flex w-[403px] flex-col-reverse gap-2" aria-live="polite">
        {shop.toasts.map((t) => (
          <div key={t.id} role="status" className={`slide-in pointer-events-auto flex items-start gap-2 rounded-3xl border-2 p-3 text-[16px] font-semibold shadow-2xl ${t.tone === "good" ? "border-emerald-400 bg-emerald-950 text-emerald-100" : t.tone === "warn" ? "border-amber-400 bg-amber-950 text-amber-100" : "border-sky-400 bg-sky-950 text-sky-100"}`}>
            <span aria-hidden>{t.tone === "good" ? "✔" : t.tone === "warn" ? "⚠" : "🛒"}</span>
            <span className="flex-1">{t.text}</span>
            <button onClick={() => shop.dismissToast(t.id)} aria-label="Dismiss" className="pointer-events-auto text-slate-300">✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
