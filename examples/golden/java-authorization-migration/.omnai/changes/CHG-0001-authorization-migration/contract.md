# Boundary Contract — REV-0002

## Current

Mall exposes authorization lookup keyed by user/vehicle/insurer with optional `quoteId` side effects.

## Target

User-center exposes durable authorization state by `authorizationId` and subject/scope. Quote-center creates local usage keyed by `(authorizationId, quoteExecutionId)`.

## Field semantics

| Field | Meaning |
| --- | --- |
| authorizationId | Stable durable authorization identity |
| status | Current grant/revoke/expiry state |
| scope | Insurer/data-use scope |
| quoteExecutionId | Quote-owned idempotency identity, never part of durable consent |

## Compatibility

A temporary mall facade delegates durable state to user-center during consumer migration. It is observable and has a zero-consumer retirement gate.

## Producers / consumers

Producer: user-center. Consumers: quote-center, order audit assembly, temporary mall facade.
