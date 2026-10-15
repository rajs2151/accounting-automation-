import assert from "node:assert/strict";
import test from "node:test";

import { describeReportBasis } from "@/lib/report-basis";

test("describeReportBasis: month vs range vs override", () => {
  assert.equal(
    describeReportBasis({ mode: "monthly", periodLabel: "May 2026" }),
    "Basis: Calendar month (May 2026)",
  );
  assert.equal(
    describeReportBasis({ mode: "range", from: "2026-04-01", to: "2026-06-30" }),
    "Basis: Custom range (2026-04-01 – 2026-06-30)",
  );
  assert.match(
    describeReportBasis({
      mode: "range",
      from: "2026-04-01",
      to: "2026-06-15",
      overridesShell: true,
      shellPeriodLabel: "Jun 2026",
    }),
    /not top-bar period \(Jun 2026\)/,
  );
  assert.equal(
    describeReportBasis({ mode: "as_of", to: "2026-06-30" }),
    "Basis: Open items as of 2026-06-30",
  );
});
