/**
 * Size formulas — "how much of each material does THIS window need".
 *
 * A made-to-measure blind's materials all depend on its size: the head rail
 * is as long as the blind is wide, the slat count follows the drop, the
 * ladders follow the width. Every manufacturer has its own deductions and
 * pitches, so these are formulas the shop writes on the BOM, not rules baked
 * into code:
 *
 *     Head rail (ft)      W_FT
 *     Slats (pcs)         CEIL(H_IN / SLAT_PITCH)
 *     Ladders (pcs)       CEIL(W_IN / 24)
 *     Fabric (m)          CEIL(W * FULLNESS / FABRIC_W) * (H + 12) * 0.0254
 *
 * Deliberately NOT eval(): a formula is data typed by a person and stored in
 * the cloud, so it is parsed by a small grammar that can only do arithmetic,
 * compare, and call a fixed list of functions. Errors carry the column, so
 * the BOM screen can point at the mistake.
 *
 * Grammar (case-insensitive names):
 *   expr    := compare
 *   compare := sum (( "<" | "<=" | ">" | ">=" | "=" | "==" | "!=" | "<>" ) sum)?
 *   sum     := product (("+" | "-") product)*
 *   product := unary (("*" | "/" | "%") unary)*
 *   unary   := ("-" | "+") unary | power
 *   power   := primary ("^" unary)?
 *   primary := number | name | name "(" args ")" | "(" expr ")"
 */
import { convertLength, type LengthUnit } from "@/lib/units";

export class FormulaError extends Error {
  /** 0-based position in the formula text where the problem is. */
  pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

type Node =
  | { k: "num"; v: number }
  | { k: "var"; name: string; pos: number }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node; pos: number }
  | { k: "call"; name: string; args: Node[]; pos: number };

type Tok = { t: "num" | "name" | "op" | "(" | ")" | "," | "end"; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaError(`"${c}" is not a number`, i);
      out.push({ t: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "name", v: m[0].toUpperCase(), pos: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "<>"].includes(two)) {
      out.push({ t: "op", v: two === "<>" ? "!=" : two === "==" ? "=" : two, pos: i });
      i += 2;
      continue;
    }
    if ("+-*/%^<>=".includes(c)) {
      out.push({ t: "op", v: c, pos: i });
      i++;
      continue;
    }
    // "×" and "÷" are what people actually type from a phone keyboard.
    if (c === "×" || c === "÷") {
      out.push({ t: "op", v: c === "×" ? "*" : "/", pos: i });
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      out.push({ t: c, v: c, pos: i });
      i++;
      continue;
    }
    throw new FormulaError(`"${c}" cannot be used in a formula`, i);
  }
  out.push({ t: "end", v: "", pos: src.length });
  return out;
}

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const expectClose = (open: Tok) => {
    const t = take();
    if (t.t !== ")") throw new FormulaError(`missing ")" for the "(" here`, open.pos);
  };

  const primary = (): Node => {
    const t = take();
    if (t.t === "num") return { k: "num", v: Number(t.v) };
    if (t.t === "name") {
      if (peek().t === "(") {
        const open = take();
        const args: Node[] = [];
        if (peek().t !== ")") {
          args.push(compare());
          while (peek().t === ",") {
            take();
            args.push(compare());
          }
        }
        expectClose(open);
        return { k: "call", name: t.v, args, pos: t.pos };
      }
      return { k: "var", name: t.v, pos: t.pos };
    }
    if (t.t === "(") {
      const e = compare();
      expectClose(t);
      return e;
    }
    if (t.t === "end") throw new FormulaError("the formula ends too early", t.pos);
    throw new FormulaError(`"${t.v}" is not expected here`, t.pos);
  };
  const power = (): Node => {
    const a = primary();
    if (peek().t === "op" && peek().v === "^") {
      const op = take();
      return { k: "bin", op: "^", a, b: unary(), pos: op.pos };
    }
    return a;
  };
  const unary = (): Node => {
    const t = peek();
    if (t.t === "op" && (t.v === "-" || t.v === "+")) {
      take();
      const a = unary();
      return t.v === "-" ? { k: "neg", a } : a;
    }
    return power();
  };
  const product = (): Node => {
    let a = unary();
    while (peek().t === "op" && "*/%".includes(peek().v)) {
      const op = take();
      a = { k: "bin", op: op.v, a, b: unary(), pos: op.pos };
    }
    return a;
  };
  const sum = (): Node => {
    let a = product();
    while (peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = take();
      a = { k: "bin", op: op.v, a, b: product(), pos: op.pos };
    }
    return a;
  };
  const compare = (): Node => {
    const a = sum();
    const t = peek();
    if (t.t === "op" && ["<", "<=", ">", ">=", "=", "!="].includes(t.v)) {
      take();
      return { k: "bin", op: t.v, a, b: sum(), pos: t.pos };
    }
    return a;
  };

  if (!src.trim()) throw new FormulaError("the formula is empty", 0);
  const tree = compare();
  const rest = peek();
  if (rest.t !== "end") throw new FormulaError(`"${rest.v}" is not expected here`, rest.pos);
  return tree;
}

