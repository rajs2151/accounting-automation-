import { toast } from "sonner";

import { apiErrorMessage } from "@/lib/api-error";

type UploadResult = {
  inboxItemId: string;
  duplicate: boolean;
  filename?: string;
};

/** One place for upload toasts: new files are "extracting", identical re-uploads link to the existing item. */
export function showUploadFeedback(ok: boolean, data: unknown): number {
  if (!ok) {
    toast.error(apiErrorMessage(data, "The upload did not complete. Please try again."));
    return 0;
  }
  const results = ((data as { results?: UploadResult[] })?.results ?? []) as UploadResult[];
  const fresh = results.filter((r) => !r.duplicate).length;
  if (fresh) toast.success(`Uploaded ${fresh} file${fresh === 1 ? "" : "s"} - extracting`);
  for (const dup of results.filter((r) => r.duplicate)) {
    toast.message(`${dup.filename || "This file"} was already uploaded`, {
      description: "Nothing new was stored. Open the existing item instead.",
      action: {
        label: "Open existing",
        onClick: () => {
          window.location.href = `/books/inbox/${dup.inboxItemId}`;
        },
      },
    });
  }
  return fresh;
}
