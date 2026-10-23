import { CareService, type Coordinates, type HospitalProvider, type LocaleCode, type Notifier, type ShopEvent, type ShopTimeline, type StorageAdapter, type StorageRoot, type VisionProvider } from "open-caregiver-mcp";
import type { UploadStore } from "./uploads.js";

/** Everything the server needs to act for ONE household. */
export interface Tenant {
  service: CareService;
  storage: StorageAdapter;
}

export type TenantResolver = (householdId: string) => Tenant;

/**
 * Builds one CareService per household over that household's scoped storage, so a request authenticated as
 * household A can only ever reach A's data. Instances are cheap and cached (bounded) for notifier reuse.
 */
export function createTenants(
  root: StorageRoot,
  opts: { notifierFor?: (householdId: string) => Notifier | undefined; clock?: () => number; maxCached?: number; shopTimeline?: ShopTimeline; onShopEvent?: (householdId: string, e: ShopEvent) => void; vision?: VisionProvider; uploads?: UploadStore; locale?: LocaleCode; origin?: Coordinates; hospitals?: HospitalProvider } = {},
): TenantResolver {
  const cache = new Map<string, Tenant>();
  const max = opts.maxCached ?? 500;
  return (householdId) => {
    const hit = cache.get(householdId);
    if (hit) return hit;
    const storage = root.forHousehold(householdId);
    const tenant: Tenant = { storage, service: new CareService(storage, { notifier: opts.notifierFor?.(householdId), clock: opts.clock, householdId, shopTimeline: opts.shopTimeline, onShopEvent: (e) => opts.onShopEvent?.(householdId, e), vision: opts.vision, images: opts.uploads?.forHousehold(householdId), locale: opts.locale, origin: opts.origin, hospitals: opts.hospitals }) };
    cache.set(householdId, tenant);
    if (cache.size > max) cache.delete(cache.keys().next().value!);
    return tenant;
  };
}

/** One fixed tenant, for tests and single-household embeddings. */
export function singleTenant(service: CareService): TenantResolver {
  const tenant: Tenant = { service, storage: service.storage };
  return () => tenant;
}
