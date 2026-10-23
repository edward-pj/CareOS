import { ShopScreen } from "./components/Shop";
import { useSettings } from "./hooks/useSettings";
import { useShop } from "./hooks/useShop";

/** The simulated Amazon storefront as its own window (#/shop). Same canvas and scaling as the Echo Show simulator. */
export function ShopPage() {
  useSettings(); // applies the saved contrast / motion preferences to this window too
  const shop = useShop();
  return (
    <div className="stage">
      <div className="device" style={{ paddingBottom: 0 }}>
        <ShopScreen shop={shop} mode="page" />
      </div>
    </div>
  );
}
