#!/usr/bin/env bash
#
# SofaBuffers TypeScript — machine-independent instruction cost.
#
# Runs each benchmark workload under Callgrind and reports instructions retired
# per operation (Ir/op). Unlike wall-clock or CPU time, instruction counts are
# deterministic and independent of the host's clock speed and scheduler, so the
# numbers compare across machines (and against the C/C++/Rust/Go/Python tools —
# the workloads, ids and values are identical).
#
# Because the workloads are JIT-compiled JS functions (not C symbols), Callgrind
# cannot `--toggle-collect` on them the way the C tool does. Instead each
# workload is run at two rep counts (R1, R2) and the counts are subtracted:
#
#     Ir/op = ( Ir(R2) - Ir(R1) ) / ( R2 - R1 )
#
# which cancels *all* fixed cost exactly — Node startup, compilation and the
# one-time per-workload setup — leaving the pure per-operation cost.
#
# Two details make that subtraction actually work under Callgrind:
#
#   * The benchmark is **bundled to plain JS first** and run with bare `node`.
#     Running it through `npx tsx` puts the workload in a *child* process, and
#     Callgrind does not trace children (`--trace-children=no` is the default),
#     so the counts came back measuring only the launcher — for this repo that
#     meant the table printed no rows at all.
#   * Node runs with `--predictable`, which pins V8 to a single thread with
#     synchronous compilation and GC. BENCH_SPEC asks for exactly this ("managed
#     runtimes should pin the JIT tier and disable GC so the fixed cost is
#     stable enough that the residual jitter is a negligible fraction"). Without
#     it, background compile/GC threads move the total by tens of millions of
#     instructions between two otherwise identical runs — far more than the
#     per-op signal being measured. With it, repeat runs agree to ~0.01%.
#
# Prereqs: valgrind, and `npm ci` (for esbuild, which ships with tsup).
# Usage:   bash bench/run_callgrind.sh          # every row, default rep counts
#          R1=500 R2=5500 bash bench/run_callgrind.sh
#          WORKLOADS="encode_composite decode_composite" bash bench/run_callgrind.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/bench/bench.ts"

# Rep counts, per workload shape. Both counts must sit *past* V8's tier-up, or
# the subtraction reports the JIT warming up instead of the steady-state per-op
# cost the table claims to show — and a warm-up-weighted number is not
# comparable with the compiled ports' Ir/op, which is the point of the tool.
#
# The rows that do bulk work per rep — the 1000-element arrays and the 245-chunk
# `blob 1MB` decode — are fully optimised within a few hundred reps (the array
# decode moves 0.8% between 200/1200 and 2000/12000). Everything built out of
# small per-field calls needs far more: measured on Node 24, `typical` falls by
# ~2.5x (encode) and ~6x (decode) going from 200/1200 to 2000/42000, and
# `composite` — 70-odd field calls per op, so it tiers up much later than its
# size suggests — reads 90.5k / 66.4k Ir/op (encode / skip-all) at 200/1200,
# 75.9k / 57.6k at 2000/12000 and 67.2k / 54.1k at 10000/60000, where it finally
# holds: the same figure the 12000→42000 marginal cost predicts. Hence its own
# rep pair rather than a shared "small message" one.
R1="${R1:-2000}"    # small-message workloads (typical)
R2="${R2:-42000}"
AR1="${AR1:-200}"   # bulk-per-rep workloads: the arrays and the blob decode
AR2="${AR2:-1200}"
CR1="${CR1:-10000}" # the composite rows (see above)
CR2="${CR2:-40000}"
BR1="${BR1:-1}"     # the two blob *encode* rows (see below)
BR2="${BR2:-3}"

if ! command -v valgrind >/dev/null 2>&1; then
    echo "error: valgrind not found (needed for instruction counts)." >&2
    echo "       install it, e.g.  apt-get install valgrind" >&2
    exit 1
fi
if (( R2 <= R1 )); then
    echo "error: R2 ($R2) must be greater than R1 ($R1)." >&2
    exit 1
fi
if (( AR2 <= AR1 )); then
    echo "error: AR2 ($AR2) must be greater than AR1 ($AR1)." >&2
    exit 1
fi
if (( BR2 <= BR1 )); then
    echo "error: BR2 ($BR2) must be greater than BR1 ($BR1)." >&2
    exit 1
fi
if (( CR2 <= CR1 )); then
    echo "error: CR2 ($CR2) must be greater than CR1 ($CR1)." >&2
    exit 1
fi

