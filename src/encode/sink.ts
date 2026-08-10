/**
 * The output drain used for streaming encodes.
 *
 * When an {@link OStream} is given a `FlushSink`, it writes into a small caller
 * buffer and hands each filled region to the sink, so a message can be far
 * larger than the buffer — larger than RAM, even. The chunk passed to the sink
 * is only valid for the duration of the call; copy it if you need to retain it.
 */
export type FlushSink = (chunk: Uint8Array) => void;

/**
 * The source of the **next** output buffer, for a caller that owns the storage
 * an encode runs on.
 *
 * CORELIB_PLAN §5.1 gives the encoder exactly one buffer-ownership model: every
 * buffer it writes into is caller-supplied, and it never allocates or grows one
 * itself. A message without a schema-derived bound still has to end up
 * somewhere, so §5.1 puts that decision on the caller — and this is the hook it
 * makes it through. When the buffer is full and there is nowhere to flush to,
 * the encoder asks its owner for a replacement instead of enlarging what it was
 * handed.
 *
 * The owner is called with the buffer in use, the number of leading bytes of it
 * the encoder still needs (`used`), and how many more bytes of room it wants
 * (`needed`). It must return a buffer that
 *
 * - is at least `used + needed` bytes long, and
 * - holds the first `used` bytes of `current`, at the same offsets;
 *
 * or `undefined` to decline, which leaves the encode to report `BUFFER_FULL` (or
 * to split the value across flushes, where a sink is installed). A buffer too
 * short for `used + needed` counts as declining: the encoder never writes past
 * the end of what it was given.
 *
 * {@link growingOStream} is the ready-made owner — an accumulator that doubles.
 */
export type BufferOwner = (
  current: Uint8Array,
  used: number,
  needed: number,
) => Uint8Array | undefined;
