/**
 * The output drain used for streaming encodes.
 *
 * When an {@link OStream} is given a `FlushSink`, it writes into a small caller
 * buffer and hands each filled region to the sink, so a message can be far larger
 * than the buffer — larger than RAM, even.
 *
 * **The sink is only ever handed the installed output buffer** — `buffer` is the
 * very array the caller installed, and the bytes are `buffer[start..end)`. There
 * is no second case: CORELIB_PLAN §5.1.6 forbids an encoder from passing the sink
 * any other memory, so a sink never has to ask whether what it received is its own
 * buffer or a payload the encoder handed through from somewhere else. (An earlier
 * revision of the spec permitted that pass-through, off by default; the permission
 * is withdrawn.)
 *
 * The region is valid for the duration of the call. A sink that **copies** it
 * simply returns, and the encoder keeps writing into the same buffer from offset
 * `0`. A sink that **takes** the buffer — queues it, hands it to a transport —
 * must install a replacement with {@link OStream.setBuffer} before returning
 * (§5.1.5); returning without one means "I copied".
 *
 * Passing the buffer and the coordinates rather than a `subarray` of it is not
 * cosmetic: a view would be an allocation per flush, and the encoder allocates
 * nothing after construction (§6.6).
 */
export type FlushSink = (buffer: Uint8Array, start: number, end: number) => void;
