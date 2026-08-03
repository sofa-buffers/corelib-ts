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
# Usage:   bash bench/run_callgrind.sh          # defaults R1=200 R2=1200
#          R1=500 R2=5500 bash bench/run_callgrind.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/bench/bench.ts"

# Rep counts, per workload shape. Both counts must sit *past* V8's tier-up, or
# the subtraction reports the JIT warming up instead of the steady-state per-op
# cost the table claims to show — and a warm-up-weighted number is not
# comparable with the compiled ports' Ir/op, which is the point of the tool.
#
# The two message workloads do one small message per rep, so they need tens of
# thousands of reps to get there; the two array workloads run 1000 elements per
# rep and are fully optimised within a few hundred. Measured on Node 24, the
# small-message figures fall by ~2.5x (encode) and ~6x (decode) going from
# 200/1200 to the defaults below, then hold steady — that spread was warm-up.
R1="${R1:-2000}"    # message workloads
R2="${R2:-42000}"
AR1="${AR1:-200}"   # 1000-element array workloads
AR2="${AR2:-1200}"

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

# The rep pair to use for a workload (see the R1/AR1 note above).
reps_for() {
    case "$1" in
        *u64_array) echo "$AR1 $AR2";;
        *)          echo "$R1 $R2";;
    esac
}

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
WORKLOADS=(encode_u64_array encode_typical decode_u64_array decode_typical)

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
        encode_u64_array) echo "encode: u64 array (1000)";;
        encode_typical)   echo "encode: typical message";;
        decode_u64_array) echo "decode: u64 array (1000)";;
        decode_typical)   echo "decode: typical message";;
    esac
}

echo ">> Measuring instructions/op under Callgrind (messages R1=$R1 R2=$R2," \
     "arrays R1=$AR1 R2=$AR2; this is slow) ..."
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
