"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type BooksPeriod = { id: string; label: string; status: string };

type BooksShellContextValue = {
  periods: BooksPeriod[];
  /** True once the period list request has finished (even if it returned nothing). */
  periodsLoaded: boolean;
  periodId: string;
  setPeriodId: (id: string) => void;
  globalSearch: string;
  setGlobalSearch: (q: string) => void;
};

const BooksShellContext = createContext<BooksShellContextValue | null>(null);

export function BooksShellProvider({ children }: { children: ReactNode }) {
  const [periods, setPeriods] = useState<BooksPeriod[]>([]);
  const [periodsLoaded, setPeriodsLoaded] = useState(false);
  const [periodId, setPeriodId] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");

  useEffect(() => {
    fetch("/api/books/periods")
      .then(async (r) => {
        if (!r.ok) return;
        const list = await r.json();
        if (!Array.isArray(list)) return;
        setPeriods(list);
        if (!periodId && list.length) {
          const jun = list.find((p: BooksPeriod) => /Jun\s*2026/i.test(p.label));
          const open = list.find((p: BooksPeriod) => p.status === "OPEN" || p.status === "REOPENED");
          setPeriodId(jun?.id || open?.id || list[0].id);
        }
      })
      .catch(() => undefined)
      .finally(() => setPeriodsLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(
    () => ({ periods, periodsLoaded, periodId, setPeriodId, globalSearch, setGlobalSearch }),
    [periods, periodsLoaded, periodId, globalSearch],
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
      globalSearch: "",
      setGlobalSearch: () => undefined,
    };
  }
  return ctx;
}
