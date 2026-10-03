# arnibooks architecture review

Decision documents for the Arnifi accounting platform. **No product code changes in this branch** (benchmark scripts under `scripts/benchmarks/` only).

| Doc | Status |
|---|---|
| [01-plan-critique-and-roadmap.md](./01-plan-critique-and-roadmap.md) | Draft |
| [02-system-of-record-and-domain-model.md](./02-system-of-record-and-domain-model.md) | Draft |
| [03-ingestion-extraction-classification.md](./03-ingestion-extraction-classification.md) | Draft |
| [04-ocr-benchmark-and-cost-optimisation.md](./04-ocr-benchmark-and-cost-optimisation.md) | Draft |
| [05-ml-and-ai-strategy.md](./05-ml-and-ai-strategy.md) | Draft |
| [06-platform-stack-security-compliance.md](./06-platform-stack-security-compliance.md) | Draft |
| [07-cost-model.md](./07-cost-model.md) + [arnibooks-cost-model.csv](./arnibooks-cost-model.csv) | Draft |
| [08-quality-product-and-risk.md](./08-quality-product-and-risk.md) | Draft |
| [09-accounting-core-and-statements.md](./09-accounting-core-and-statements.md) | Draft |

Benchmark harness: [`scripts/benchmarks/`](../../scripts/benchmarks/).

Policy: synthetic data only until the owner confirms; no client files leave the machine; arnibooks never submits to the FTA; dual-control release (preparer ≠ approver) for 90 days; no real client data before portal security review PASS.
