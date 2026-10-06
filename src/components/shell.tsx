"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  BookOpen,
  ChartColumn,
  FileText,
  HandCoins,
  Inbox,
  Landmark,
  Languages,
  LayoutDashboard,
  PanelLeft,
  Receipt,
  Search,
  Settings,
  Upload,
  Users,
  Wallet,
} from "lucide-react";

import { BooksShellProvider, useBooksShell } from "@/components/books/books-shell-context";
import { CompanySwitcher } from "@/components/books/company-switcher";
import { BooksIssuesBadge } from "@/components/books/issues-badge";
import { SecurityBannerChip } from "@/components/security-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { BOOKS_CLIENT_ID_SET, PRODUCT_NAME } from "@/config/product";
import { cn } from "@/lib/utils";

type Directory = {
  me: { id: string; name: string; email: string; role: string } | null;
  users: { id: string; name: string; role: string }[];
  clients: { id: string; name: string }[];
  clientId: string;
};

type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Other routes that belong to this item (highlight it there too). */
  also?: string[];
  soon?: boolean;
};

/**
 * Books menu in the order work flows: documents come in → sales / purchases / expenses → money in and
 * out → bank → the books themselves. Bank rules and statements live inside Bank transactions / Bank
 * accounts; the placeholder Company Health page is not listed.
 */
const NAV_GROUPS: Array<{ label?: string; items: NavItem[] }> = [
  {
    items: [
      { href: "/books", label: "Dashboard", icon: LayoutDashboard },
      { href: "/books/inbox", label: "Inbox", icon: Inbox },
    ],
  },
  {
    label: "Sales & purchases",
    items: [
      { href: "/books/sales", label: "Sales", icon: FileText },
      { href: "/books/purchases", label: "Purchases", icon: Receipt },
      { href: "/books/expenses", label: "Expenses", icon: Wallet },
      { href: "/books/receipts", label: "Receipts & payments", icon: HandCoins },
      { href: "/books/parties", label: "Customers & suppliers", icon: Users },
    ],
  },
  {
    label: "Bank",
    items: [
      { href: "/books/banking", label: "Bank accounts", icon: Landmark, also: ["/books/statements"] },
      { href: "/books/transactions", label: "Bank transactions", icon: ArrowLeftRight, also: ["/books/rules"] },
    ],
  },
  {
    label: "Accounting",
    items: [
      { href: "/books/journals", label: "Journals", icon: BookOpen },
      { href: "/books/reports/trial-balance", label: "Reports", icon: ChartColumn, also: ["/books/reports"] },
    ],
  },
  { items: [{ href: "/books/settings", label: "Settings", icon: Settings }] },
];

