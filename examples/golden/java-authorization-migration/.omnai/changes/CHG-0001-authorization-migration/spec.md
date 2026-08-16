# Change Specification — REV-0002

## Added requirements

- REQ-001: user-center SHALL own Authorization create/read/revoke/expire lifecycle.
- REQ-002: quote-center SHALL create AuthorizationUsage for each accepted quote execution and SHALL NOT mutate durable Authorization to represent execution.
- REQ-003: order-service SHALL preserve authorization facts needed for historical audit independently of future revocation.
- REQ-004: migration SHALL support historical rows with zero, one, or many inferred usages and SHALL quarantine ambiguous mappings rather than inventing 1:1 history.

## Modified requirement

- REQ-005: mall compatibility facade MAY exist during migration but MUST be observable and have retirement criteria.

## Acceptance criteria

- AC-001 new grants/revokes are authoritative in user-center.
- AC-002 quote retries create distinct idempotent usage facts.
- AC-003 ambiguous historical rows are reconciled or quarantined explicitly.
- AC-004 order audit remains valid after Authorization revoke.
- AC-005 no registered consumer remains on mall before contract removal.
