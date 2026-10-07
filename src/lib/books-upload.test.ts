import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOKS_UPLOAD_MAX_BYTES,
  assertBooksUploadAllowed,
} from "@/lib/books-upload";
import { BooksError } from "@/server/books/errors";

test("books upload rejects files over 25 MB", () => {
  assert.throws(
    () => assertBooksUploadAllowed("bill.pdf", BOOKS_UPLOAD_MAX_BYTES + 1),
    (e: unknown) => e instanceof BooksError && e.message === "too_large",
  );
});

test("books upload accepts 25 MB boundary and common extensions", () => {
  assert.doesNotThrow(() => assertBooksUploadAllowed("bill.pdf", BOOKS_UPLOAD_MAX_BYTES));
  assert.doesNotThrow(() => assertBooksUploadAllowed("scan.png", 100));
  assert.doesNotThrow(() => assertBooksUploadAllowed("bank.xlsx", 100));
  assert.throws(
    () => assertBooksUploadAllowed("note.docx", 100),
    (e: unknown) => e instanceof BooksError && String(e.message).startsWith("unsupported_type"),
  );
});
