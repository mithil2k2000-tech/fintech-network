import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { MerchantDto } from "@fintech-network/shared-types";
import { api } from "../api/client";
import { useSession } from "../session/SessionContext";

// Which shop this person is working for right now. Someone can be in
// more than one (two branches, a market stall and a café), so the app
// remembers the last one and every screen reads it from here rather
// than passing a shop id around.

const LAST_SHOP_KEY = "fn.merchant.lastShopId";

interface ShopValue {
  /** Every shop this person can act for. */
  shops: MerchantDto[];
  /** The one they're working for now, if they've got one. */
  shop: MerchantDto | null;
  loading: boolean;
  error: Error | null;
  select: (id: string) => void;
  /**
   * Take a shop we've just registered straight into the list and open
   * it. Waiting for a re-fetch would briefly leave us with no shop, and
   * the app would bounce back to "register one".
   */
  add: (shop: MerchantDto) => void;
  /** Re-read the list (after joining a shop someone else registered). */
  reload: () => void;
}

const ShopContext = createContext<ShopValue | null>(null);

function readLastShopId(): string | null {
  try {
    return localStorage.getItem(LAST_SHOP_KEY);
  } catch {
    return null;
  }
}

function writeLastShopId(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_SHOP_KEY, id);
    else localStorage.removeItem(LAST_SHOP_KEY);
  } catch {
    // Storage blocked — the app just asks which shop next time.
  }
}

export function ShopProvider({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const [shops, setShops] = useState<MerchantDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(readLastShopId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (status !== "signed-in") {
      setShops([]);
      setLoading(status === "loading");
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .merchants()
      .then(({ merchants }) => {
        if (cancelled) return;
        setShops(merchants);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, attempt]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    writeLastShopId(id);
  }, []);

  const add = useCallback(
    (shop: MerchantDto) => {
      setShops((current) =>
        current.some((s) => s.id === shop.id) ? current : [...current, shop]
      );
      select(shop.id);
    },
    [select]
  );

  // A remembered shop that's no longer ours (access removed, or a
  // different person signed in) falls back to the first one.
  const shop = useMemo(() => {
    if (shops.length === 0) return null;
    return shops.find((s) => s.id === selectedId) ?? shops[0];
  }, [shops, selectedId]);

  const value = useMemo<ShopValue>(
    () => ({
      shops,
      shop,
      loading,
      error,
      select,
      add,
      reload: () => setAttempt((n) => n + 1),
    }),
    [shops, shop, loading, error, select, add]
  );

  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

export function useShop(): ShopValue {
  const value = useContext(ShopContext);
  if (!value) throw new Error("useShop must be used inside ShopProvider");
  return value;
}
