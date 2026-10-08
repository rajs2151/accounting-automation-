# Test your own documents (owner how-to)

Use this when you want to check that upload → review → post → reports works on **your** files. Keep real client PDFs only under the gitignored `/real-docs/` folder. Never commit real names, TRNs, or IBANs.

## 1. Ready

1. Pull `feat/books-phase1`.
2. Start the stack: `docker compose up --build` (or your usual `scripts/dev-local.ps1`).
3. Confirm migrations are applied on the DB the web app uses (especially `db/35+` so **Transactions** works). Prefer replaying `db/*.sql` in order into the running Postgres. Only use `docker compose down -v` if you accept wiping local data.
4. Put sample files in `/real-docs/` (gitignored). Optional: label copies under `/real-docs/labels/` using the templates in `fixtures/extraction/`.

## 2. Upload

1. Open Inbox, Sales, Purchases, Statements, or Banking.
2. Use the **Upload** dialog (drag/browse). Watch the **Uploads** tab: Queued → Extracting → Needs review / Failed.
3. Open a **Needs review** row to enter the split review screen.

## 3. Review → confirm → approve

1. Working as **Omar** (preparer): check fields, party, VAT codes, totals. Fix anything wrong; missing stays empty (do not invent 0.00).
2. **Confirm** creates a draft document (does not post).
3. Switch **Working as** to **Layla** (approver — different person).
4. **Approve & next** posts the journal under dual control. Omar cannot approve his own draft.

## 4. Trace

On inbox review or the document page, open the **Trace** tab.

You should see steps in order: Uploaded file → Extraction → Inbox → Document → Journal → Open item → Settlement(s) → Report effect.

- Green tick = done; muted circle = not yet; red cross = failed.
- Journal lines show account codes with Dr/Cr in fils (UI shows AED).
- Tie-outs at the bottom: journal balanced, open item vs control, VAT presence.

CLI (read-only, local DB):

```bash
npm run trace -- INV-…          # document number
npm run trace -- <inbox-uuid>
npm run trace -- <bank-txn-uuid>
```

## 5. Results to check

| What | Where | Correct looks like |
|------|--------|--------------------|
| Trial balance | Reports → TB | Total Dr = total Cr |
| P&L / Balance sheet | Reports | Revenue/expense and AR/AP move with the posted docs |
| VAT 201 | Reports → VAT | Boxes match posted VAT lines for the period |
| Ageing | Reports → AR/AP ageing | Open AED matches control (1210 / 2110) |
| Dashboard | Home | AR/AP tiles and issues badge; no control mismatch |
| Company health | Health | Cash ≈ bank GL |
| Bank statement | Statements → Materialize → Transactions | Matched lines; recon difference 0 when books agree |

## 6. If something is wrong

1. Note **document type** and **layout_tag** only (never invoice text, party names, TRNs).
2. Open **Trace** (or `npm run trace -- …`) and write down the **first broken step**.
3. For extraction issues only: `npm run lab:extract-one -- --file real-docs/your.pdf` → output under `/lab-out/` (gitignored).
4. Share the step name + layout_tag with the team — not the file contents.

## One-page checklist

| Step | Where | Done when |
|------|--------|-----------|
| Stack up + migrations | Compose / psql | Transactions page loads without migration error |
| Upload | Upload dialog | Row appears in Uploads |
| Extract | Uploads status | Needs review (or Failed with a clear error) |
| Review | Inbox split view | Fields + flags readable; PDF highlights work |
| Confirm | Omar | Draft document exists |
| Approve | Layla | Journal entry number shown; status posted |
| Trace | Trace tab / CLI | Uploaded → Journal ticks green; amounts match |
| Reports | TB / P&L / BS / VAT / ageing | Numbers move; TB balances |
| Bank (if used) | Materialize + Transactions | Lines categorised; recon 0 when matched |
