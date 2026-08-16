# Domain Model — REV-0002

| Term | Canonical meaning | Not this |
| --- | --- | --- |
| Authorization | Durable permission relationship between subject and insurer/use scope | One quote execution |
| AuthorizationUsage | Fact that one quote execution consumed a valid Authorization | The permission itself |
| AuthorizationSnapshot | Immutable order/audit capture of relevant authorization facts | Live source of truth |

## Ownership

- User Context owns Authorization grant, validity, revoke, and expiry.
- Quote Context owns AuthorizationUsage and references Authorization ID.
- Order Context owns AuthorizationSnapshot for historical audit.

## Invariants

- Revoke blocks future usage but never deletes historical usages or snapshots.
- One Authorization has zero, one, or many AuthorizationUsage records.
- Usage records are immutable after accepted quote submission.
- Snapshot never becomes current authorization authority.
