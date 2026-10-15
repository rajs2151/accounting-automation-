import { TablePeekLayer } from "@/components/books/table-peek";

/** Books area: Notion-style table rows + side peek on every plain table (see table-peek.tsx). */
export default function BooksLayout({ children }: { children: React.ReactNode }) {
  return <TablePeekLayer>{children}</TablePeekLayer>;
}
