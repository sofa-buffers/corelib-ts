/**
 * A minimal JSON parser that yields `bigint` for integer literals and `number`
 * for fractional/exponent literals.
 *
 * The shared `test_vectors.json` contains exact 64-bit literals (e.g.
 * `18446744073709551615`, `-9223372036854775808`) that the built-in
 * `JSON.parse` would silently round on Node < 21. This recursive-descent parser
 * preserves them: a numeric token is a `bigint` unless it contains `.`, `e` or
 * `E`, in which case it is a `number`.
 */

export type Json = bigint | number | string | boolean | null | Json[] | { [k: string]: Json };

export function parseJsonWithBigInt(text: string): Json {
  let i = 0;

  function ws(): void {
    while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\t" || text[i] === "\r")) i++;
  }

  function value(): Json {
    ws();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return str();
    if (c === "t" || c === "f") return bool();
    if (c === "n") return nul();
    return num();
  }

  function object(): { [k: string]: Json } {
    const obj: { [k: string]: Json } = {};
    i++; // {
    ws();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      ws();
      const key = str();
      ws();
      i++; // :
      obj[key] = value();
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      i++; // }
      return obj;
    }
  }

  function array(): Json[] {
    const arr: Json[] = [];
    i++; // [
    ws();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(value());
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      i++; // ]
      return arr;
    }
  }

  function str(): string {
    let out = "";
    i++; // opening quote
    for (;;) {
      const c = text[i++]!;
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++]!;
        if (e === "u") {
          out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else {
          out += { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e] ?? e;
        }
      } else {
        out += c;
      }
    }
  }

  function num(): bigint | number {
    const start = i;
    if (text[i] === "-") i++;
    while (i < text.length && /[0-9.eE+\-]/.test(text[i]!)) i++;
    const lit = text.slice(start, i);
    if (/[.eE]/.test(lit)) return Number(lit);
    if (lit === "-0") return -0; // preserve negative zero (matters for float vectors)
    return BigInt(lit);
  }

  function bool(): boolean {
    if (text[i] === "t") {
      i += 4;
      return true;
    }
    i += 5;
    return false;
  }

  function nul(): null {
    i += 4;
    return null;
  }

  return value();
}
