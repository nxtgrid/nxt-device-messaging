--[[
  Atomic Queue Move with Stale-Message Guard

  Purpose:
    Moves a message from one queue to another, updates its hash properties,
    and optionally creates a lookup index — but ONLY if the message is
    actually present in the source queue (verified via ZREM).

  Why Lua?
    The non-atomic pipeline version of this operation caused phantom Redis
    entries: when an API call returned after the message had already been
    moved by the zombie detector, HSET would recreate the (now-deleted)
    message hash with only the update fields and no TTL. This script gates
    on ZREM (still in source queue) and EXISTS (hash still present) — either
    miss skips the whole move so HSET cannot recreate a partial hash.

  KEYS:
    [1] source_queue       - Source sorted set to remove message from
    [2] destination_queue  - Destination sorted set to add message to
    [3] message_key        - Hash key for the message (device_message:{id})
    [4] index_key          - Optional index key to create ('' to skip)

  ARGV:
    [1] message_id         - The message ULID (member in sorted sets)
    [2] destination_score  - Score for the destination sorted set (timeout or poll time)
    [3] deliveryStatus     - New deliveryStatus value
    [4] deliveryQueueId    - New deliveryQueueId value ('' to skip)
    [5] index_ttl_seconds  - TTL for the index key (only used if index_key provided)

  Returns:
    - 0: Not in source queue, or hash missing (orphan ZSET member scrubbed from source)
    - 1: Message successfully moved
--]]

local source_queue = KEYS[1]
local destination_queue = KEYS[2]
local message_key = KEYS[3]
local index_key = KEYS[4]

local message_id = ARGV[1]
local destination_score = ARGV[2]
local delivery_status = ARGV[3]
local delivery_queue_id = ARGV[4]
local index_ttl_seconds = ARGV[5]

-- ============================================================================
-- Step 1: Atomically remove from source queue — acts as ownership gate
-- ============================================================================
local removed = redis.call('ZREM', source_queue, message_id)
if removed == 0 then
  return 0
end

-- ============================================================================
-- Step 2: Hash must still exist (TTL expiry / cleanup can leave orphan ZSET members)
-- ============================================================================
-- Orphan id is already gone from the source queue; do not ZADD/HSET/index.
if redis.call('EXISTS', message_key) == 0 then
  return 0
end

-- ============================================================================
-- Step 3: Add to destination queue
-- ============================================================================
redis.call('ZADD', destination_queue, destination_score, message_id)

-- ============================================================================
-- Step 4: Update message hash (camelCase field names — I3)
-- ============================================================================
if delivery_queue_id ~= '' then
  redis.call('HSET', message_key, 'deliveryStatus', delivery_status, 'deliveryQueueId', delivery_queue_id)
else
  redis.call('HSET', message_key, 'deliveryStatus', delivery_status)
end

-- ============================================================================
-- Step 5: Create lookup index if requested
-- ============================================================================
if index_key ~= '' then
  redis.call('SET', index_key, message_key, 'EX', index_ttl_seconds)
end

return 1

