import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { isDevUiEnabled } from "@/lib/dev-ui";

export default function DevUiLayout({ children }: { children: ReactNode }) {
  if (!isDevUiEnabled()) notFound();
  return children;
}
