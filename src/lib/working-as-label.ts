/** Label for the Working-as impersonation select — never a bare UUID when a name exists. */

import { isDevUiEnabled } from "@/lib/dev-ui";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function workingAsLabel(
  user: { id: string; name: string; role: string } | null | undefined,
  opts?: { collapsed?: boolean },
): string {
  if (!user) return "";
  const name = String(user.name || "").trim();
  if (!name || UUID_RE.test(name)) {
    return opts?.collapsed ? user.id.slice(0, 8) : `${user.id.slice(0, 8)} · ${user.role}`;
  }
  return opts?.collapsed ? name : `${name} · ${user.role}`;
}

/** Impersonation control: admin always; otherwise only when Dev UI is enabled (development). */
export function canShowWorkingAs(
  role: string | undefined,
  env: string | undefined = process.env.NODE_ENV,
): boolean {
  if (String(role || "").toLowerCase() === "admin") return true;
  return isDevUiEnabled(env);
}
