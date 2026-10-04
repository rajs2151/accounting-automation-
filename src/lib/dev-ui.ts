/** Dev-only UI gallery (`/dev/ui`) — never shown outside development builds. */
export function isDevUiEnabled(env: string | undefined = process.env.NODE_ENV): boolean {
  return env === "development";
}
