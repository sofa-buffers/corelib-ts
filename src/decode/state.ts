/**
 * The decoder: one resumable state machine, and the only one.
 *
 * `DecoderState` consumes input a chunk at a time and never needs to hold more
 * than a single varint (≤10 bytes) or one fixlen element (≤8 bytes), so it can be
 * fed arbitrarily small chunks: every multi-byte construct saves its progress in
 * instance fields and continues on the next {@link push}. String / blob payloads
 * are reported in pieces and array elements as they arrive — nothing is
 * materialised whole, and nothing is allocated (CORELIB_PLAN §6.6).
 *
 * **One implementation, both entry points.** The one-shot {@link decode} is a
 * single {@link push} of the whole buffer, not a second decoder: §6.7.1 forbids
 * the one-shot path from behaving differently, and §5.3.1 names "a second
 * implementation of every rule" as the defect a single surface exists to prevent.
 * Speed comes from a *fast lane* instead: a field whose words can be read without
 * resume bookkeeping — ten bytes in hand, or a varint that terminates inside the
 * chunk ({@link varintQuick}) — is decoded inline, with no per-byte state reload.
 * Only a construct that really does straddle the chunk boundary goes through the
 * resumable switch, so a contiguous message runs the fast lane end to end.
 *
 * **Nothing here allocates** (§6.6). The parse stack is a fixed
 * {@link MAX_DEPTH}-slot `Int32Array` sized at construction; the varint and float
 * accumulators are plain number fields; payloads are reported as `(src, start,
 * end)` into the caller's own fed chunk rather than as views this decoder would
 * have to create (§6.6.3). The single exception the language forces is a `bigint`
 * for an integer beyond 2^53, which is a *value*, not storage (§6.6.3's "a value
 * is not storage") — and it is not created for ids, lengths, counts, or any value
 * that fits a `number`.
 */

import {
  ARRAY_MAX,
  ArrayKind,
  DecodeStatus,
  FIXLEN_MAX,
  FP32_HANDLE_MIN,
  FP64_HANDLE_MIN,
  FixlenSubtype,
  ID_MAX,
  MAX_DEPTH,
  VARINT_MAX_BYTES,
  WireType,
} from "../constants.js";
import type { FeedStatus } from "../constants.js";
import { SofabError, SofabErrorCode, invalidMsgError } from "../errors.js";
import { joinI64, joinU64 } from "../varint/bits64.js";
import { fp32FromBits, fp64FromBits } from "../varint/num64.js";
import { SKIP } from "./skip.js";
import type { Visitor } from "./istream.js";

const enum S {
  Header,
  ScalarU,
  ScalarS,
  FixlenWord,
  FixlenFp,
  FixlenBytes,
  ArrayCount,
  ArrayUElem,
  ArraySElem,
  ArrayElemWord,
  ArrayFp,
}

const TWO32 = 0x1_0000_0000; // 2^32, for combining the 32-bit halves

export class DecoderState {
  /** The caller's visitor — bound at construction, or re-bound by {@link begin}. */
  private root: Visitor;
  /**
   * Where fields are dispatched right now: {@link root}, or {@link SKIP} while a
   * declined subtree is being consumed. Two shapes at most at every call site,
   * which is what the flat visitor buys: with one visitor object per *message*
   * instead of one per nested scope, the dispatch sites below stay
   * (bi)morphic rather than degrading to a megamorphic lookup per call.
   */
  private cur: Visitor;
  /**
   * Depth at which the current skipped subtree was opened, or `-1` when nothing
   * is being skipped. The scope that returned `false` from
   * {@link Visitor.sequenceBegin} closes at this depth, and skipping ends there.
   */
  private skipFrom = -1;

  /**
   * **No receiver cap lives here** (§6.2.1). This decoder used to hold
   * `maxArrayCount` / `maxStringLen` / `maxBlobLen`, defaulted to the format
   * ceilings when the caller supplied none — which is precisely the shape §6.2.1
   * forbids: "a codec **MUST NOT** hold a limit of its own, **MUST NOT** supply a
   * default for one it was not given, **MUST NOT** read an omitted argument as
   * *unlimited*, and **MUST NOT** clamp to one", and "a format ceiling (§6.2)
   * reached because no cap was stated is the **format's** bound, not a receiver
   * cap, and a port **MUST NOT** present it as one". Reporting `LimitExceeded`
   * against `ARRAY_MAX`/`FIXLEN_MAX` did exactly that.
   *
   * The caps now have **one implementation** and it is not here: generated code
   * compares them in its own flat visitor, at `arrayBegin` / `fixlenBegin` — both
   * of which this decoder raises at the count / length header, before a byte of
   * payload is emitted and behind the MESSAGE_SPEC §7.3 tag test — and a wrapper
   * array's elements, which reach no visitor callback, are capped by the
   * `StringSeq` / `BlobSeq` collectors from bounds passed to their
   * constructors. §6.2.1: "A port whose codec offers the check **MUST NOT** also
   * emit it into the generated layer, and a port that enforces it in generated
   * code **MUST NOT** ask the codec to enforce it too."
   *
   * The format ceilings below (`ARRAY_MAX`, `FIXLEN_MAX`, `MAX_DEPTH`, the varint
   * bound) are *not* receiver caps and stay here: they bound what the wire may
   * express, and exceeding one is `INVALID` (§6.2).
   */

  /**
   * The id of every open sequence, indexed by the depth it was opened at, so a
   * scope close can name the sequence it closes. Fixed size, sized from
   * {@link MAX_DEPTH} at construction — the "fixed-size parse stack" §6.6.2
   * allows, and the reason nothing here grows a stack per message.
   *
   * A plain array rather than an `Int32Array`, and the difference is 3 µs: V8
   * keeps a typed array's bytes inside the JS heap only up to 64 bytes, so a
   * 255-slot one is an *external* allocation — measured at ~3.1 µs on Node 24,
   * against ~5 ns for this. That is paid per decoder, and the one-shot
   * {@link decode} builds a decoder per message, so it was the whole cost of
   * decoding a small one. Slots are written before they are read (a scope is
   * opened before it closes), so the array is never read holey.
   */
  private readonly seqIds: number[] = new Array<number>(MAX_DEPTH);
  /** Number of nested sequences currently open — 0 at the root scope. */
  private depth = 0;

