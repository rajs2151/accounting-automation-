"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PRODUCT_NAME } from "@/config/product";

const DEMO_CLIENT = "e1000001-0000-4000-8000-000000000001";

// Synthetic demo users (db/02-seed.sql, db/31-demo-owner-user.sql). Not real authentication.
const DEMO_USERS = [
  { id: "77777777-7777-4777-8777-777777777777", name: "Raj", email: "raj@arnibooks.test", role: "Owner (admin)" },
  { id: "55555555-5555-4555-8555-555555555555", name: "Omar", email: "omar@arnibooks.test", role: "Preparer" },
  { id: "44444444-4444-4444-8444-444444444444", name: "Layla", email: "layla@arnibooks.test", role: "Approver" },
] as const;

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/books";
  const [userId, setUserId] = useState<string>(DEMO_USERS[0].id);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = DEMO_USERS.find((u) => u.id === userId) ?? DEMO_USERS[0];

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, clientId: DEMO_CLIENT }),
      });
      if (!res.ok) {
        setError("Could not start session");
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError("Could not start session");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-sm space-y-6 rounded-xl border border-border bg-card p-8 shadow-sm">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">{PRODUCT_NAME}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to continue (synthetic demo session).</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="demo-user">Sign in as</Label>
        <select
          id="demo-user"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          data-testid="login-user"
        >
          {DEMO_USERS.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} · {user.role}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{selected.email}</p>
      </div>
      <Button className="w-full" disabled={busy} onClick={() => void signIn()} data-testid="login-submit">
        {busy ? "Signing in…" : `Continue as ${selected.name}`}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
