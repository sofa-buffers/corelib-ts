/**
 * The output drain used for streaming encodes.
 *
 * When an {@link OStream} is given a `FlushSink`, it writes into a small caller
 * buffer and hands each filled region to the sink, so a message can be far
 * larger than the buffer — larger than RAM, even. The chunk passed to the sink
 * is only valid for the duration of the call; copy it if you need to retain it.
 */
export type FlushSink = (chunk: Uint8Array) => void;