  private state = S.Header;

  /**
   * The terminal-refusal latch: the rejection this stream was stopped by, or
   * `null` while it is still healthy. **One latch, two codes** — §5.3.1 gives the
   * rule one implementation, and §6.3 makes both of these rejections terminal:
   *
   * - `INVALID_MSG` (§5.2.1: "malformed **regardless of what follows** … no —
   *   terminal") — no later bytes can make malformed input valid;
   * - `LIMIT_EXCEEDED` (§6.3: "A **terminal**, receiver-local **policy**
   *   rejection") — well-formed bytes the receiver's cap refuses.
   *
   * They are latched together and **kept apart by their code**, which is the
   * distinction §6.3 requires: a limit rejection "**MUST NOT** be reported as
   * `InvalidMessage`", so the code is re-raised as itself and each stays the
   * refusal it was.
   *
   * Latching is not bookkeeping, it is the terminality: both rejections are
   * raised *mid-field* — the UTF-8 check inside a payload piece, a cap inside the
   * count or length callback — so the machine is left at a position the visitor
   * never finished. Resume it and the refused field's own bytes are re-read as
   * headers, delivering fields that were never on the wire.
   *
   * The rejection is written here by {@link latch} and nowhere else: this
   * machine's own malformation findings arrive through {@link fail}, and the ones
   * raised above it — the §6.4.5 UTF-8 verdict, and the receiver caps §6.2.1
   * keeps out of this codec — arrive as a throw out of a visitor callback, caught
   * once in {@link push}.
   */
  private refusal: SofabError | null = null;

  /**
   * A `DataView` over the chunk currently being fed, and the chunk it addresses —
   * the **language-forced handle** of CORELIB_PLAN §6.6.2, and the only way
   * JavaScript lets a reader take an IEEE-754 value from a byte offset. Without it
   * a float costs four or eight byte loads, a shift ladder and a round trip
   * through a scratch word; with it, one call.
   *
   * It qualifies because it carries no message bytes (it addresses the *caller's*
   * chunk) and no wire number sizes it (its extent is the chunk's). Built lazily
   * and only where it pays: a float **array** whose remaining run inside this chunk
   * clears {@link FP32_HANDLE_MIN} / {@link FP64_HANDLE_MIN}. A scalar float, a
   * short array, a message with no float at all, and a byte-at-a-time feed each
   * build none. Once built it is kept while the same chunk is being fed, and it
   * never leaves this class.
   */
  private view: DataView | null = null;
  private viewOf: Uint8Array | null = null;

  /** The current field's id. */
  private id = 0;

  // Resumable varint accumulator, as two unsigned 32-bit halves (vLo / vHi) plus
  // the byte count so far. Number-only: a `bigint` is built once, at the end, and
  // only for full 64-bit *values* (never for ids, lengths or counts).
  private vLo = 0;
  private vHi = 0;
  private vBytes = 0;
  private vComplete = false;

  /**
   * Resumable fp32 / fp64 accumulator, as two little-endian 32-bit words rather
   * than a byte array: a typed array would be a per-decoder allocation, and two
   * number fields hold the same 8 bytes. Byte `k` lands in bits `8*k` of `fpLo`
   * (k < 4) or of `fpHi`, so the pair is already in wire (little-endian) order.
   */
  private fpLo = 0;
  private fpHi = 0;
  private need = 0;
  private have = 0;

  // fixlen string/blob streaming
  private fixSub: FixlenSubtype = FixlenSubtype.String;
  private fixLen = 0;
  private fixOff = 0;

  // array
  private arrKind: ArrayKind = ArrayKind.Unsigned;
  private arrIsFixlen = false;
  private arrCount = 0;
  private arrIndex = 0;

  constructor(visitor: Visitor = SKIP) {
    this.root = visitor;
    this.cur = visitor;
    this.begin(visitor);
  }

  /**
   * (Re)bind this machine to a visitor, clearing every trace of whatever it
   * decoded before.
   *
   * Constructing a decoder is the one allocating step (§6.6), and the one-shot
   * {@link decode} would otherwise pay it per message — which on a 37-byte message
   * is most of the cost. So {@link decode} keeps one machine and re-binds it here;
   * this method is what makes that indistinguishable from a fresh one.
   *
   * **Only the fields a fresh decode can *read* are cleared**, and the list is
   * exhaustive by construction rather than by inspection: every other field is
   * written before it is read, on every path that reads it — `id` at each header,
   * `vLo`/`vHi` by whichever varint reader ran (a fresh accumulation starts from
   * zero because `vBytes` is 0), `vComplete` by the `varintStep` whose result is
   * being tested, `fpLo`/`fpHi`/`need` by {@link fpBegin}, `fix*` by
   * {@link fixlenWord}, `arrKind`/`arrIsFixlen` by {@link dispatch} and
   * `arrCount`/`arrIndex` by the count word, `seqIds[d]` when the scope at `d`
   * opens. `have` is the one exception and *is* cleared: the `S.ArrayFp` bulk loop
   * reads it to decide whether an element is half-arrived.
   *
   * `view`/`viewOf` are not cleared either, and deliberately: {@link dataView}
   * keys the cached handle on the chunk it addresses, so a stale one is rebuilt the
   * moment a different chunk arrives and reused — correctly — when the same buffer
   * is decoded again. {@link release} still drops it, which is where it matters:
   * a pooled machine must not keep the caller's last chunk alive between calls.
   *
   * Clearing them all anyway cost 5573 → 5324 Ir/op on `decode: typical message`
   * (~4.5%), which is what a 21-field wipe costs when the message is 37 bytes. The
   * invariant is held by `pooled-decoder-state.test.ts`, which aborts a decode in
   * every construct and then reuses the machine.
   */
  begin(visitor: Visitor): void {
    this.root = visitor;
    this.cur = visitor;
    this.skipFrom = -1;
    this.depth = 0;
    this.state = S.Header;
    this.refusal = null;
    this.vBytes = 0;
    this.have = 0;
  }

