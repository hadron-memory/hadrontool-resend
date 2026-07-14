# Agent development guide — hadrontool-resend

- This service is a stateless, internal-only capability tool. Authorization,
  policy, quotas, and action tickets belong in hadron-server, never here.
- Keep the upstream fixed to Resend. Never accept caller-supplied URLs.
- Keep the sender fixed in environment configuration. Do not add model-chosen
  sender identities, HTML, attachments, CC, or BCC without an explicit design.
- Never log recipients, subjects, bodies, API keys, or bearer tokens.
- Preserve the stable typed error catalog and do not retry email sends.
- Run `npm test`, `npm run typecheck`, and `npm run build` before publishing.
