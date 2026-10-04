"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PRODUCT_NAME } from "@/config/product";

const DEMO_USER = "55555555-5555-4555-8555-555555555555";
const DEMO_CLIENT = "e1000001-0000-4000-8000-000000000001";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/books";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: DEMO_USER, clientId: DEMO_CLIENT }),
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
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" defaultValue="omar@arnibooks.test" readOnly />
      </div>
      <Button className="w-full" disabled={busy} onClick={() => void signIn()} data-testid="login-submit">
        {busy ? "Signing in…" : "Continue as Omar"}
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
