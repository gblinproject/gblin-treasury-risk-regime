/**
 * Block number to timestamp, and back, on Base mainnet without a request.
 *
 * Base produced one block every two seconds from genesis, then one block every 200 milliseconds from
 * FAST_BLOCKS_START onward. `block.timestamp` stays in whole seconds, so after the change five consecutive
 * blocks share a timestamp. Both cadences are fixed by the protocol; the constants below were read from
 * the chain. A later change of block time would need a new segment here.
 */

/** Timestamp of block 0 of Base mainnet. */
export const BASE_GENESIS_TIMESTAMP = 1_686_789_347;
/** First block produced at 200 ms. */
export const FAST_BLOCKS_START = 53_556_127;
/** Timestamp of FAST_BLOCKS_START. */
export const FAST_BLOCKS_START_TIMESTAMP = 1_793_901_601;
/** Blocks per second from FAST_BLOCKS_START onward. */
export const FAST_BLOCKS_PER_SECOND = 5;

/** The timestamp of a Base mainnet block. */
export function timestampOf(block: number | bigint): number {
  const b = Number(block);
  if (b < FAST_BLOCKS_START) return BASE_GENESIS_TIMESTAMP + 2 * b;
  return FAST_BLOCKS_START_TIMESTAMP + Math.floor((b - FAST_BLOCKS_START) / FAST_BLOCKS_PER_SECOND);
}

/** The first Base mainnet block whose timestamp is at or after `timestamp` (seconds). */
export function blockAt(timestamp: number): number {
  if (timestamp >= FAST_BLOCKS_START_TIMESTAMP) {
    return FAST_BLOCKS_START + Math.ceil(timestamp - FAST_BLOCKS_START_TIMESTAMP) * FAST_BLOCKS_PER_SECOND;
  }
  return Math.max(0, Math.ceil((timestamp - BASE_GENESIS_TIMESTAMP) / 2));
}