function periodDotClass(status: string) {
  const open = status === "OPEN" || status === "REOPENED";
  return open ? "bg-emerald-500" : "bg-muted-foreground/45";
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { periods, periodId, setPeriodId, globalSearch, setGlobalSearch } = useBooksShell();
  const searchRef = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [language, setLanguage] = useState<"EN" | "AR">("EN");

  const isLogin = pathname === "/login";
  const isBooks = pathname.startsWith("/books");

  const booksClients = useMemo(() => {
    const all = directory?.clients || [];
    return all.filter((c) => BOOKS_CLIENT_ID_SET.has(c.id));
  }, [directory?.clients]);

  const switcherClients = isBooks ? booksClients : directory?.clients || [];

  useEffect(() => {
    if (isLogin) {
      setSessionReady(true);
      return;
    }
    setSessionReady(false);
    fetch("/api/session")
      .then(async (response) => {
        if (!response.ok) {
          setDirectory(null);
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setDirectory(await response.json());
      })
      .catch(() => {
        setDirectory(null);
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      })
      .finally(() => setSessionReady(true));
  }, [pathname, router, isLogin]);

  useEffect(() => {
    if (isLogin || !isBooks || !directory?.me || booksClients.length === 0) return;
    if (BOOKS_CLIENT_ID_SET.has(directory.clientId)) return;
    const fallback = booksClients[0]!.id;
    void switchWorking(directory.me.id, fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBooks, directory?.clientId, directory?.me?.id, booksClients, isLogin]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function switchWorking(userId: string, clientId: string) {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, clientId }),
    });
    if (!response.ok) return;
    router.refresh();
    const next = await fetch("/api/session").then((item) => item.json());
    setDirectory(next);
  }

  const clientValue = switcherClients.some((c) => c.id === directory?.clientId)
    ? directory!.clientId
    : switcherClients[0]?.id || directory?.clientId || "";

  const isActive = (item: NavItem) =>
    item.href === "/books"
      ? pathname === "/books"
      : [item.href, ...(item.also || [])].some((h) => pathname === h || pathname.startsWith(`${h}/`));

  const nav = (
    <nav className="flex flex-col gap-0.5 px-2">
      {NAV_GROUPS.map((group, gi) => (
        <div key={group.label || `g${gi}`} className={cn("flex flex-col gap-0.5", gi > 0 && "mt-3")}>
          {group.label && !collapsed ? (
            <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {group.label}
            </div>
          ) : null}
          {group.items.map((item) => {
            const active = isActive(item);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                title={item.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary-subtle text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  collapsed && "justify-center px-2",
                )}
              >
                <Icon className="size-[18px] shrink-0" />
                {collapsed ? (
                  <span className="sr-only">{item.label}</span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.soon ? (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                        Soon
                      </Badge>
                    ) : null}
                  </>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const sidebarTop = (
    <div className={cn("space-y-2 px-3 pb-3", collapsed && "px-2")}>
      {directory?.me ? (
        <CompanySwitcher
          clients={switcherClients}
          value={clientValue}
          collapsed={collapsed}
          onSwitch={(id) => void switchWorking(directory.me!.id, id)}
        />
      ) : null}
      {!collapsed ? (
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start gap-2"
          data-testid="shell-global-upload"
          onClick={() => router.push("/books/inbox?upload=1")}
        >
          <Upload className="size-4" />
          Upload
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="mx-auto flex"
          title="Upload"
          data-testid="shell-global-upload"
          onClick={() => router.push("/books/inbox?upload=1")}
        >
          <Upload className="size-4" />
        </Button>
      )}
    </div>
  );

  const firstName = directory?.me?.name?.split(/\s+/)[0];
  const currentPeriod = periods.find((p) => p.id === periodId);

  if (isLogin) {
    return <>{children}</>;
  }

  if (!sessionReady || !directory?.me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading workspace…
      </div>
    );
  }

  if (isBooks && periods.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading company period…
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex",
            collapsed ? "w-[72px]" : "w-64",
          )}
        >
          <div className={cn("flex items-center gap-2 px-4 py-5", collapsed && "justify-center px-2")}>
            <Link
              href="/books"
              className="text-lg font-semibold tracking-tight text-primary"
              title={PRODUCT_NAME}
            >
              {collapsed ? "a" : PRODUCT_NAME}
            </Link>
            {!collapsed ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="ms-auto"
                onClick={() => setCollapsed(true)}
                aria-label="Collapse navigation"
              >
                <PanelLeft className="size-4" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setCollapsed(false)}
                aria-label="Expand navigation"
              >
                <PanelLeft className="size-4" />
              </Button>
            )}
          </div>
          {sidebarTop}
          <div className="flex-1 overflow-y-auto py-1">{nav}</div>
          <div className="mt-auto space-y-3 border-t border-sidebar-border p-3">
            <WorkingAsUser
              directory={directory}
              clientId={clientValue}
              collapsed={collapsed}
              onSwitch={switchWorking}
            />
            {!collapsed && directory?.me ? (
              <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2 py-2 text-xs">
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary-subtle font-medium text-primary">
                  {directory.me.name.slice(0, 1)}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{directory.me.name}</div>
                  <div className="truncate text-muted-foreground">{directory.me.role}</div>
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2 md:hidden">
            <Button variant="outline" size="icon-sm" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
              <PanelLeft />
            </Button>
            <span className="font-semibold text-primary">{PRODUCT_NAME}</span>
          </header>

          <header
            className="hidden shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-2.5 md:flex"
            data-testid="app-top-bar"
          >
            <p className="shrink-0 text-sm font-medium text-foreground">
              Hi <span className="font-semibold">{firstName}</span>
            </p>
            {isBooks && periods.length > 0 ? (
              <Select
                value={periodId}
                onValueChange={(v) => {
                  if (v) setPeriodId(v);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-8 shrink-0 gap-2"
                  data-testid="topbar-period"
                  aria-label="Period"
                >
                  {currentPeriod ? (
                    <span
                      className={cn("size-2 shrink-0 rounded-full", periodDotClass(currentPeriod.status))}
                      aria-hidden
                    />
                  ) : null}
                  <SelectValue placeholder="Period">
                    {currentPeriod
                      ? `${currentPeriod.label} (${currentPeriod.status})`
                      : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {periods.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className={cn("size-2 rounded-full", periodDotClass(p.status))}
                          aria-hidden
                        />
                        {p.label} ({p.status})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className="relative w-full max-w-[480px] flex-1">
              <Search className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                className="h-8 ps-8 pe-16 text-sm"
                placeholder="Search…"
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
                data-testid="topbar-search"
              />
              <kbd className="pointer-events-none absolute end-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
                Ctrl K
              </kbd>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" aria-label="Language">
                    <Languages className="size-4" />
                    <span className="text-xs">{language}</span>
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setLanguage("EN")}>English (EN)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLanguage("AR")}>Arabic (AR)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {isBooks ? <BooksIssuesBadge /> : null}
            <div className="ms-auto shrink-0">
              <SecurityBannerChip />
            </div>
          </header>

          <main
            key={`${directory?.me?.id || ""}:${directory?.clientId || ""}`}
            className={cn(
              "min-h-0 min-w-0 flex-1",
              pathname.match(/^\/books\/inbox\/[^/]+$/)
                ? "flex flex-col overflow-hidden p-0"
                : "overflow-y-auto px-4 py-5 md:px-6 lg:px-8",
            )}
          >
            {children}
          </main>
        </div>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72">
          <SheetHeader>
            <SheetTitle className="font-semibold text-primary">{PRODUCT_NAME}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            {sidebarTop}
            {nav}
          </div>
          <div className="mt-6">
            <WorkingAsUser
              directory={directory}
              clientId={clientValue}
              collapsed={false}
              onSwitch={switchWorking}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <BooksShellProvider>
      <ShellInner>{children}</ShellInner>
    </BooksShellProvider>
  );
}

function WorkingAsUser({
  directory,
  clientId,
  collapsed,
  onSwitch,
}: {
  directory: Directory | null;
  clientId: string;
  collapsed: boolean;
  onSwitch: (userId: string, clientId: string) => void;
}) {
  if (!directory?.me) return null;

  if (collapsed) {
    return (
      <Select
        value={directory.me.id}
        onValueChange={(uid) => {
          if (uid) onSwitch(uid, clientId);
        }}
      >
        <SelectTrigger size="sm" className="w-full" title="Working as" aria-label="Working as">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {directory.users.map((user) => (
            <SelectItem key={user.id} value={user.id}>
              {user.name.slice(0, 8)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <div className="space-y-1 text-sm">
      <span className="block text-xs font-medium text-muted-foreground">Working as</span>
      <Select
        value={directory.me.id}
        onValueChange={(uid) => {
          if (!uid) return;
          onSwitch(uid, clientId);
        }}
      >
        <SelectTrigger size="sm" className="w-full" data-testid="working-as-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {directory.users.map((user) => (
            <SelectItem key={user.id} value={user.id}>
              {user.name} · {user.role}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