  /**
   * Drop the references a pooled machine would otherwise keep alive: the caller's
   * visitor, and the handle onto the caller's chunk.
   */
  release(): void {
    this.root = SKIP;
    this.cur = SKIP;
    this.view = null;
    this.viewOf = null;
  }

  /** Feed `input` to the machine, dispatching to the bound visitor. */
  push(input: Uint8Array): void {
    // A latched refusal is terminal (§5.2.1, §6.3). Once one has been raised the
    // stream consumes nothing further and drives no visitor callbacks — it just
    // re-reports the original rejection, under its own code. One
    // perfectly-predicted branch per chunk.
    const latched = this.refusal;
    if (latched !== null) throw new SofabError(latched.code, latched.message);

    try {
      this.run(input);
    } catch (e) {
      // Neither terminal rejection is necessarily raised *by* this machine. §6.4.5
      // puts the strict UTF-8 check where a string is materialized and §6.2.1 puts
      // the receiver caps in the layer that holds the numbers, so both are decided
      // inside a visitor callback and arrive here as a throw out of the loop. They
      // are the same two rejections this machine raises itself, and §5.3.1 allows
      // a rule only one implementation, so they go through the one latch rather
      // than beside it. Unlatched, the next chunk resumes parsing mid-field and
      // hands the refused field's own bytes to the visitor as fields that were
      // never on the wire.
      //
      // The two codes stay distinct through the latch — §6.3: a cap rejection
      // "MUST NOT be reported as `InvalidMessage`", so it is re-raised as
      // `LIMIT_EXCEEDED` and never becomes `INVALID`.
      if (
        this.refusal === null &&
        e instanceof SofabError &&
        (e.code === SofabErrorCode.InvalidMsg ||
          e.code === SofabErrorCode.LimitExceeded)
      ) {
        this.latch(e);
      }
      throw e;
    }
  }

  /**
   * The decode loop itself. {@link push} wraps it, so the terminal-refusal latch
   * is applied in exactly one place — including to a rejection the visitor raised
   * — and this stays the plain state machine.
   */
  private run(input: Uint8Array): void {
    const n = input.length;
    let i = 0;

    while (i < n) {
      // ---- fast lane -----------------------------------------------------
      // At a clean field boundary, decode the whole field inline whenever its
      // words can be read without resume bookkeeping — which {@link varintQuick}
      // decides per word, so the lane keeps working in the last bytes of a chunk
      // rather than stopping ten bytes short of it. That matters more than it
      // sounds: a 37-byte message is *all* tail, and a lane that gave up there
      // would run half of every small message down the resumable ladder.
      //
      // Everything that cannot finish here — a value whose varint straddles the
      // chunk, a payload longer than it, an array, a float with fewer than its
      // bytes left — sets up its resumable state and drops into the switch below,
      // so no rule is implemented twice.
      if (this.state === S.Header && this.vBytes === 0) {
        // A one-byte header, read without a call. Every id below 16 is one byte,
        // which is most fields of most messages, and {@link varintQuick} is past
        // what the JIT will inline — so calling it per field costs a real call and
        // spills the cursor. Measured on `decode: typical message`: 6708 → 5573
        // Ir/op for this and the two value sites below, ~17%.
        let h: number;
        const hb = input[i]!;
        if (hb < 0x80) {
          this.vLo = hb;
          this.vHi = 0;
          h = i + 1;
        } else h = this.varintQuick(input, i, n);
        if (h >= 0) {
          i = h;
          const type = this.vLo & 7;
          // §4.9/§6.2: the ceiling binds *every* field header, the sequence end
          // included — a sequence end's id is discarded, but discarded is not
          // unvalidated. Splitting and checking the id before dispatching on the
          // wire type keeps this one unconditional guard on the header path with
          // no per-wire-type exception. (Inlined for the one-word header every
          // small id has: `vUpper` is only needed once the high half is in play.)
          const id = this.vHi === 0 ? this.vLo >>> 3 : this.vUpper();
          if (id > ID_MAX) this.fail(`field id ${id} out of range`);

          if (type === WireType.SequenceEnd) {
            this.endSequence();
            continue;
          }
          this.id = id;
          // Announce the header before the value — and before the value's own
          // header word — so a visitor sees the field stream in wire order. It
          // carries no verdict of its own: a schema bound waits for the word
          // behind it (§4.1.1; see Visitor.fieldBegin).
          this.cur.fieldBegin?.(id, type as WireType);

          if (type === WireType.Unsigned) {
            // The same one-byte read for the value (see the header above). `0x80`
            // stands in at end-of-chunk, so the fallback suspends as it should.
            let v: number;
            const b0 = i < n ? input[i]! : 0x80;
            if (b0 < 0x80) {
              this.vLo = b0;
              this.vHi = 0;
              v = i + 1;
            } else v = this.varintQuick(input, i, n);
            if (v < 0) {
              this.state = S.ScalarU;
              continue;
            }
            i = v;
            // vUnsigned() inlined: on this path the halves are already in hand,
            // and this is the most-executed dispatch in the decoder.
            const lo = this.vLo >>> 0;
            const hi = this.vHi >>> 0;
            this.cur.unsigned?.(
              id,
              hi <= 0x1fffff ? hi * TWO32 + lo : joinU64(lo, hi),
              lo,
              hi,
            );
            continue;
          }
          if (type === WireType.Signed) {
            let v: number;
            const b0 = i < n ? input[i]! : 0x80;
            if (b0 < 0x80) {
              this.vLo = b0;
              this.vHi = 0;
              v = i + 1;
            } else v = this.varintQuick(input, i, n);
            if (v < 0) {
              this.state = S.ScalarS;
              continue;
            }
            i = v;
            const lo = this.vLo >>> 0;
            const hi = this.vHi >>> 0;
            const mask = -(lo & 1) >>> 0;
            this.cur.signed?.(
              id,
              this.vSigned(),
              ((((lo >>> 1) | (hi << 31)) >>> 0) ^ mask) >>> 0,
              ((hi >>> 1) ^ mask) >>> 0,
            );
            continue;
          }
          if (type === WireType.Fixlen) {
            const w = this.varintQuick(input, i, n);
            if (w < 0) {
              this.state = S.FixlenWord;
              continue;
            }
            i = this.fixlenWord(input, w, n);
            continue;
          }
          // Arrays and sequence starts have no inline form worth writing: an
          // array is driven by the element loops in the switch, and a sequence
          // start is one call either way.
          this.dispatch(type);
          continue;
        }
      }

      // ---- resumable path ------------------------------------------------
      switch (this.state) {
        case S.Header: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const type = this.vLo & 7;
          const id = this.vUpper();
          if (id > ID_MAX) this.fail(`field id ${id} out of range`);
          if (type === WireType.SequenceEnd) {
            this.endSequence();
            break;
          }
          this.id = id;
          this.cur.fieldBegin?.(id, type as WireType);
          this.dispatch(type);
          break;
        }

        case S.ScalarU: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          this.state = S.Header;
          this.cur.unsigned?.(this.id, this.vUnsigned(), this.vLo >>> 0, this.vHi >>> 0);
          break;
        }

        case S.ScalarS: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          this.state = S.Header;
          const lo = this.vLo >>> 0;
          const hi = this.vHi >>> 0;
          const mask = -(lo & 1) >>> 0;
          this.cur.signed?.(
            this.id,
            this.vSigned(),
            ((((lo >>> 1) | (hi << 31)) >>> 0) ^ mask) >>> 0,
            ((hi >>> 1) ^ mask) >>> 0,
          );
          break;
        }

