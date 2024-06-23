import * as ohm from "ohm-js";
import { describe, expect, it } from "vitest";

import type { bytes, Symbol } from "./chapter05.js";

import {
  buildModule,
  buildSymbolTable,
  code,
  codesec,
  defineFunctionDecls,
  export_,
  exportdesc,
  exportsec,
  func,
  funcidx,
  funcsec,
  functype,
  i32,
  instr,
  loadMod,
  localidx,
  locals,
  module,
  resolveSymbol,
  typeidx,
  typesec,
  u32,
  valtype,
} from "./chapter05.js";

const grammarDef = `
  Wafer {
    Module = FunctionDecl*

    Statement = LetStatement
              | IfStatement
              | WhileStatement
              | ExprStatement

    LetStatement = let identifier "=" Expr ";"

    IfStatement = if Expr BlockStatements (else (BlockStatements | IfStatement))?

    WhileStatement = while Expr BlockStatements

    FunctionDecl = func identifier "(" Params? ")" BlockExpr

    Params = identifier ("," identifier)*

    BlockExpr = "{" Statement* Expr "}"

    BlockStatements = "{" Statement* "}"

    ExprStatement = Expr ";"

    Expr = AssignmentExpr  -- assignment
          | PrimaryExpr (binaryOp PrimaryExpr)*  -- binary

    AssignmentExpr = identifier ":=" Expr

    PrimaryExpr = number  -- num
                | CallExpr
                | identifier  -- var
                | IfExpr

    CallExpr = identifier "(" Args? ")"

    Args = Expr ("," Expr)*

    IfExpr = if Expr BlockExpr else (BlockExpr | IfExpr)

    binaryOp = "+" | "-" | compareOp | logicalOp
    compareOp = "==" | "!=" | "<=" | "<" | ">=" | ">"
    logicalOp = and | or
    number = digit+

    keyword = if | else | func | let | and | or | while
    if = "if" ~identPart
    else = "else" ~identPart
    func = "func" ~identPart
    let = "let" ~identPart
    and = "and" ~identPart
    or = "or" ~identPart
    while = "while" ~identPart

    identifier = ~keyword identStart identPart*
    identStart = letter | "_"
    identPart = identStart | digit
  }
`;

const wafer = ohm.grammar(grammarDef);

const blocktype = { empty: 0x40, ...valtype };

const labelidx = u32;

function defineToWasm(semantics: ohm.Semantics, symbols: Scope) {
  const scopes = [symbols];
  semantics.addOperation("toWasm", {
    FunctionDecl(_func, ident, _lparen, optParams, _rparen, blockExpr) {
      scopes.push(symbols.get(ident.sourceString)! as Scope);
      const result = [blockExpr.toWasm(), instr.end];
      scopes.pop();
      return result;
    },
    BlockExpr(_lbrace, iterStatement, expr, _rbrace) {
      return [...iterStatement.children, expr].map((c) => c.toWasm());
    },
    BlockStatements(_lbrace, iterStatement, _rbrace) {
      return iterStatement.children.map((c) => c.toWasm());
    },
    LetStatement(_let, ident, _eq, expr, _) {
      const info = resolveSymbol(ident, scopes.at(-1)! as Map<string, Symbol>);
      return [expr.toWasm(), instr.local.set, localidx(info.idx)];
    },
    IfStatement(_if, expr, thenBlock, _else, iterElseBlock) {
      const elseFrag = iterElseBlock.child(0)
        ? [instr.else, iterElseBlock.child(0).toWasm()]
        : [];
      return [
        expr.toWasm(),
        [instr.if, blocktype.empty],
        thenBlock.toWasm(),
        elseFrag,
        instr.end,
      ];
    },
    WhileStatement(_while, cond, body) {
      return [
        [instr.loop, blocktype.empty],
        cond.toWasm(),
        [instr.if, blocktype.empty],
        body.toWasm(),
        [instr.br, 1],
        instr.end,
        instr.end,
      ];
    },
    ExprStatement(expr, _) {
      return [expr.toWasm(), instr.drop];
    },
    Expr_binary(num, iterOps, iterOperands) {
      const result = [num.toWasm()];
      for (let i = 0; i < iterOps.numChildren; i++) {
        const op = iterOps.child(i);
        const operand = iterOperands.child(i);
        result.push(operand.toWasm(), op.toWasm());
      }
      return result;
    },
    AssignmentExpr(ident, _, expr) {
      const info = resolveSymbol(ident, scopes.at(-1)! as Map<string, Symbol>);
      return [expr.toWasm(), instr.local.tee, localidx(info.idx)];
    },
    CallExpr(ident, _lparen, optArgs, _rparen) {
      const name = ident.sourceString;
      const funcNames = Array.from(scopes[0].keys());
      const idx = funcNames.indexOf(name);
      return [
        optArgs.children.map((c) => c.toWasm()),
        [instr.call, funcidx(idx)],
      ];
    },
    Args(exp, _, iterExp) {
      return [exp, ...iterExp.children].map((c) => c.toWasm());
    },
    IfExpr(_if, cond, thenBlock, _else, elseBlock) {
      return [
        cond.toWasm(),
        [instr.if, blocktype.i32],
        thenBlock.toWasm(),
        instr.else,
        elseBlock.toWasm(),
        instr.end,
      ];
    },
    PrimaryExpr_var(ident) {
      const info = resolveSymbol(ident, scopes.at(-1)! as Map<string, Symbol>);
      return [instr.local.get, localidx(info.idx)];
    },
    binaryOp(char) {
      const op = char.sourceString;
      const instructionByOp: Record<string, number> = {
        "+": instr.i32.add,
        "-": instr.i32.sub,
        "==": instr.i32.eq,
        "!=": instr.i32.ne,
        "<": instr.i32.lt_s,
        "<=": instr.i32.le_s,
        ">": instr.i32.gt_s,
        ">=": instr.i32.ge_s,
        and: instr.i32.and,
        or: instr.i32.or,
      };
      if (!Object.hasOwn(instructionByOp, op)) {
        throw new Error(`Unhandled binary op '${op}'`);
      }
      return instructionByOp[op];
    },
    number(_digits) {
      const num = parseInt(this.sourceString, 10);
      return [instr.i32.const, ...i32(num)];
    },
  });
}