/** Round x UP to the next multiple of step (step 1 = next whole number). */
const ceilTo = (x: number, step = 1) => (step ? Math.ceil(x / step - 1e-9) * step : x);
const floorTo = (x: number, step = 1) => (step ? Math.floor(x / step + 1e-9) * step : x);

const FUNCS: Record<
  string,
  { min: number; max: number; f: (...a: number[]) => number; help: string }
> = {
  CEIL: {
    min: 1,
    max: 2,
    f: (x, s = 1) => ceilTo(x, s),
    help: "CEIL(x) rounds up; CEIL(x, 0.5) to the next half",
  },
  ROUNDUP: { min: 1, max: 2, f: (x, s = 1) => ceilTo(x, s), help: "same as CEIL" },
  FLOOR: { min: 1, max: 2, f: (x, s = 1) => floorTo(x, s), help: "FLOOR(x) rounds down" },
  ROUNDDOWN: { min: 1, max: 2, f: (x, s = 1) => floorTo(x, s), help: "same as FLOOR" },
  ROUND: {
    min: 1,
    max: 2,
    f: (x, d = 0) => {
      const m = 10 ** d;
      return Math.round(x * m + (x >= 0 ? 1e-9 : -1e-9)) / m;
    },
    help: "ROUND(x) or ROUND(x, 2 decimals)",
  },
  MIN: { min: 1, max: 99, f: (...a) => Math.min(...a), help: "MIN(a, b, …)" },
  MAX: { min: 1, max: 99, f: (...a) => Math.max(...a), help: "MAX(a, b, …)" },
  ABS: { min: 1, max: 1, f: (x) => Math.abs(x), help: "ABS(x)" },
  SQRT: { min: 1, max: 1, f: (x) => Math.sqrt(x), help: "SQRT(x)" },
  IF: { min: 3, max: 3, f: (c, a, b) => (c ? a : b), help: "IF(condition, then, else)" },
};

function run(n: Node, vars: Record<string, number>): number {
  switch (n.k) {
    case "num":
      return n.v;
    case "var": {
      const v = vars[n.name];
      if (v === undefined)
        throw new FormulaError(
          `"${n.name}" is not known — check the spelling or add it in Settings`,
          n.pos,
        );
      return v;
    }
    case "neg":
      return -run(n.a, vars);
    case "call": {
      const fn = FUNCS[n.name];
      if (!fn) throw new FormulaError(`"${n.name}(…)" is not a function here`, n.pos);
      if (n.args.length < fn.min || n.args.length > fn.max)
        throw new FormulaError(`${n.name} needs ${fn.help}`, n.pos);
      // IF evaluates only the branch it takes, so IF(W > 0, H / W, 0) is safe.
      if (n.name === "IF")
        return run(n.args[0], vars) ? run(n.args[1], vars) : run(n.args[2], vars);
      return fn.f(...n.args.map((a) => run(a, vars)));
    }
    case "bin": {
      const a = run(n.a, vars);
      const b = run(n.b, vars);
      switch (n.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new FormulaError("divides by zero here", n.pos);
          return a / b;
        case "%":
          if (b === 0) throw new FormulaError("divides by zero here", n.pos);
          return a % b;
        case "^":
          return a ** b;
        case "<":
          return a < b ? 1 : 0;
        case "<=":
          return a <= b ? 1 : 0;
        case ">":
          return a > b ? 1 : 0;
        case ">=":
          return a >= b ? 1 : 0;
        case "=":
          return Math.abs(a - b) < 1e-9 ? 1 : 0;
        case "!=":
          return Math.abs(a - b) < 1e-9 ? 0 : 1;
      }
    }
  }
  throw new FormulaError("cannot work this out", 0);
}

