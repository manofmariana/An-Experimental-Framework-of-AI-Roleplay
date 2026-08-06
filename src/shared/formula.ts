/**
 * 世界包公式求值器：小型数学表达式语言（数字/标识符/+ − * / ^/括号/一元负号/
 * 函数 ln·exp·sqrt·abs·tanh·sigmoid·clamp·min·max/骰子项 NdM）编译为可复用闭包。
 * 解析期报语法/未知函数错（消息带表达式原文），未知变量求值期报错；
 * 骰子经结构化 `(face)=>number` 注入（不 import ports）。纯函数零 IO。
 *
 * 优先级（高→低）：函数字面/括号/骰子项 → ^（右结合）→ 一元负号 → * / → + −。
 * 一元负号优先级低于 ^：-x^2 = -(x^2)（数学惯例）；^ 右操作数允许一元负号：2^-2 = 1/4。
 * 骰子项 NdM / dM（N 省略 = 1；N/M 为正整数字面量）= N 个 M 面骰求和，
 * 求值按表达式从左到右逐骰消费注入的 DiceLike。
 */

/** 骰子端口（结构化本地类型，与 ports 的 DicePort 同形但不 import——shared 不依赖 src）。 */
export type DiceLike = (face: number) => number;

/** 编译后的可复用公式。 */
export interface CompiledFormula {
  /** 表达式原文 */
  readonly expr: string;
  /** 表达式引用的标识符去重列表（按首次出现顺序） */
  readonly variables: readonly string[];
  /** 求值：scope 缺变量抛错；含骰子项时 roll 必填（按从左到右逐骰消费）。 */
  evaluate(scope: Record<string, number>, roll?: DiceLike): number;
}

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

type Token =
  | { kind: "num"; value: number }
  | { kind: "dice"; n: number; m: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: string }
  | { kind: "eof" };

