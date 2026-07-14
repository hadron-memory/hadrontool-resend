# hadrontool-resend

Stateless email-sending capability tool for the [Hadron](https://hadronmemory.com)
platform. It gives headless LLM runs a governed way to send one plain-text
email through Resend.

Hadron-server remains the front door. It enforces the run policy
(`tool.hadron_send_email`), daily app and organization quotas (`email.send`),
and one `comm.outbound` action ticket before this service receives a request.

## Architecture

- Stateless, DB-less, and internal-only. Hadron-server reaches it at
  `http://hadrontool-resend:8080`; it needs no public route.
- Hadron-blind: no platform identity, authorization, or data lookup lives here.
- Fixed upstream: requests can reach only `https://api.resend.com/emails`.
- Fixed sender: callers choose one recipient, subject, and text body; the
  verified sender comes only from `RESEND_FROM`.
- Provider-backed idempotency: core supplies an idempotency key and the service
  forwards it to Resend. The service keeps no ledger and never retries sends.
- Data minimization: recipient, subject, body, API key, and bearer token are
  never logged.

## API

`GET /healthz` and `GET /readyz` are public. `GET /info` and all `/ops` routes
require `Authorization: Bearer $RESEND_TOOL_TOKEN` when configured.

### `POST /ops/send-email`

```json
{
  "to": "person@example.net",
  "subject": "Deploy finished",
  "text": "Everything is healthy.",
  "idempotencyKey": "run_123:4c550f"
}
```

Success: `200 {"ok":true,"id":"email_..."}`.

Stable errors are `validation_error` (400), `provider_not_configured` (503),
`provider_unauthorized` (502), `provider_rejected` (502),
`provider_rate_limited` (429), `upstream_unreachable` (502),
`upstream_timeout` (504), and `internal_error` (500).

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `RESEND_TOOL_TOKEN` | in production | Shared bearer for the internal ops plane |
| `RESEND_API_KEY` | for sends | Dedicated Resend API key; may be unset for staged deploys |
| `RESEND_FROM` | with API key | Verified fixed sender, e.g. `Hadron Agent <agent@example.com>` |
| `PORT` | no | Defaults to 8080 |

Use a dedicated API key and sending subdomain, separate from Hadron's login
emails, so agent traffic cannot damage authentication-email deliverability.

## Development

```bash
npm install
npm run dev
npm test
npm run typecheck
```