const cache = new Map<string, Node | FormulaError>();
function compiled(src: string): Node {
  let c = cache.get(src);
  if (!c) {
    try {
      c = parse(src);
    } catch (e) {
      c = e instanceof FormulaError ? e : new FormulaError(String(e), 0);
    }
    if (cache.size > 500) cache.clear();
    cache.set(src, c);
  }
  if (c instanceof FormulaError) throw c;
  return c;
}

/** Work a formula out. Throws FormulaError (with .pos) when it cannot. A bare
 *  number ("2") is a formula too — a fixed quantity. */
export function evaluate(src: string, vars: Record<string, number>): number {
  const v = run(compiled(String(src)), vars);
  if (!Number.isFinite(v)) throw new FormulaError("the answer is not a number", 0);
  return v;
}

/** The same, but never throws: `{ value }` or `{ error, pos }`. */
export function tryEvaluate(
  src: string,
  vars: Record<string, number>,
):
  | { value: number; error?: undefined; pos?: undefined }
  | { value?: undefined; error: string; pos: number } {
  try {
    return { value: evaluate(src, vars) };
  } catch (e) {
    if (e instanceof FormulaError) return { error: e.message, pos: e.pos };
    return { error: String((e as Error)?.message ?? e), pos: 0 };
  }
}

/** Only checks the formula is well-formed (spelling of names aside). */
export function syntaxError(src: string): { error: string; pos: number } | null {
  try {
    compiled(String(src));
    return null;
  } catch (e) {
    return e instanceof FormulaError
      ? { error: e.message, pos: e.pos }
      : { error: String(e), pos: 0 };
  }
}

/** A measured size, in the unit it was measured in. */
export interface MeasuredSize {
  w: number;
  h: number;
  unit: LengthUnit;
}

/**
 * The names a size formula can use for one measured window:
 *   W, H        in the unit the formulas are written in (`formulaUnit`)
 *   W_IN … H_M  the same size in every length unit
 *   SQFT, SQM   its area
 *   QTY         how many of them (pieces)
 * plus any extra inputs (FULLNESS, SEATS…) and Settings constants.
 * Later sources win, so a template input can override a global constant.
 */
export function sizeVars(
  size: MeasuredSize,
  formulaUnit: LengthUnit,
  extra: Record<string, number> = {},
  qty = 1,
): Record<string, number> {
  const v: Record<string, number> = {};
  const w = Number(size.w) || 0;
  const h = Number(size.h) || 0;
  for (const u of ["in", "ft", "cm", "m", "mm"] as LengthUnit[]) {
    v[`W_${u.toUpperCase()}`] = convertLength(w, size.unit, u);
    v[`H_${u.toUpperCase()}`] = convertLength(h, size.unit, u);
  }
  v.W = convertLength(w, size.unit, formulaUnit);
  v.H = convertLength(h, size.unit, formulaUnit);
  v.SQFT = v.W_FT * v.H_FT;
  v.SQM = v.W_M * v.H_M;
  v.QTY = qty;
  for (const [k, val] of Object.entries(extra)) v[k.toUpperCase()] = Number(val) || 0;
  return v;
}

/** Names offered in the BOM screen's help, in the order a person needs them. */
export const FORMULA_HELP = {
  names: [
    ["W, H", "width / height, in the unit the formulas are written in"],
    ["W_IN, W_FT, W_CM, W_M, W_MM", "width in each unit (same for H_…)"],
    ["SQFT, SQM", "area of one piece"],
    ["QTY", "how many pieces"],
  ],
  functions: Object.entries(FUNCS)
    .filter(([k]) => !["ROUNDUP", "ROUNDDOWN"].includes(k))
    .map(([k, f]) => [k, f.help]),
};