        case S.FixlenWord: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          i = this.fixlenWord(input, i, n);
          break;
        }

        case S.FixlenFp: {
          i = this.fpStep(input, i, n);
          if (this.have < this.need) return;
          this.state = S.Header;
          if (this.fixSub === FixlenSubtype.Fp32) {
            this.cur.fp32?.(this.id, fp32FromBits(this.fpLo), this.fpLo >>> 0);
          } else {
            this.cur.fp64?.(this.id, fp64FromBits(this.fpLo, this.fpHi));
          }
          break;
        }

        case S.FixlenBytes: {
          const take = Math.min(n - i, this.fixLen - this.fixOff);
          this.emitBytes(input, i, i + take);
          i += take;
          this.fixOff += take;
          if (this.fixOff === this.fixLen) this.state = S.Header;
          break;
        }

        case S.ArrayCount: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const count = this.vNum();
          // `ARRAY_MAX` is the FORMAT's ceiling (§6.2), not a receiver cap: it
          // bounds what the wire may express, so exceeding it is `INVALID` for
          // every receiver however it is configured. A receiver cap on this count
          // is generated code's, compared inside the `arrayBegin` raised below —
          // still at the count word, still before any element is delivered, and
          // only for a field this visitor actually reads (§6.2.1).
          if (count > ARRAY_MAX) this.fail("array count out of range");
          this.arrCount = count;
          this.arrIndex = 0;
          if (this.arrIsFixlen) {
            // §4.8: a fixlen array always carries its element-length word — even
            // when empty — so the true element kind (fp32 vs fp64) stays known.
            // The kind is knowable only once that word arrives, so arrayBegin
            // waits for it (handled in S.ArrayElemWord).
            this.state = S.ArrayElemWord;
          } else if (count === 0) {
            // §4.7: a zero-count integer array is empty — no payload follows and
            // no element-length word exists (element width is API-only).
            this.state = S.Header;
            this.cur.arrayBegin?.(this.id, this.arrKind, 0);
            this.cur.arrayEnd?.(this.id);
          } else {
            this.state = this.arrKind === ArrayKind.Unsigned ? S.ArrayUElem : S.ArraySElem;
            this.cur.arrayBegin?.(this.id, this.arrKind, count);
          }
          break;
        }

        case S.ArrayUElem: {
          // Bulk drain: while a whole element varint is known to be present,
          // decode elements back to back without re-entering the outer switch or
          // the resumable accumulator once per element. The tail — where an
          // element may straddle the chunk — falls through to the single-element
          // path below, which is the one that suspends and resumes.
          const cur = this.cur;
          const id = this.id;
          const count = this.arrCount;
          const safeEnd = n - VARINT_MAX_BYTES;
          let idx = this.arrIndex;
          // Only enter the bulk path at a clean element boundary: a varint left
          // half-read by the previous chunk lives in the accumulator, and
          // `varintFull` would start a fresh one and drop it.
          if (this.vBytes === 0) {
            while (idx < count && i <= safeEnd) {
              i = this.varintFull(input, i);
              cur.arrayUnsigned?.(id, idx, this.vUnsigned(), this.vLo >>> 0, this.vHi >>> 0);
              this.arrIndex = ++idx;
            }
          }
          if (idx === count) {
            this.state = S.Header;
            cur.arrayEnd?.(id);
            break;
          }
          if (i >= n) break;
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          cur.arrayUnsigned?.(id, idx, this.vUnsigned(), this.vLo >>> 0, this.vHi >>> 0);
          this.advanceArray();
          break;
        }

        case S.ArraySElem: {
          const cur = this.cur;
          const id = this.id;
          const count = this.arrCount;
          const safeEnd = n - VARINT_MAX_BYTES;
          let idx = this.arrIndex;
          // See the unsigned arm: never bulk-decode over a pending partial varint.
          if (this.vBytes === 0) {
            while (idx < count && i <= safeEnd) {
              i = this.varintFull(input, i);
              const lo = this.vLo >>> 0;
              const hi = this.vHi >>> 0;
              const mask = -(lo & 1) >>> 0;
              cur.arraySigned?.(
                id,
                idx,
                this.vSigned(),
                ((((lo >>> 1) | (hi << 31)) >>> 0) ^ mask) >>> 0,
                ((hi >>> 1) ^ mask) >>> 0,
              );
              this.arrIndex = ++idx;
            }
          }
          if (idx === count) {
            this.state = S.Header;
            cur.arrayEnd?.(id);
            break;
          }
          if (i >= n) break;
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          {
            const lo = this.vLo >>> 0;
            const hi = this.vHi >>> 0;
            const mask = -(lo & 1) >>> 0;
            cur.arraySigned?.(
              id,
              idx,
              this.vSigned(),
              ((((lo >>> 1) | (hi << 31)) >>> 0) ^ mask) >>> 0,
              ((hi >>> 1) ^ mask) >>> 0,
            );
          }
          this.advanceArray();
          break;
        }

        case S.ArrayElemWord: {
          i = this.varintStep(input, i);
          if (!this.vComplete) return;
          const sub = this.vLo & 7;
          const size = this.vUpper();
          if (sub === FixlenSubtype.Fp32 && size === 4) {
            this.arrKind = ArrayKind.Fp32;
            this.fpBegin(4);
          } else if (sub === FixlenSubtype.Fp64 && size === 8) {
            this.arrKind = ArrayKind.Fp64;
            this.fpBegin(8);
          } else {
            this.fail("invalid fixlen array element type");
          }
          if (this.arrCount === 0) {
            // §4.8: an empty fixlen array is [ header ][ count = 0 ][ fixlen_word ]
            // with no payload — the word above yielded the true element kind.
            this.state = S.Header;
            this.cur.arrayBegin?.(this.id, this.arrKind, 0);
            this.cur.arrayEnd?.(this.id);
          } else {
            this.state = S.ArrayFp;
            this.cur.arrayBegin?.(this.id, this.arrKind, this.arrCount);
          }
          break;
        }

        case S.ArrayFp: {
          const cur = this.cur;
          const id = this.id;
          const count = this.arrCount;
          const size = this.need;
          const isFp32 = this.arrKind === ArrayKind.Fp32;
          let idx = this.arrIndex;
          // Bulk drain, as in the integer arms: an element wholly inside the
          // chunk is read straight out of it, and only a straddling one goes
          // through the byte-at-a-time accumulator below.
          if (this.have === 0 && idx < count && n - i >= size) {
            i = this.fpDrain(input, i, n, count, size, isFp32);
            idx = this.arrIndex;
          }
          if (idx === count) {
            this.state = S.Header;
            cur.arrayEnd?.(id);
            break;
          }
          if (i >= n) break;
          i = this.fpStep(input, i, n);
          if (this.have < this.need) return;
          const lo = this.fpLo;
          const hi = this.fpHi;
          this.fpBegin(size); // next element starts from a clear accumulator
          if (isFp32) cur.arrayFp32?.(id, idx, fp32FromBits(lo), lo >>> 0);
          else cur.arrayFp64?.(id, idx, fp64FromBits(lo, hi));
          this.advanceArray();
          break;
        }
      }
    }
  }

  /**
   * Where the decode stands (§5.2.1), *without* promoting it to an error:
   * {@link DecodeStatus.Complete} when the stream ended exactly at a field
   * boundary, {@link DecodeStatus.Incomplete} when it ended inside a field (a
   * partial varint, an unfinished payload / array, or a still-open nested
   * sequence). A trailing `Incomplete` is a truncation the caller decides how to
   * treat (§5.2.4), not an error this machine raises.
   *
   * **Only these two, and only on a healthy machine.** This is read in exactly
   * one place — after a {@link push} that returned — and a push that met a
   * terminal refusal does not return: it throws, this call is never reached, and
   * the verdict travels out on the error it threw. So `Invalid` is not a value
   * this can produce, and neither is the "refused by a cap" state the outcome
   * triple cannot name (§6.3). Nothing here re-reports a latched refusal, because
   * nothing needs to: the throw is the whole report, and a report with one
   * carrier has nothing to drift out of step with.
   *
   * The cursor's own answer would be wrong for a refused stream, which is why the
   * refusal must not fall through to it: a cap is compared in `arrayBegin` /
   * `fixlenBegin`, raised with the header and the count / length word consumed and
   * the payload not yet entered — a cursor that reads as a clean field boundary,
   * and so as `Complete`. {@link push}'s latch is what keeps that unreachable.
   */
  outcome(): FeedStatus {
    const atBoundary =
      this.state === S.Header && this.vBytes === 0 && this.depth === 0;
    return atBoundary ? DecodeStatus.Complete : DecodeStatus.Incomplete;
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Reject the input as malformed: latch the terminal `INVALID` verdict and throw
   * `INVALID_MSG`. Every malformation *this machine* finds goes through here, so
   * none of them can be caught and then decoded past — §5.2.1's "no — terminal".
   * Declared `never` so a call ends control flow exactly like the `throw` it
   * replaced.
   */
  private fail(message: string): never {
    throw this.latch(invalidMsgError(message));
  }

  /**
   * Record `e` as the terminal refusal that stopped this stream, and hand it back
   * to be thrown. The only writer of {@link refusal} — §5.3.1's one
   * implementation of the rule — for a rejection raised here and for one raised
   * above this machine and caught in {@link push} alike. The error is stored, not
   * its text: the code travels with it, so `INVALID_MSG` and `LIMIT_EXCEEDED`
   * each stay themselves (§6.3).
   */
  private latch<E extends SofabError>(e: E): E {
    this.refusal = e;
    return e;
  }

  /**
   * Act on a complete `fixlen_word` sitting in the varint accumulator: validate
   * it, announce the field, and either read the float inline (when its bytes are
   * in this chunk) or set up the resumable payload state. Shared by the fast lane
   * and the `S.FixlenWord` arm, so the §4.6 rules exist once.
   */
  private fixlenWord(input: Uint8Array, i: number, n: number): number {
    const sub = this.vLo & 7;
    const len = this.vUpper();
    // §4.6: reserved subtypes and a wrong float width are malformed the moment
    // the word is read — before any payload byte is consumed or waited for
    // (§5.2.3).
    if (sub > FixlenSubtype.Blob) this.fail(`invalid fixlen subtype ${sub}`);
    if (len > FIXLEN_MAX) this.fail("fixlen length out of range");

    if (sub === FixlenSubtype.Fp32 || sub === FixlenSubtype.Fp64) {
      const want = sub === FixlenSubtype.Fp32 ? 4 : 8;
      if (len !== want) this.fail("fixlen float length mismatch");
      this.fixSub = sub as FixlenSubtype;
      if (n - i >= want) {
        this.state = S.Header;
        // A *scalar* float is assembled from byte loads, not through a handle:
        // building one costs ~129 ns against the ~2-8 ns it would save on a single
        // value. §6.6.2 permits the handle; arithmetic rules it out here. Only the
        // array drain below reads enough floats from one chunk to amortize it.
        const lo = u32le(input, i);
        if (want === 4) {
          // The bits are what came off the wire; §6.5 needs the value *and* them,
          // because a double cannot carry an fp32 signaling NaN.
          this.cur.fp32?.(this.id, fp32FromBits(lo), lo);
        } else {
          this.cur.fp64?.(this.id, fp64FromBits(lo, u32le(input, i + 4)));
        }
        return i + want;
      }
      this.fpBegin(want);
      this.state = S.FixlenFp;
      return i;
    }

    this.fixSub = sub as FixlenSubtype;
    this.fixLen = len;
    this.fixOff = 0;
    // Announce the field at its LENGTH WORD, before any payload — the counterpart
    // of arrayBegin at the count word. This is the enforcement point §6.2.1 names
    // for a receiver cap on the declared length, and generated code compares its
    // cap inside this very callback: nothing below has run yet, so a rejection
    // costs no allocation, and only a field the visitor declares a callback for
    // is reached at all (a skipped field is never capped). It is decidable here,
    // and only here for a message that ends right after the word (§5.2.3: INVALID
    // over INCOMPLETE).
    this.cur.fixlenBegin?.(this.id, this.fixSub, len);
    if (len === 0) {
      // Still one delivery, so a zero-length payload is announced exactly like
      // any other: an empty range of the caller's own chunk.
      this.emitBytes(input, i, i);
      this.state = S.Header;
      return i;
    }
    const take = Math.min(n - i, len);
    if (take > 0) {
      this.emitBytes(input, i, i + take);
      this.fixOff = take;
      i += take;
    }
    this.state = this.fixOff === len ? S.Header : S.FixlenBytes;
    return i;
  }

  private dispatch(type: number): void {
    switch (type) {
      case WireType.Unsigned:
        this.state = S.ScalarU;
        break;
      case WireType.Signed:
        this.state = S.ScalarS;
        break;
      case WireType.Fixlen:
        this.state = S.FixlenWord;
        break;
      case WireType.ArrayUnsigned:
        this.arrKind = ArrayKind.Unsigned;
        this.arrIsFixlen = false;
        this.state = S.ArrayCount;
        break;
      case WireType.ArraySigned:
        this.arrKind = ArrayKind.Signed;
        this.arrIsFixlen = false;
        this.state = S.ArrayCount;
        break;
      case WireType.ArrayFixlen:
        this.arrIsFixlen = true; // element kind resolved at the element-length word
        this.state = S.ArrayCount;
        break;
      case WireType.SequenceStart:
        this.beginSequence();
        break;
      default:
        this.fail(`invalid wire type ${type}`);
    }
  }

  /**
   * Open a nested sequence: offer it to the visitor, note its id, and descend.
   *
   * A visitor that answers `false` declines the whole subtree — no callback of
   * any kind fires inside it, its own {@link Visitor.sequenceEnd} included, and a
   * scope opened within it is never offered either. The subtree is still *parsed*
   * (a sequence is framed by markers, not by a length, so its end has to be
   * found) and every format ceiling still applies; what stops is delivery.
   */
  private beginSequence(): void {
    const d = this.depth;
    // §4.9/§6.2: reject nesting deeper than MAX_DEPTH.
    if (d >= MAX_DEPTH) this.fail(`nesting exceeds MAX_DEPTH (${MAX_DEPTH})`);
    if (this.cur !== SKIP && this.root.sequenceBegin?.(this.id, d + 1) === false) {
      this.skipFrom = d;
      this.cur = SKIP;
    }
    this.seqIds[d] = this.id;
    this.depth = d + 1;
    this.state = S.Header;
  }

  private endSequence(): void {
    const d = this.depth;
    if (d === 0) this.fail("unbalanced sequence end");
    this.state = S.Header;
    const closed = d - 1;
    this.depth = closed;
    if (this.skipFrom >= 0) {
      // The declined subtree ends where it began; nothing was delivered inside
      // it, and its own end is part of it.
      if (this.skipFrom === closed) {
        this.skipFrom = -1;
        this.cur = this.root;
      }
      return;
    }
    this.root.sequenceEnd?.(this.seqIds[closed]!, d);
  }

  private advanceArray(): void {
    if (++this.arrIndex === this.arrCount) {
      this.state = S.Header;
      this.cur.arrayEnd?.(this.id);
    }
  }

  /**
   * Report one payload piece: the caller's own fed chunk plus the coordinates of
   * the piece inside it (§6.6.3). No view is created — this decoder allocates
   * nothing (§6.6) and exposes no borrowed slice of its own (§6.7); `src` is the
   * very array the caller passed to `feed`, so whoever wants the bytes copies
   * them out of memory it already owns, during the call.
   */
  private emitBytes(src: Uint8Array, start: number, end: number): void {
    const v = this.cur;
    if (this.fixSub === FixlenSubtype.String) {
      v.string?.(this.id, this.fixLen, this.fixOff, src, start, end);
    } else {
      v.blob?.(this.id, this.fixLen, this.fixOff, src, start, end);
    }
  }

  /**
   * Consume varint bytes from `input` at `i` into the {@link vLo} / {@link vHi}
   * accumulator, resuming across chunk boundaries; sets {@link vComplete} when a
   * terminator byte arrives. Number-only — no per-byte `bigint`.
   */
  private varintStep(input: Uint8Array, i: number): number {
    // Fast path: a one-byte varint, which is what every small id, length, count
    // and scalar is. Resolved with a single load and no resume bookkeeping.
    if (this.vBytes === 0) {
      const n0 = input.length;
      const b0 = input[i]!;
      if (b0 < 0x80) {
        this.vLo = b0;
        this.vHi = 0;
        this.vComplete = true;
        return i + 1;
      }
      // Two- and three-byte varints resolved inline — that is every id past 15,
      // every mid-sized length or count, and the zig-zag of a small signed
      // scalar.
      if (i + 1 < n0) {
        const b1 = input[i + 1]!;
        if (b1 < 0x80) {
          this.vLo = (b0 & 0x7f) | (b1 << 7);
          this.vHi = 0;
          this.vComplete = true;
          return i + 2;
        }
        if (i + 2 < n0) {
          const b2 = input[i + 2]!;
          if (b2 < 0x80) {
            this.vLo = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | (b2 << 14);
            this.vHi = 0;
            this.vComplete = true;
            return i + 3;
          }
        }
      }
      // Longer, and the whole of it is in this chunk: take the unrolled reader,
      // which needs no per-byte resume state at all.
      if (n0 - i >= VARINT_MAX_BYTES) return this.varintFull(input, i);
    }

    // A completed varint leaves `vBytes` at 0 and `vLo`/`vHi` stale, so a fresh
    // accumulation must start from zero rather than from those dead halves.
    const k0 = this.vBytes;
    let lo = k0 === 0 ? 0 : this.vLo;
    let hi = k0 === 0 ? 0 : this.vHi;
    let k = k0;
    const n = input.length;
    while (i < n) {
      if (k >= VARINT_MAX_BYTES) this.fail("varint overflow");
      const b = input[i++]!;
      if (k < 4) lo |= (b & 0x7f) << (7 * k);
      else if (k === 4) {
        lo |= (b & 0x0f) << 28;
        hi |= (b >> 4) & 0x07;
      } else {
        // 10th byte (k === 9) has only bit 63 below 64; any higher payload bit
        // would spill past bit 63 and is a >64-bit overflow.
        if (k === 9 && ((b & 0x7f) >> 1) !== 0) this.fail("varint overflow");
        hi |= (b & 0x7f) << (7 * k - 32);
      }
      k++;
      if ((b & 0x80) === 0) {
        this.vLo = lo;
        this.vHi = hi;
        this.vBytes = 0;
        this.vComplete = true;
        return i;
      }
    }
    // Out of chunk mid-varint. If the accumulator is already full, the byte that
    // filled it had its continuation flag set (a terminator returns above), so an
    // 11th byte is *required* — past the 10-byte / 64-bit maximum (§4.1.3). That
    // is decided by bytes already in hand, so it is INVALID now rather than a
    // suspend that {@link outcome} would report as INCOMPLETE: §5.2.3 gives INVALID
    // precedence, and the verdict must not depend on where the chunk boundaries
    // fell.
    if (k >= VARINT_MAX_BYTES) this.fail("varint overflow");
    this.vLo = lo;
    this.vHi = hi;
    this.vBytes = k;
    this.vComplete = false;
    return i;
  }

  /**
   * Decode the varint at `i` **if that needs no resume bookkeeping**, returning
   * the index past it, or `-1` when it does (leaving the accumulator untouched,
   * so the resumable ladder starts the word from scratch).
   *
   * Three cases, in the order they are worth testing:
   *
   * * ten bytes in hand — the unrolled {@link varintFull}, no bounds checks at
   *   all;
   * * a one-byte varint — every small id, length, count and scalar;
   * * a two-byte one — every id past 15, and mid-sized lengths and counts.
   *
   * Past that the word may straddle the chunk, and only the ladder can carry the
   * state across `feed` calls.
   */
  private varintQuick(input: Uint8Array, i: number, n: number): number {
    if (n - i >= VARINT_MAX_BYTES) return this.varintFull(input, i);
    if (i >= n) return -1;
    const b0 = input[i]!;
    if (b0 < 0x80) return this.setVarint(b0, 0, i + 1);
    if (i + 1 < n) {
      const b1 = input[i + 1]!;
      if (b1 < 0x80) return this.setVarint((b0 & 0x7f) | (b1 << 7), 0, i + 2);
      if (i + 2 < n) {
        const b2 = input[i + 2]!;
        if (b2 < 0x80) {
          return this.setVarint((b0 & 0x7f) | ((b1 & 0x7f) << 7) | (b2 << 14), 0, i + 3);
        }
      }
    }
    return -1;
  }

  /**
   * Decode one varint that is **guaranteed** to lie wholly within `input` — the
   * caller has checked that {@link VARINT_MAX_BYTES} bytes remain — into
   * {@link vLo} / {@link vHi}, returning the index past it.
   *
   * Unrolled and branch-per-byte: with the bytes known to be present there is no
   * bounds check, no resume counter and no `k`-dispatch per byte, which is the
   * whole per-byte cost of the resumable loop above. Reports the same `>64-bit`
   * overflow as that loop.
   */
  private varintFull(input: Uint8Array, i: number): number {
    let b = input[i]!;
    let lo = b & 0x7f;
    let hi = 0;
    if (b < 0x80) return this.setVarint(lo, 0, i + 1);

    b = input[i + 1]!;
    lo |= (b & 0x7f) << 7;
    if (b < 0x80) return this.setVarint(lo, 0, i + 2);

    b = input[i + 2]!;
    lo |= (b & 0x7f) << 14;
    if (b < 0x80) return this.setVarint(lo, 0, i + 3);

    b = input[i + 3]!;
    lo |= (b & 0x7f) << 21;
    if (b < 0x80) return this.setVarint(lo, 0, i + 4);

    // 5th byte straddles the 32-bit boundary: 4 bits to lo, 3 bits to hi.
    b = input[i + 4]!;
    lo |= (b & 0x0f) << 28;
    hi = (b >> 4) & 0x07;
    if (b < 0x80) return this.setVarint(lo, hi, i + 5);

    b = input[i + 5]!;
    hi |= (b & 0x7f) << 3;
    if (b < 0x80) return this.setVarint(lo, hi, i + 6);

    b = input[i + 6]!;
    hi |= (b & 0x7f) << 10;
    if (b < 0x80) return this.setVarint(lo, hi, i + 7);

    b = input[i + 7]!;
    hi |= (b & 0x7f) << 17;
    if (b < 0x80) return this.setVarint(lo, hi, i + 8);

    b = input[i + 8]!;
    hi |= (b & 0x7f) << 24;
    if (b < 0x80) return this.setVarint(lo, hi, i + 9);

    // 10th byte: only bit 63 (1 payload bit) remains below 64; any higher payload
    // bit, or a continuation into an 11th byte, is a >64-bit overflow.
    b = input[i + 9]!;
    if (((b & 0x7f) >> 1) !== 0) this.fail("varint overflow");
    hi |= (b & 0x7f) << 31;
    if (b < 0x80) return this.setVarint(lo, hi, i + 10);

    this.fail("varint overflow");
  }

  /** Publish a fully-decoded varint and the cursor past it (see {@link varintFull}). */
  private setVarint(lo: number, hi: number, i: number): number {
    this.vLo = lo;
    this.vHi = hi;
    this.vBytes = 0;
    this.vComplete = true;
    return i;
  }

  /**
   * The accumulated varint as an unsigned value, number-first: a `number` when it
   * fits exactly (`≤ 2^53-1`, which covers all ids, u8..u32 and small u64s), a
   * `bigint` only beyond that.
   */
  private vUnsigned(): number | bigint {
    // Unsigned: vHi's bit 31 must not read as negative. vHi ≤ 0x1fffff (2^21-1)
    // ⇔ vHi*2^32 + lo ≤ 2^53-1.
    const hi = this.vHi >>> 0;
    return hi <= 0x1fffff
      ? hi * TWO32 + (this.vLo >>> 0)
      : joinU64(this.vLo >>> 0, hi); // one bigint, not four (bits64)
  }

  /** The accumulated zig-zag varint as a signed value, number-first (see {@link vUnsigned}). */
  private vSigned(): number | bigint {
    const hi = this.vHi >>> 0;
    if (hi <= 0x1fffff) {
      const r = hi * TWO32 + (this.vLo >>> 0); // raw zig-zag, ≤ 2^53-1
      return r % 2 === 0 ? r / 2 : -(r + 1) / 2;
    }
    const lo = this.vLo >>> 0;
    const mask = -(lo & 1) >>> 0;
    return joinI64(
      ((((lo >>> 1) | (hi << 31)) >>> 0) ^ mask) >>> 0,
      ((hi >>> 1) ^ mask) >>> 0,
    );
  }

  /**
   * The accumulated varint as a JS number — exact for ids/lengths/counts.
   *
   * The `>>> 0` is load-bearing: `vHi` is accumulated with 32-bit bitwise ops, so
   * bit 63 of the varint lands on its sign bit and the value reads back negative,
   * sliding past the `count > ARRAY_MAX` guard.
   */
  private vNum(): number {
    return (this.vHi >>> 0) * TWO32 + (this.vLo >>> 0);
  }

  /** The accumulated varint with its low 3 tag bits stripped (`value >> 3`). */
  private vUpper(): number {
    return (this.vHi >>> 0) * (TWO32 / 8) + (this.vLo >>> 3);
  }

  /**
   * Deliver every float element that lies wholly inside this chunk, from
   * {@link arrIndex} on; returns the new read position.
   *
   * Its own method rather than a block inside {@link push}'s switch, and that is
   * measured: inlined, the two loops push `push` past what V8 keeps cheap and every
   * *other* decode path pays ~0.4% for code it never runs (`decode: typical` 5324 ->
   * 5344 Ir/op, `decode: u64 array` 706.6k -> 709.8k). Out of line the call is paid
   * once per drain, over a run of at least one element, and both figures come back.
   *
   * How many elements the chunk can still deliver decides the route. Past the
   * threshold, one handle (§6.6.2) beats the byte loads and pays for itself; below
   * it, building the handle costs more than the whole run saves. The two arms
   * produce identical values — the split is arithmetic, not semantics (see
   * {@link FP32_HANDLE_MIN}).
   */
  private fpDrain(
    input: Uint8Array,
    i: number,
    n: number,
    count: number,
    size: number,
    isFp32: boolean,
  ): number {
    const cur = this.cur;
    const id = this.id;
    let idx = this.arrIndex;
    if (Math.min(count - idx, (n - i) / size) >= (isFp32 ? FP32_HANDLE_MIN : FP64_HANDLE_MIN)) {
      const dv = this.dataView(input);
      do {
        if (isFp32) {
          // Two reads of the same four bytes: §6.5 needs the value *and* the exact
          // bits, and a double cannot carry an fp32 signaling NaN.
          cur.arrayFp32?.(id, idx, dv.getFloat32(i, true), dv.getUint32(i, true));
        } else {
          cur.arrayFp64?.(id, idx, dv.getFloat64(i, true));
        }
        i += size;
        this.arrIndex = ++idx;
      } while (idx < count && n - i >= size);
      return i;
    }
    do {
      const lo = u32le(input, i);
      if (isFp32) cur.arrayFp32?.(id, idx, fp32FromBits(lo), lo);
      else cur.arrayFp64?.(id, idx, fp64FromBits(lo, u32le(input, i + 4)));
      i += size;
      this.arrIndex = ++idx;
    } while (idx < count && n - i >= size);
    return i;
  }

  /**
   * The handle over `input`, built on demand and reused while the same chunk is
   * being fed (see {@link view}).
   */
  private dataView(input: Uint8Array): DataView {
    if (this.viewOf !== input) {
      this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      this.viewOf = input;
    }
    return this.view!;
  }

  /** Accumulate up to `need` raw float bytes into {@link fpLo} / {@link fpHi}. */
  private fpStep(input: Uint8Array, i: number, n: number): number {
    let have = this.have;
    const need = this.need;
    while (have < need && i < n) {
      const b = input[i++]!;
      if (have < 4) this.fpLo |= b << (have << 3);
      else this.fpHi |= b << ((have - 4) << 3);
      have++;
    }
    this.have = have;
    return i;
  }

  /** Start a fresh fp accumulation of `need` bytes. */
  private fpBegin(need: number): void {
    this.need = need;
    this.have = 0;
    this.fpLo = 0;
    this.fpHi = 0;
  }
}

/**
 * The four little-endian bytes at `i` as one unsigned 32-bit word — the float
 * routes that do not clear the {@link FP32_HANDLE_MIN} threshold read their raw
 * bits this way, with no handle over the chunk.
 */
function u32le(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}
