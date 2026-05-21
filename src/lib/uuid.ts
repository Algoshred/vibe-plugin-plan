/**
 * mintSessionId — UUIDv4 wrapper. Uses `crypto.randomUUID()` from the
 * Web Crypto API (present in Bun + modern Node). We don't strictly need
 * v7's time-ordering; v4 is sufficient since the meta plugin's primary
 * index is `createdAt`.
 */
export function mintSessionId(): string {
  return crypto.randomUUID();
}
