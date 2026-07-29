--[[
  Atomic Device Message Queue Operation

  Purpose:
    Fetches the highest priority message from a source queue, moves it to a
    destination queue with a timeout, updates its status, and returns the message.
    All operations are atomic to prevent race conditions and message loss.

  Why Lua?
    Using Lua ensures all operations happen in a single Redis roundtrip, preventing
    the same message from being selected multiple times by concurrent workers.

  KEYS:
    [1] source_queue                     - Source sorted set to pop message from
    [2] destination_queue                - Destination sorted set to move message to
    [3] list_of_queues_to_distribute_from - Set tracking which queues have work pending

  ARGV:
    [1] timeout_at  - Unix timestamp score for timeout in destination queue
    [2] new_status  - New delivery status string to set on the message

  Returns:
    - nil: if no messages available in source queue
    - {message_id, device_message_fields}: if message found
      where device_message_fields is a flat array from HGETALL
--]]

-- Parse input parameters
local source_queue = KEYS[1]
local destination_queue = KEYS[2]
local list_of_queues_to_distribute_from = KEYS[3]
local timeout_at = ARGV[1]
local new_status = ARGV[2]

-- ============================================================================
-- Step 1: Pop highest priority message from source queue
-- ============================================================================
-- ZPOPMIN removes and returns the member with the lowest score (highest priority)
local next_in_line = redis.call('ZPOPMIN', source_queue)

-- If queue is empty, clean it up and return nil
if #next_in_line == 0 then
  redis.call('SREM', list_of_queues_to_distribute_from, source_queue)
  return nil
end

local message_id = next_in_line[1]
local device_message_key = 'device_message:' .. message_id

-- ============================================================================
-- Step 2: Eager cleanup - Remove source queue from work list if now empty
-- ============================================================================
if redis.call('ZCARD', source_queue) == 0 then
  redis.call('SREM', list_of_queues_to_distribute_from, source_queue)
end

-- ============================================================================
-- Step 3: Verify message hash exists before moving to destination
-- ============================================================================
-- If the hash doesn't exist, the message was likely cleaned up (TTL expired or
-- explicit deletion) but the queue entry remained. The orphan ID is already
-- removed from the source queue by ZPOPMIN; return nil and skip.
if redis.call('EXISTS', device_message_key) == 0 then
  return nil
end

-- ============================================================================
-- Step 4: Move message to destination queue with timeout
-- ============================================================================
-- The timeout score allows us to catch stuck messages in resolution cycles
redis.call('ZADD', destination_queue, timeout_at, message_id)

-- ============================================================================
-- Step 5: Update message status
-- ============================================================================
redis.call('HSET', device_message_key, 'delivery_status', new_status)

-- ============================================================================
-- Step 6: Fetch and return the complete message
-- ============================================================================
-- HGETALL returns a flat array: [field1, value1, field2, value2, ...]
local device_message_fields = redis.call('HGETALL', device_message_key)

return {message_id, device_message_fields}

