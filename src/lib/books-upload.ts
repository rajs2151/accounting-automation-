/** Shared books upload limits — one list for Inbox / Purchases / Sales / Banking. */

import { BooksError } from "@/server/books/errors";

export const BOOKS_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Extensions accepted on books document / statement uploads. */
export const BOOKS_UPLOAD_EXTENSIONS = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".heic",
  ".csv",
  ".xlsx",
  ".xls",
] as const;

export const BOOKS_UPLOAD_ACCEPT = BOOKS_UPLOAD_EXTENSIONS.join(",");

export function booksUploadExtension(filename: string): string {
  const base = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  return base.toLowerCase();
}

export function assertBooksUploadAllowed(filename: string, byteSize: number): void {
  if (byteSize > BOOKS_UPLOAD_MAX_BYTES) {
    throw new BooksError("too_large", "invalid");
  }
  const ext = booksUploadExtension(filename);
  if (!(BOOKS_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new BooksError(`unsupported_type:${ext || "unknown"}`, "invalid");
  }
}
