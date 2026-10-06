"use client";

import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useBooksShell } from "@/components/books/books-shell-context";
import { VatSettingsSection } from "@/components/books/vat-settings-section";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateUae } from "@/lib/date";
import { displayToMinor, formatMinor } from "@/lib/money";
import { statementLineLabel } from "@/lib/statement-line";

type Profile = {
  id: string;
  name: string;
  trn: string | null;
  defaultCurrency: string;
  fiscalYearStartMonth?: number;
  booksStartPeriodId?: string | null;
};
type Period = { id: string; label: string; periodStart: string; periodEnd: string; status: string };
type UserRow = { id: string; name: string; email: string; role: string };
type CoaNode = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  isPostable: boolean;
  normalBalance: string | null;
  statementLine: string | null;
  defaultVatCode: string | null;
  balanceMinor: number;
  active: boolean;
  children: CoaNode[];
};

function flattenCoa(nodes: CoaNode[], depth = 0, out: Array<CoaNode & { depth: number }> = []) {
  for (const n of nodes) {
    out.push({ ...n, depth });
    if (n.children?.length) flattenCoa(n.children, depth + 1, out);
  }
  return out;
}

function CoaSection({ periodId }: { periodId: string }) {
  const [tree, setTree] = useState<CoaNode[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [editNode, setEditNode] = useState<CoaNode | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addParent, setAddParent] = useState<CoaNode | null>(null);
  const [form, setForm] = useState({
    code: "",
    name: "",
    accountType: "expense",
    normalBalance: "debit",
    statementLine: "",
    defaultVatCode: "",
  });

  const reload = useCallback(async () => {
    const qs = periodId ? `?periodId=${periodId}` : "";
    const t = await fetch(`/api/books/coa${qs}`).then((r) => r.json());
    if (Array.isArray(t)) setTree(t);
  }, [periodId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const flat = useMemo(() => flattenCoa(tree), [tree]);
  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return flat;
    const codes = new Set(flat.filter((n) => `${n.code} ${n.name}`.toLowerCase().includes(q)).map((n) => n.id));
    return flat.filter((n) => codes.has(n.id));
  }, [flat, q]);

  function toggle(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function isHiddenByCollapse(node: CoaNode & { depth: number }) {
    let parent = flat.find((x) => x.children?.some((c) => c.id === node.id));
    while (parent) {
      if (collapsed[parent.id]) return true;
      parent = flat.find((x) => x.children?.some((c) => c.id === parent!.id));
    }
    return false;
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">Chart of accounts</h2>
          <p className="text-sm text-muted-foreground">UAE SME template (COA v2). Headers are non-postable.</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAddParent(null);
            setForm({
              code: "",
              name: "",
              accountType: "expense",
              normalBalance: "debit",
              statementLine: "",
              defaultVatCode: "",
            });
            setAddOpen(true);
          }}
        >
          <Plus className="size-4" />
          Add root account
        </Button>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9 h-9" placeholder="Search code or name…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="overflow-auto max-h-[480px] rounded-md border border-border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="sticky top-0 bg-muted/95 text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left">Code</th>
              <th className="px-2 py-2 text-left">Name</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Normal</th>
              <th className="px-2 py-2">Statement</th>
              <th className="px-2 py-2">VAT</th>
              <th className="px-2 py-2 text-right">Balance</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.map((node) => {
              if (!q && isHiddenByCollapse(node)) return null;
              const hasChildren = node.children.length > 0;
              return (
                <tr key={node.id} className={!node.active ? "opacity-50" : undefined}>
                  <td className="px-2 py-1.5 font-mono text-xs">
                    <div className="flex items-center gap-1" style={{ paddingLeft: node.depth * 12 }}>
                      {hasChildren ? (
                        <button type="button" onClick={() => toggle(node.id)} aria-label="Expand">
                          {collapsed[node.id] ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                        </button>
                      ) : (
                        <span className="w-4" />
                      )}
                      {node.code}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">{node.name}</td>
                  <td className="px-2 py-1.5 capitalize text-xs">{node.accountType}</td>
                  <td className="px-2 py-1.5 text-xs capitalize">{node.normalBalance || "—"}</td>
                  <td className="px-2 py-1.5 text-xs" title={node.statementLine || undefined}>
                    {statementLineLabel(node.statementLine)}
                  </td>
                  <td className="px-2 py-1.5 text-xs">{node.defaultVatCode || "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-xs">
                    {formatMinor(Math.abs(node.balanceMinor))}
                    {!node.isPostable ? (
                      <span className="ml-1 text-[10px] text-muted-foreground">(rollup)</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-xs">{node.active ? "Active" : "Inactive"}</td>
                  <td className="px-2 py-1.5 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button size="sm" variant="ghost" className="h-7 w-7 px-0" aria-label="Row actions" />}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setAddParent(node);
                            setForm({
                              code: "",
                              name: "",
                              accountType: node.accountType,
                              normalBalance: node.normalBalance || "debit",
                              statementLine: node.statementLine || "",
                              defaultVatCode: "",
                            });
                            setAddOpen(true);
                          }}
                        >
                          Add child
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditNode(node)}>Edit</DropdownMenuItem>
                        {node.active ? (
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={async () => {
                              const res = await fetch(`/api/books/accounts/${node.id}/deactivate`, {
                                method: "POST",
                                body: "{}",
                              });
                              if (!res.ok) {
                                const err = await res.json().catch(() => ({}));
                                toast.error(err.error || "Cannot deactivate");
                                return;
                              }
                              toast.success("Account deactivated");
                              void reload();
                            }}
                          >
                            Deactivate
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={Boolean(editNode)} onOpenChange={(o) => !o && setEditNode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editNode?.code}</DialogTitle>
          </DialogHeader>
          {editNode ? (
            <div className="space-y-3">
              <div>
                <Label>Name</Label>
                <Input
                  defaultValue={editNode.name}
                  id="edit-name"
                  onChange={(e) => setEditNode({ ...editNode, name: e.target.value })}
                />
              </div>
              <div>
                <Label>Statement line</Label>
                <Input
                  defaultValue={editNode.statementLine || ""}
                  onChange={(e) => setEditNode({ ...editNode, statementLine: e.target.value })}
                />
              </div>
              <div>
                <Label>Default VAT</Label>
                <Input
                  defaultValue={editNode.defaultVatCode || ""}
                  onChange={(e) => setEditNode({ ...editNode, defaultVatCode: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              onClick={async () => {
                if (!editNode) return;
                await fetch(`/api/books/accounts/${editNode.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: editNode.name,
                    statementLine: editNode.statementLine,
                    defaultVatCode: editNode.defaultVatCode || null,
                  }),
                });
                setEditNode(null);
                void reload();
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) setAddParent(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{addParent ? `Add child under ${addParent.code}` : "Add root account"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Code</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </div>
            <div>
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label>Type</Label>
              <select
                className="h-9 w-full rounded-md border border-border px-2 text-sm"
                value={form.accountType}
                onChange={(e) => setForm({ ...form, accountType: e.target.value })}
              >
                {["asset", "liability", "equity", "income", "expense"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Normal balance</Label>
              <select
                className="h-9 w-full rounded-md border border-border px-2 text-sm"
                value={form.normalBalance}
                onChange={(e) => setForm({ ...form, normalBalance: e.target.value })}
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={async () => {
                await fetch("/api/books/accounts", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    ...form,
                    parentId: addParent?.id ?? null,
                    isPostable: true,
                  }),
                });
                setAddOpen(false);
                setAddParent(null);
                void reload();
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

type VoucherSeq = { voucherType: string; year: number; prefix: string; lastN: number };

type ObRow = { code: string; debitAed: string; creditAed: string; partyId: string };
type PartyOpt = { id: string; name: string; partyType: string };

function OpeningBalancesSection({ periods }: { periods: Period[] }) {
  const [rows, setRows] = useState<ObRow[]>([
    { code: "1120", debitAed: "1000.00", creditAed: "", partyId: "" },
    { code: "3900", debitAed: "", creditAed: "1000.00", partyId: "" },
  ]);
  const [parties, setParties] = useState<PartyOpt[]>([]);
  const [partyItems, setPartyItems] = useState<
    Array<{ partyId: string; side: "AR" | "AP"; amountAed: string }>
  >([]);
  const [unlockReason, setUnlockReason] = useState("Opening balance import");
  const [message, setMessage] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/books/parties")
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list)) setParties(list);
      });
  }, []);

  const apr = periods.find((p) => /Apr\s*2026/i.test(p.label));

  async function onFile(file: File | null) {
    if (!file) return;
    const text = await file.text();
    const next: ObRow[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^code/i.test(line) || /^account/i.test(line)) continue;
      const [code, debit = "", credit = ""] = line.split(",").map((p) => p.trim());
      if (!code) continue;
      // Accept AED decimals or raw fils integers (≥1000 without decimal → treat as fils/100 display)
      const d = debit.includes(".") || !debit ? debit || "" : (Number(debit) / 100).toFixed(2);
      const c = credit.includes(".") || !credit ? credit || "" : (Number(credit) / 100).toFixed(2);
      next.push({
        code,
        debitAed: d && Number(d) ? Number(d).toFixed(2) : debit.includes(".") ? debit : d,
        creditAed: c && Number(c) ? Number(c).toFixed(2) : credit.includes(".") ? credit : c,
        partyId: "",
      });
    }
    if (next.length) setRows(next);
  }

  async function unlockStartPeriod() {
    if (!apr) {
      setMessage("Apr 2026 period not found");
      return;
    }
    const res = await fetch(`/api/books/periods/${apr.id}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: unlockReason || "Opening balance import" }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || "unlock_failed");
      return;
    }
    setMessage(`Unlocked ${apr.label} — reason audited. Map TB, then relock after post.`);
  }

  async function mapImport() {
    setMessage("");
    const lines = [];
    for (const r of rows) {
      let debitMinor = 0;
      let creditMinor = 0;
      try {
        debitMinor = r.debitAed ? displayToMinor(r.debitAed) ?? 0 : 0;
        creditMinor = r.creditAed ? displayToMinor(r.creditAed) ?? 0 : 0;
      } catch {
        setMessage(`Invalid amount on ${r.code}`);
        return;
      }
      if (!debitMinor && !creditMinor) continue;
      lines.push({
        accountCode: r.code,
        debitMinor,
        creditMinor,
        partyId: r.partyId || null,
      });
    }
    const partyOpenItems = [];
    for (const p of partyItems) {
      if (!p.partyId) continue;
      try {
        partyOpenItems.push({
          partyId: p.partyId,
          side: p.side,
          amountMinor: displayToMinor(p.amountAed) ?? 0,
        });
      } catch {
        setMessage("Invalid AR/AP amount");
        return;
      }
    }
    const res = await fetch("/api/books/opening-imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines, partyOpenItems }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || "import_failed");
      return;
    }
    setDraftId(String(data.id || data.importId || data.documentId || ""));
    setMessage(
      `Mapped OB as-of ${data.asOfDate} → ${data.periodLabel}. Switch to approver and post, then relock.`,
    );
  }

  async function postImport() {
    if (!draftId) {
      setMessage("Map a TB first");
      return;
    }
    const res = await fetch(`/api/books/opening-imports/${draftId}/post`, {
      method: "POST",
      body: "{}",
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error || "post_failed");
      return;
    }
    setMessage(`Posted ${data.entryNo || "opening"}. Relock the start period when done.`);
  }

  async function relockStart() {
    if (!apr) return;
    const res = await fetch(`/api/books/periods/${apr.id}/lock`, { method: "POST", body: "{}" });
    if (!res.ok) {
      const data = await res.json();
      setMessage(data.error || "lock_failed");
      return;
    }
    setMessage(`Relocked ${apr.label} (audited).`);
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="opening-balances">
      <h2 className="text-lg font-medium">Opening balances</h2>
      <p className="text-sm text-muted-foreground">
        Unlock the books-start period (reason required) → import TB (CSV/XLSX) → post as approver →
        relock. All steps are audited. Amounts in AED.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <Label>Unlock reason</Label>
          <Input
            className="mt-1"
            value={unlockReason}
            onChange={(e) => setUnlockReason(e.target.value)}
            data-testid="ob-unlock-reason"
          />
        </div>
        <Button variant="outline" onClick={() => void unlockStartPeriod()} data-testid="ob-unlock">
          Unlock start period
        </Button>
        <Button variant="outline" onClick={() => void relockStart()} data-testid="ob-relock">
          Relock
        </Button>
      </div>
      <div>
        <Label>Upload TB (CSV / XLSX text)</Label>
        <Input
          className="mt-1"
          type="file"
          accept=".csv,.xlsx,.txt"
          data-testid="ob-file"
          onChange={(e) => void onFile(e.target.files?.[0] || null)}
        />
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm" data-testid="ob-mapping-table">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-2">Account</th>
              <th className="px-2 py-2">Debit (AED)</th>
              <th className="px-2 py-2">Credit (AED)</th>
              <th className="px-2 py-2">Party (AR/AP)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.code}-${i}`} className="border-t border-border">
                <td className="px-2 py-1">
                  <Input
                    className="h-8 font-mono"
                    value={r.code}
                    onChange={(e) => {
                      const next = [...rows];
                      next[i] = { ...r, code: e.target.value };
                      setRows(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1">
                  <Input
                    className="h-8"
                    value={r.debitAed}
                    onChange={(e) => {
                      const next = [...rows];
                      next[i] = { ...r, debitAed: e.target.value };
                      setRows(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1">
                  <Input
                    className="h-8"
                    value={r.creditAed}
                    onChange={(e) => {
                      const next = [...rows];
                      next[i] = { ...r, creditAed: e.target.value };
                      setRows(next);
                    }}
                  />
                </td>
                <td className="px-2 py-1">
                  <select
                    className="h-8 w-full rounded-md border border-input bg-background px-1 text-xs"
                    value={r.partyId}
                    onChange={(e) => {
                      const next = [...rows];
                      next[i] = { ...r, partyId: e.target.value };
                      setRows(next);
                    }}
                  >
                    <option value="">—</option>
                    {parties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>AR / AP party detail</Label>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setPartyItems((prev) => [...prev, { partyId: "", side: "AR", amountAed: "0.00" }])
            }
          >
            Add party open item
          </Button>
        </div>
        {partyItems.map((p, i) => (
          <div key={i} className="grid gap-2 md:grid-cols-3">
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={p.partyId}
              onChange={(e) => {
                const next = [...partyItems];
                next[i] = { ...p, partyId: e.target.value };
                setPartyItems(next);
              }}
            >
              <option value="">Party…</option>
              {parties.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={p.side}
              onChange={(e) => {
                const next = [...partyItems];
                next[i] = { ...p, side: e.target.value as "AR" | "AP" };
                setPartyItems(next);
              }}
            >
              <option value="AR">AR</option>
              <option value="AP">AP</option>
            </select>
            <Input
              value={p.amountAed}
              onChange={(e) => {
                const next = [...partyItems];
                next[i] = { ...p, amountAed: e.target.value };
                setPartyItems(next);
              }}
              placeholder="Amount AED"
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void mapImport()} data-testid="ob-map">
          Map opening TB
        </Button>
        <Button variant="outline" onClick={() => void postImport()} data-testid="ob-post">
          Post opening (approver)
        </Button>
      </div>
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
    </section>
  );
}

export default function BooksSettingsPage() {
  const { periodId } = useBooksShell();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [sequences, setSequences] = useState<VoucherSeq[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("accountant");
  const [name, setName] = useState("");
  const [trn, setTrn] = useState("");
  const [fyMonth, setFyMonth] = useState(1);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [buildSha, setBuildSha] = useState("");

  async function reload() {
    // Load independently so one failing endpoint does not blank the whole page.
    const errors: string[] = [];
    try {
      const p = await fetch("/api/books/company").then((r) => r.json());
      if (p?.id) {
        setProfile(p);
        setName(p.name || "");
        setTrn(p.trn || "");
        setFyMonth(Number(p.fiscalYearStartMonth || 1));
      } else if (p?.error) errors.push(`company:${p.error}`);
    } catch {
      errors.push("company");
    }
    try {
      const per = await fetch("/api/books/periods").then((r) => r.json());
      if (Array.isArray(per)) setPeriods(per);
      else if (per?.error) errors.push(`periods:${per.error}`);
    } catch {
      errors.push("periods");
    }
    try {
      const u = await fetch("/api/books/users").then((r) => r.json());
      if (Array.isArray(u)) setUsers(u);
    } catch {
      errors.push("users");
    }
    try {
      const seq = await fetch("/api/books/voucher-sequences").then((r) => r.json());
      if (Array.isArray(seq)) setSequences(seq);
    } catch {
      errors.push("sequences");
    }
    if (errors.length) setError(`Partial load: ${errors.join(", ")}`);
    else setError("");
  }

  useEffect(() => {
    void reload();
    setBuildSha(
      process.env.NEXT_PUBLIC_BUILD_SHA ||
        process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
        "local-dev",
    );
  }, []);

  async function saveProfile() {
    setError("");
    setSaved("");
    const res = await fetch("/api/books/company", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, trn: trn || null, fiscalYearStartMonth: fyMonth }),
    });
    if (!res.ok) {
      setError("Profile save failed.");
      return;
    }
    setSaved("Company profile saved.");
    await reload();
  }

  async function lockPeriod(id: string) {
    await fetch(`/api/books/periods/${id}/lock`, { method: "POST", body: "{}" });
    await reload();
  }

  async function unlockPeriod(id: string) {
    await fetch(`/api/books/periods/${id}/reopen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Settings unlock" }),
    });
    await reload();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Company profile, chart of accounts, periods, and users.</p>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {saved ? <p className="text-sm text-status-ok">{saved}</p> : null}

      <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="company-profile">
        <h2 className="text-lg font-medium">Company profile</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="co-name">Legal name</Label>
            <Input
              id="co-name"
              data-testid="company-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="co-trn">TRN</Label>
            <Input
              id="co-trn"
              data-testid="company-trn"
              value={trn}
              onChange={(e) => setTrn(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Default currency</Label>
            <Input value={profile?.defaultCurrency || "AED"} disabled />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fy-start">Fiscal year start month</Label>
            <Input
              id="fy-start"
              data-testid="fiscal-year-start-month"
              type="number"
              min={1}
              max={12}
              value={fyMonth}
              onChange={(e) => setFyMonth(Number(e.target.value) || 1)}
            />
            <p className="text-xs text-muted-foreground">
              Separate from books-start period. Voucher number series use this fiscal year.
            </p>
          </div>
        </div>
        <Button onClick={saveProfile}>Save profile</Button>
      </section>

      <VatSettingsSection />

      <CoaSection periodId={periodId} />

      <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="periods-table">
        <h2 className="text-lg font-medium">Periods</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">Label</th>
              <th>Range</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {periods.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted-foreground">
                  No periods loaded
                </td>
              </tr>
            ) : (
              periods.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-2 font-medium">{p.label}</td>
                  <td>
                    {formatDateUae(p.periodStart)} → {formatDateUae(p.periodEnd)}
                  </td>
                  <td>{p.status}</td>
                  <td className="space-x-2 text-right">
                    {p.status === "LOCKED" ? (
                      <Button size="sm" variant="outline" onClick={() => unlockPeriod(p.id)}>
                        Unlock
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => lockPeriod(p.id)}>
                        Lock
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <OpeningBalancesSection periods={periods} />

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-medium">Users & roles</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">Name</th>
              <th>Email</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="py-2">{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select
                    className="h-8 rounded-md border border-border px-2 text-sm capitalize"
                    value={u.role}
                    data-testid={`user-role-${u.id}`}
                    onChange={async (e) => {
                      await fetch(`/api/books/users/${u.id}/role`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ role: e.target.value }),
                      });
                      await reload();
                    }}
                  >
                    <option value="admin">admin</option>
                    <option value="accountant">accountant</option>
                    <option value="approver">approver</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div>
            <Label>Invite email</Label>
            <Input
              className="mt-1"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="name@arnibooks.test"
              data-testid="invite-email"
            />
          </div>
          <div>
            <Label>Role</Label>
            <select
              className="mt-1 h-9 rounded-md border border-border px-2 text-sm"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
            >
              <option value="accountant">accountant</option>
              <option value="approver">approver</option>
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <Button
            size="sm"
            onClick={async () => {
              const res = await fetch("/api/books/invites", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
              });
              const data = await res.json();
              if (!res.ok) {
                setError(data.error || "invite_failed");
                return;
              }
              setSaved(`Invite stub created for ${inviteEmail} (delivery in a later phase).`);
              setInviteEmail("");
            }}
          >
            Invite
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-medium">Numbering</h2>
        <p className="text-sm text-muted-foreground">
          Voucher number series for the current calendar year (prefix + last used sequence).
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">Voucher type</th>
              <th>Prefix</th>
              <th>Last N</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sequences.map((s) => (
              <tr key={s.voucherType} className="border-t border-border">
                <td className="py-2">{s.voucherType}</td>
                <td>
                  <Input
                    className="h-8 w-24"
                    defaultValue={s.prefix}
                    id={`prefix-${s.voucherType}`}
                  />
                </td>
                <td>
                  <Input
                    className="h-8 w-24"
                    type="number"
                    defaultValue={s.lastN}
                    id={`lastn-${s.voucherType}`}
                  />
                </td>
                <td className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const prefix = (
                        document.getElementById(`prefix-${s.voucherType}`) as HTMLInputElement
                      )?.value;
                      const lastN = Number(
                        (document.getElementById(`lastn-${s.voucherType}`) as HTMLInputElement)
                          ?.value,
                      );
                      await fetch("/api/books/voucher-sequences", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          voucherType: s.voucherType,
                          prefix,
                          lastN,
                        }),
                      });
                      await reload();
                    }}
                  >
                    Save
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">
          Sequences are scoped to the company fiscal year (start month above), not books-start period.
        </p>
      </section>

      <section className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid="about">
        <h2 className="text-lg font-medium">About</h2>
        <p className="text-sm text-muted-foreground">
          arnibooks · build <span data-testid="build-sha">{buildSha || "local-dev"}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          Portal security gate remains FAIL until PASS — synthetic companies only.
        </p>
      </section>
    </div>
  );
}