# The rep pair to use for a workload (see the R1/AR1/BR1 note above).
#
# The two blob *encode* rows take BENCH_SPEC's own advice (R1=1, R2=3): a
# megabyte of copying per op is slow under Callgrind, and the subtraction cancels
# fixed cost just as well at three reps as at three hundred. `decode: blob 1MB`
# is deliberately not in that class — a decode hands the visitor a window into
# the input and copies nothing, so its per-op cost is a walk over 245 chunks and
# a two-op delta would sit inside the run-to-run jitter.
reps_for() {
    case "$1" in
        encode_blob_oneshot|encode_blob_streaming) echo "$BR1 $BR2";;
        *u64_array|decode_blob)                    echo "$AR1 $AR2";;
        *composite|*composite_skip)                echo "$CR1 $CR2";;
        *)                                         echo "$R1 $R2";;
    esac
}

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
# BENCH_SPEC's table order. `encode: blob 1MB passthrough` is its one optional
# row and is absent: this port grants no pass-through permission, so every
# string/blob run is copied through the output buffer and the row is omitted
# rather than filled with a placeholder.
read -r -a WORKLOADS <<<"${WORKLOADS:-encode_u64_array encode_typical \
encode_blob_oneshot encode_blob_streaming encode_composite decode_u64_array \
decode_typical decode_blob decode_composite decode_composite_skip
decode_declined}"

BUNDLE="$OUT/bench.mjs"
if ! npx --no-install esbuild "$SCRIPT" --bundle --format=esm --platform=node \
        --target=node20 --outfile="$BUNDLE" --log-level=error; then
    echo "error: could not bundle $SCRIPT (esbuild missing? run 'npm ci')." >&2
    exit 1
fi

run_cg() { # $1 workload, $2 reps, $3 tag
    valgrind --tool=callgrind --callgrind-out-file="$OUT/$3.out" \
        node --predictable "$BUNDLE" "$1" "$2" >/dev/null 2>"$OUT/$3.log"
}

ir_of()    { grep -m1 '^summary:' "$OUT/$1.out" | awk '{print $2}'; }
bytes_of() { grep -ohE 'bytes=[0-9]+' "$OUT/$1.log" | head -1 | cut -d= -f2; }

label() {
    case "$1" in
        encode_u64_array)      echo "encode: u64 array (1000)";;
        encode_typical)        echo "encode: typical message";;
        encode_blob_oneshot)   echo "encode: blob 1MB one-shot";;
        encode_blob_streaming) echo "encode: blob 1MB streaming";;
        encode_composite)      echo "encode: composite";;
        decode_u64_array)      echo "decode: u64 array (1000)";;
        decode_typical)        echo "decode: typical message";;
        decode_blob)           echo "decode: blob 1MB";;
        decode_composite)      echo "decode: composite";;
        decode_composite_skip) echo "decode: composite skip-all";;
        decode_declined)       echo "decode: declined subtree";;
    esac
}

echo ">> Measuring instructions/op under Callgrind (messages R1=$R1 R2=$R2," \
     "arrays/blob decode R1=$AR1 R2=$AR2, composite R1=$CR1 R2=$CR2," \
     "blob encode R1=$BR1 R2=$BR2; this is slow) ..."
echo
echo "==============================================================================="
echo " SofaBuffers TypeScript instruction cost   (Callgrind, Ir/op)"
echo " instructions/op: lower is better. Deterministic & machine-independent."
echo "==============================================================================="
printf "%-26s %16s %9s\n" "Workload" "instr/op" "bytes"
printf "%-26s %16s %9s\n" "--------" "--------" "-----"

for w in "${WORKLOADS[@]}"; do
    read -r r1 r2 <<<"$(reps_for "$w")"
    ops=$(( r2 - r1 ))
    run_cg "$w" "$r1" "$w.lo"
    run_cg "$w" "$r2" "$w.hi"
    lo="$(ir_of "$w.lo")"; hi="$(ir_of "$w.hi")"
    b="$(bytes_of "$w.hi")"
    iperop="$(awk -v lo="${lo:-0}" -v hi="${hi:-0}" -v ops="$ops" \
        'BEGIN{ if (ops>0) printf "%d", (hi-lo)/ops; else print "-" }')"
    printf "%-26s %16s %9s\n" "$(label "$w")" "${iperop:--}" "${b:--}"
done
echo
echo "Ir = instructions retired (Callgrind). Independent of CPU clock and OS"
echo "scheduling; depends only on the executed code, so it compares across machines."
echo "The two blob encode rows are read against each other: their difference is what"
echo "the divisible-run flush path (CORELIB_PLAN 5.1) costs, bandwidth taken out."
