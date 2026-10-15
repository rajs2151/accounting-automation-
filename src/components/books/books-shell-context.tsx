"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type BooksPeriod = {
  id: string;
  label: string;
  status: string;
  periodStart?: string;
  periodEnd?: string;
};

type BooksShellContextValue = {
  periods: BooksPeriod[];
  /** True once the period list request has finished (even if it returned nothing). */
  periodsLoaded: boolean;
  periodId: string;
  setPeriodId: (id: string) => void;
  /** Refetch periods so LOCKED/OPEN stays in sync after Close/Settings lock actions. */
  reloadPeriods: () => Promise<void>;
  globalSearch: string;
  setGlobalSearch: (q: string) => void;
  /** App sidebar collapsed (icon rail). Review page can force-collapse. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
};

const BooksShellContext = createContext<BooksShellContextValue | null>(null);

export function BooksShellProvider({ children }: { children: ReactNode }) {
  const [periods, setPeriods] = useState<BooksPeriod[]>([]);
  const [periodsLoaded, setPeriodsLoaded] = useState(false);
  const [periodId, setPeriodId] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const reloadPeriods = useCallback(async () => {
    try {
      const r = await fetch("/api/books/periods");
      if (!r.ok) return;
      const list = await r.json();
      if (!Array.isArray(list)) return;
      setPeriods(list);
      setPeriodId((current) => {
        if (current && list.some((p: BooksPeriod) => p.id === current)) return current;
        const jun = list.find((p: BooksPeriod) => /Jun\s*2026/i.test(p.label));
        const open = list.find((p: BooksPeriod) => p.status === "OPEN" || p.status === "REOPENED");
        return jun?.id || open?.id || list[0]?.id || "";
      });
    } catch {
      /* ignore */
    } finally {
      setPeriodsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reloadPeriods();
  }, [reloadPeriods]);

  const value = useMemo(
    () => ({
      periods,
      periodsLoaded,
      periodId,
      setPeriodId,
      reloadPeriods,
      globalSearch,
      setGlobalSearch,
      sidebarCollapsed,
      setSidebarCollapsed,
    }),
    [periods, periodsLoaded, periodId, reloadPeriods, globalSearch, sidebarCollapsed],
  );

  return <BooksShellContext.Provider value={value}>{children}</BooksShellContext.Provider>;
}

export function useBooksShell() {
  const ctx = useContext(BooksShellContext);
  if (!ctx) {
    return {
      periods: [] as BooksPeriod[],
      periodsLoaded: true,
      periodId: "",
      setPeriodId: () => undefined,
      reloadPeriods: async () => undefined,
      globalSearch: "",
      setGlobalSearch: () => undefined,
      sidebarCollapsed: false,
      setSidebarCollapsed: () => undefined,
    };
  }
  return ctx;
}