function compile(source: string) {
  const matchResult = wafer.match(source);
  if (!matchResult.succeeded()) {
    throw new Error(matchResult.message);
  }

  const symbols = buildSymbolTable(wafer, matchResult);
  const semantics = wafer.createSemantics();
  defineToWasm(semantics, symbols);
  defineFunctionDecls(semantics, symbols);

  const functionDecls = semantics(matchResult).functionDecls();
  return buildModule(functionDecls);
}

if (import.meta.vitest) {
  describe("compile", () => {
    it("if expressions", () => {
      let mod = loadMod(compile("func choose(x) { if x { 42 } else { 43 } }"));
      expect(mod.choose(1)).toBe(42);
      expect(mod.choose(0)).toBe(43);

      mod = loadMod(
        compile(`
            func isZero(x) {
              let result = if x { 0 } else { 1 };
              result
            }
          `)
      );
      expect(mod.isZero(1)).toBe(0);
      expect(mod.isZero(0)).toBe(1);
    });

    it("comparison operators", () => {
      const mod = loadMod(
        compile(`
          func greaterThan(a, b) { a > b }
          func lessThan(a, b) { a < b }
          func greaterThanOrEq(a, b) { a >= b }
          func lessThanOrEq(a, b) { a <= b }
          func eq(a, b) { a == b }
          func and_(a, b) { a and b }
          func or_(a, b) { a or b }
        `)
      );
      expect(mod.greaterThan(43, 42)).toBe(1);
      expect(mod.greaterThan(42, 43)).toBe(0);
      expect(mod.lessThan(43, 42)).toBe(0);
      expect(mod.greaterThanOrEq(42, 42)).toBe(1);
      expect(mod.lessThanOrEq(42, 43)).toBe(1);
      expect(mod.eq(42, 42)).toBe(1);
      expect(mod.and_(1, 1)).toBe(1);
      expect(mod.and_(1, 0)).toBe(0);
      expect(mod.or_(1, 0)).toBe(1);
      expect(mod.or_(0, 1)).toBe(1);
    });

    it("while loops", () => {
      const mod = loadMod(
        compile(`
              func countTo(n) {
                let x = 0;
                while x < n {
                  x := x + 1;
                }
                x
              }
            `)
      );
      expect(mod.countTo(10)).toBe(10);
    });

    it("conditionals, comparisons, and loops", () => {
      const mod = loadMod(
        compile(`
          func countTo(n) {
            let x = 0;
            while x < n {
              if x < 62 { x := x + 1; }
            }
            x
          }
          func compare(a, b) {
            if a < b { 0 - 1 } else if a > b { 1 } else { 0 }
          }

        `)
      );
      expect(mod.countTo(10)).toBe(10);
      expect(mod.countTo(-1)).toBe(0);
      expect(mod.compare(1, 2)).toBe(-1);
      expect(mod.compare(62, 2)).toBe(1);
      expect(mod.compare(62, 62)).toBe(0);
    });
  });
}

export * from "./chapter05.js";
export { blocktype };
