# Current-State Report

## Current reality

- `mall-service/.../AuthorizationService.java:42-138` owns grant/update/revoke and writes `authorization_record`.
- `quote-center/.../AuthorizationClient.java:31-79` asks mall whether user/vehicle/insurer scope can quote.
- `quote-center/.../QuoteApplicationService.java:118-151` also supplies `quoteId`, coupling a durable record to quote execution.
- `order-service/.../OrderSnapshotAssembler.java:88-112` copies authorization facts for audit.
- `mall-service/.../AuthorizationRetryJob.java:55-104` repairs missed callbacks asynchronously.

## Historical lineage

The original mall object was introduced when mall orchestrated quote + order. `quoteId` arrived later for retry/trace support, not as part of durable-consent semantics. Order snapshots were introduced for audit and remain a valid constraint after ownership moves.

## Confirmed facts

1. Current record mixes durable consent and quote usage.
2. Quote and order consume different semantic subsets.
3. Consumers include synchronous APIs and an async repair path.
4. Historical rows before 2024-06 can have no `quoteId`; retry-era data can contain several rows for one durable consent.

## L3 trigger

REV-0001 assumed every legacy row maps to one Authorization plus one AuthorizationUsage. Historical sampling disproved this: durable rows may have zero usages and retry-era rows may represent several usages.
