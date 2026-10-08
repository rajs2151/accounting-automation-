"use client";

import { useEffect, useState } from "react";
import { ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Security = {
  portalSecurityStatus: "FAIL" | "PASS";
  requireDownloadMfa: boolean;
  note: string;
};

const DISMISS_KEY = "arnibooks.securityBanner.dismissed";

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, "1");
  } catch {
    /* storage unavailable — banner stays dismissible for this session only */
  }
}

/** Slim dismissible chip for the top bar — not full-width page content. */
export function SecurityBannerChip() {
  const [security, setSecurity] = useState<Security | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
    fetch("/api/security-status")
      .then((r) => r.json())
      .then(setSecurity)
      .catch(() => setSecurity(null));
  }, []);

  if (!security || dismissed) return null;

  const isPass = security.portalSecurityStatus === "PASS";
  return (
    <div
      className={
        isPass
          ? "inline-flex max-w-md items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-900"
          : "inline-flex max-w-md items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-900"
      }
      data-testid="security-banner-chip"
    >
      <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {isPass
          ? `Real clients allowed · ${security.portalSecurityStatus}`
          : `Synthetic data only · ${security.portalSecurityStatus}`}
      </span>
      <button
        type="button"
        className="rounded-full p-0.5 hover:bg-amber-100"
        aria-label="Dismiss security notice"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Shown only when initiating a pack download (step-up MFA demo). */
export function MfaDownloadModal({
  open,
  onOpenChange,
  onVerified,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified?: () => void;
}) {
  const [code, setCode] = useState("000000");
  const [mfaMsg, setMfaMsg] = useState("");

  async function verifyMfa() {
    setMfaMsg("");
    const response = await fetch("/api/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      setMfaMsg("MFA code rejected.");
      return;
    }
    setMfaMsg("");
    onVerified?.();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="mfa-download-modal">
        <DialogHeader>
          <DialogTitle>Verify before download</DialogTitle>
          <DialogDescription>
            Enter the demo MFA code to download reports and release packs. This prompt appears only for downloads, not on every page.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            className="h-9 w-32 tabular-nums"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="MFA demo code"
          />
          <Button size="sm" onClick={() => void verifyMfa()}>
            Verify
          </Button>
        </div>
        {mfaMsg ? <p className="text-sm text-destructive">{mfaMsg}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

/** @deprecated Use SecurityBannerChip in the top bar. Kept for legacy imports. */
export function SecurityBanner() {
  return <SecurityBannerChip />;
}