function tokenize(expr: string): Token[] {
  const fail = (msg: string): never => {
    throw new Error(`公式语法错误：${msg}（表达式：${expr}）`);
  };
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    const rest = expr.slice(i);
    // 数字，或紧跟 dM 的 NdM 骰子项（N 须为整数字面量）
    const num = /^\d+(?:\.\d+)?|^\.\d+/.exec(rest)?.[0];
    if (num !== undefined) {
      const dice = !num.includes(".") && /^d\d+/.exec(rest.slice(num.length))?.[0];
      if (dice) {
        const n = Number(num);
        const m = Number(dice.slice(1));
        if (n <= 0 || m <= 0) fail(`骰子项 ${num}${dice} 的 N/M 须为正整数`);
        tokens.push({ kind: "dice", n, m });
        i += num.length + dice.length;
      } else {
        tokens.push({ kind: "num", value: Number(num) });
        i += num.length;
      }
      continue;
    }
    // dM 骰子项（N 省略 = 1）；d 后非数字则按标识符处理
    const loneDice = /^d(\d+)/.exec(rest)?.[0];
    if (loneDice !== undefined) {
      tokens.push({ kind: "dice", n: 1, m: Number(loneDice.slice(1)) });
      i += loneDice.length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
    if (ident !== undefined) {
      tokens.push({ kind: "ident", name: ident });
      i += ident.length;
      continue;
    }
    if ("+-*/^(),".includes(ch)) {
      tokens.push({ kind: "op", op: ch });
      i++;
      continue;
    }
    fail(`无法识别的字符 "${ch}"`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

// ---------------------------------------------------------------------------
// 语法（递归下降；优先级见文件头）
// ---------------------------------------------------------------------------

type Node =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "dice"; n: number; m: number }
  | { kind: "neg"; arg: Node }
  | { kind: "bin"; op: "+" | "-" | "*" | "/" | "^"; l: Node; r: Node }
  | { kind: "call"; fn: string; args: Node[] };

/** 函数库：arity = 定参个数；"variadic" = 可变参（至少 1 个）。 */
const FUNCTIONS: Record<string, { arity: number | "variadic"; fn: (...args: number[]) => number }> = {
  ln: { arity: 1, fn: Math.log },
  exp: { arity: 1, fn: Math.exp },
  sqrt: { arity: 1, fn: Math.sqrt },
  abs: { arity: 1, fn: Math.abs },
  tanh: { arity: 1, fn: Math.tanh },
  sigmoid: { arity: 1, fn: (x) => 1 / (1 + Math.exp(-x)) },
  clamp: { arity: 3, fn: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  min: { arity: "variadic", fn: (...args) => Math.min(...args) },
  max: { arity: "variadic", fn: (...args) => Math.max(...args) },
};

function parse(expr: string, tokens: Token[]): Node {
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const fail = (msg: string): never => {
    throw new Error(`公式语法错误：${msg}（表达式：${expr}）`);
  };
  const expectOp = (op: string): void => {
    const t = peek();
    if (t.kind !== "op" || t.op !== op) fail(`期望 "${op}"`);
    pos++;
  };

  const parsePrimary = (): Node => {
    const t = peek();
    if (t.kind === "num") { pos++; return { kind: "num", value: t.value }; }
    if (t.kind === "dice") { pos++; return { kind: "dice", n: t.n, m: t.m }; }
    if (t.kind === "ident") {
      pos++;
      if (peek().kind === "op" && (peek() as { op: string }).op === "(") {
        // 函数调用：解析期校验函数名与参数个数
        const spec = FUNCTIONS[t.name];
        if (spec === undefined) return fail(`未知函数 "${t.name}"`);
        pos++;
        const args: Node[] = [];
        if (!(peek().kind === "op" && (peek() as { op: string }).op === ")")) {
          for (;;) {
            args.push(parseAddSub());
            const sep = peek();
            if (sep.kind === "op" && sep.op === ",") { pos++; continue; }
            break;
          }
        }
        expectOp(")");
        if (spec.arity === "variadic") {
          if (args.length === 0) fail(`函数 ${t.name} 至少需要 1 个参数`);
        } else if (args.length !== spec.arity) {
          fail(`函数 ${t.name} 需要 ${spec.arity} 个参数，收到 ${args.length}`);
        }
        return { kind: "call", fn: t.name, args };
      }
      return { kind: "var", name: t.name };
    }
    if (t.kind === "op" && t.op === "(") {
      pos++;
      const inner = parseAddSub();
      expectOp(")");
      return inner;
    }
    return fail(t.kind === "eof" ? "表达式意外结束" : `此处不允许 "${t.kind === "op" ? t.op : ""}"`);
  };

  // ^ 右结合；右操作数走 unary 以允许 2^-2
  const parsePower = (): Node => {
    const base = parsePrimary();
    const t = peek();
    if (t.kind === "op" && t.op === "^") {
      pos++;
      return { kind: "bin", op: "^", l: base, r: parseUnary() };
    }
    return base;
  };

  const parseUnary = (): Node => {
    const t = peek();
    if (t.kind === "op" && t.op === "-") {
      pos++;
      return { kind: "neg", arg: parseUnary() };
    }
    return parsePower();
  };

  const parseMulDiv = (): Node => {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.kind === "op" && (t.op === "*" || t.op === "/")) {
        pos++;
        left = { kind: "bin", op: t.op, l: left, r: parseUnary() };
      } else return left;
    }
  };

  const parseAddSub = (): Node => {
    let left = parseMulDiv();
    for (;;) {
      const t = peek();
      if (t.kind === "op" && (t.op === "+" || t.op === "-")) {
        pos++;
        left = { kind: "bin", op: t.op, l: left, r: parseMulDiv() };
      } else return left;
    }
  };

  const root = parseAddSub();
  if (peek().kind !== "eof") fail("表达式末尾有多余内容");
  return root;
}

// ---------------------------------------------------------------------------
// 编译与求值
// ---------------------------------------------------------------------------

/**
 * 编译表达式为可复用公式。语法错误/未知函数/参数个数错误解析期抛出（消息带表达式原文）；
 * variables 为表达式引用的标识符去重列表（按首次出现顺序，供调用方做变量闭包校验）。
 */
export function compileFormula(expr: string): CompiledFormula {
  const root = parse(expr, tokenize(expr));
  const variables: string[] = [];
  const seen = new Set<string>();
  const collect = (node: Node): void => {
    switch (node.kind) {
      case "var":
        if (!seen.has(node.name)) { seen.add(node.name); variables.push(node.name); }
        break;
      case "neg":
        collect(node.arg);
        break;
      case "bin":
        collect(node.l);
        collect(node.r);
        break;
      case "call":
        for (const arg of node.args) collect(arg);
        break;
      default:
        break;
    }
  };
  collect(root);

  const evalNode = (node: Node, scope: Record<string, number>, roll?: DiceLike): number => {
    switch (node.kind) {
      case "num":
        return node.value;
      case "var":
        if (!Object.hasOwn(scope, node.name)) {
          throw new Error(`公式求值失败：变量 "${node.name}" 未提供（表达式：${expr}）`);
        }
        return scope[node.name]!;
      case "dice": {
        if (roll === undefined) {
          throw new Error(`公式求值失败：骰子项 ${node.n}d${node.m} 需要骰子端口（表达式：${expr}）`);
        }
        let sum = 0;
        for (let k = 0; k < node.n; k++) sum += roll(node.m);
        return sum;
      }
      case "neg":
        return -evalNode(node.arg, scope, roll);
      case "bin": {
        // 左先右后：骰子项按表达式从左到右消费骰子端口
        const l = evalNode(node.l, scope, roll);
        const r = evalNode(node.r, scope, roll);
        switch (node.op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/": return l / r;
          case "^": return l ** r;
        }
        break;
      }
      case "call":
        return FUNCTIONS[node.fn]!.fn(...node.args.map((a) => evalNode(a, scope, roll)));
    }
  };

  return { expr, variables, evaluate: (scope, roll) => evalNode(root, scope, roll) };
}
