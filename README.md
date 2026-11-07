# Back-in-Stock Alerts

A small, production-minded stock alert service built for the Farla hiring challenge. It provides an embeddable customer form, a protected operations view, persistent subscriptions, authenticated stock webhooks, and responsive HTML email notifications.

## Run with Docker

```bash
docker build -t back-in-stock-alerts .
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e STOCK_API_URL=https://example.test/products \
  -e STOCK_API_KEY=... \
  -e RESEND_API_KEY=... \
  -e RESEND_BASE_URL=https://example.test \
  -e WEBHOOK_SECRET=... \
  -e ADMIN_PASSWORD=choose-a-strong-password \
  -v stock-alert-data:/app/data \
  back-in-stock-alerts
```

Open `/embed`. The admin page is at `/admin` and uses HTTP Basic authentication with username `admin` and `ADMIN_PASSWORD`.

## Environment

The challenge-provided variables are `STOCK_API_URL`, `STOCK_API_KEY`, `RESEND_API_KEY`, `RESEND_BASE_URL`, and `WEBHOOK_SECRET`. `PORT`, `ADMIN_PASSWORD`, and `DATA_DIR` are also supported. The server binds to `PORT` and writes SQLite data beneath `DATA_DIR` (default `./data`).

## Duplicate and missed-email protection

- A partial unique SQLite index prevents the same email/SKU from having two open requests.
- Each webhook `event_id` is stored behind a primary-key constraint before processing, so retried or simultaneous deliveries become no-ops.
- A webhook's quantity is treated only as a hint; the service checks the authenticated stock API before notifying anyone. Network failures release the event for a safe retry.
- Each request is atomically claimed (`open` → `processing`) before email delivery.
- A deterministic Resend idempotency key (`restock-{request_id}`) protects against ambiguous provider retries.
- Failed deliveries return the request to `open` with the error recorded, allowing a later stock event to retry it.
- SQLite WAL mode and a named Docker volume make requests and webhook history survive restarts.

## Security and reliability notes

The webhook secret uses constant-time comparison. Inputs are validated and normalized server-side, JSON bodies are size-limited, admin access is protected, output is escaped, and responses include restrictive browser headers. No production credentials or customer data are committed.

## AI tools

Built with OpenAI Codex for implementation support and manually reviewed for validation, idempotency, persistence, security boundaries, and failure handling.
