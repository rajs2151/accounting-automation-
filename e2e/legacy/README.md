# Legacy / non–Phase-1 e2e

These specs are excluded from the default docker Phase 1 gate (`E2E_PHASE1_GATE=1`).

Re-run the full historical suite with:

```bash
E2E_PHASE1_GATE=0 docker compose --profile e2e run --rm e2e
```

Or locally: `npx playwright test e2e/legacy`.
