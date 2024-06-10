import * as ohm from "ohm-js";
import { describe, expect, it } from "vitest";

import type { bytes, Symbol } from "./chapter04.ts";

import {
  code,
  codesec,
  export_,
  exportdesc,
  exportsec,
  flatten,
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
  valtype,
} from "./chapter04.js";

type Scope = Map<string, Symbol | Scope>;

type FunctionDecl = {
  name: string;
  paramTypes: number[];
  resultType: number;
  locals: bytes;
  body: bytes;
};

function buildModule(functionDecls: FunctionDecl[]) {
  const types = functionDecls.map((f) =>
    functype(f.paramTypes, [f.resultType])
  );
  const funcs = functionDecls.map((f, i) => typeidx(i));
  const codes = functionDecls.map((f) => code(func(f.locals, f.body)));
  const exports = functionDecls.map((f, i) =>
    export_(f.name, exportdesc.func(i))
  );

  const mod = module([
    typesec(types),
    funcsec(funcs),
    exportsec(exports),
    codesec(codes),
  ]);
  return Uint8Array.from(flatten(mod));
}

const grammarDef = `
  Wafer {
    Module = FunctionDecl*

    Statement = LetStatement
              | ExprStatement

    LetStatement = "let" identifier "=" Expr ";"

    FunctionDecl = "func" identifier "(" Params? ")" BlockExpr

    Params = identifier ("," identifier)*

    BlockExpr = "{" Statement* Expr"}"

    ExprStatement = Expr ";"

    Expr = AssignmentExpr  -- assignment
          | PrimaryExpr (op PrimaryExpr)*  -- arithmetic

    AssignmentExpr = identifier ":=" Expr

    PrimaryExpr = number  -- num
                | CallExpr
                | identifier  -- var

    CallExpr = identifier "(" Args? ")"

    Args = Expr ("," Expr)*

    op = "+" | "-"
    number = digit+

    identifier = identStart identPart*
    identStart = letter | "_"
    identPart = identStart | digit
  }
`;

const wafer = ohm.grammar(grammarDef);

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
    LetStatement(_let, ident, _eq, expr, _) {
      const info = resolveSymbol(ident, scopes.at(-1)! as Map<string, Symbol>);
      return [expr.toWasm(), instr.local.set, localidx(info.idx)];
    },
    ExprStatement(expr, _) {
      return [expr.toWasm(), instr.drop];
    },
    Expr_arithmetic(num, iterOps, iterOperands) {
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
    PrimaryExpr_var(ident) {
      const info = resolveSymbol(ident, scopes.at(-1)! as Map<string, Symbol>);
      return [instr.local.get, localidx(info.idx)];
    },
    op(char) {
      return [char.sourceString === "+" ? instr.i32.add : instr.i32.sub];
    },
    number(_digits) {
      const num = parseInt(this.sourceString, 10);
      return [instr.i32.const, ...i32(num)];
    },
  });
}

function buildSymbolTable(grammar: ohm.Grammar, matchResult: ohm.MatchResult) {
  const tempSemantics = grammar.createSemantics();
  const scopes: Scope[] = [new Map()];
  tempSemantics.addOperation("buildSymbolTable", {
    _default(...children) {
      return children.forEach((c) => c.buildSymbolTable());
    },
    FunctionDecl(_func, ident, _lparen, optParams, _rparen, blockExpr) {
      const name = ident.sourceString;
      const locals = new Map();
      scopes.at(-1)!.set(name, locals);
      scopes.push(locals);
      optParams.child(0)?.buildSymbolTable();
      blockExpr.buildSymbolTable();
      scopes.pop();
    },
    Params(ident, _, iterIdent) {
      for (const id of [ident, ...iterIdent.children]) {
        const name = id.sourceString;
        const idx = scopes.at(-1)!.size;
        const info: Symbol = { name, idx, what: "param" };
        scopes.at(-1)!.set(name, info);
      }
    },
    LetStatement(_let, id, _eq, _expr, _) {
      const name = id.sourceString;
      const idx = scopes.at(-1)!.size;
      const info: Symbol = { name, idx, what: "local" };
      scopes.at(-1)!.set(name, info);
    },
  });
  tempSemantics(matchResult).buildSymbolTable();
  // the top-level scope contains only function symbols
  return scopes[0];
}

function toWasmFlat(input: string) {
  const matchResult = wafer.match(input, "FunctionDecl");
  const symbols = buildSymbolTable(wafer, matchResult);
  const semantics = wafer.createSemantics();
  defineToWasm(semantics, symbols);
  return flatten(semantics(matchResult).toWasm());
}

function defineFunctionDecls(semantics: ohm.Semantics, symbols: Scope) {
  semantics.addOperation("functionDecls", {
    _default(...children) {
      return children.flatMap((c) => c.functionDecls());
    },
    FunctionDecl(_func, ident, _l, _params, _r, _blockExpr) {
      const name = ident.sourceString;
      const localVars = Array.from(
        (symbols.get(name)! as Scope).values()
      ) as Symbol[];
      const params = localVars.filter((info) => info.what === "param");
      const paramTypes = params.map((_) => valtype.i32);
      const varsCount = localVars.filter(
        (info) => info.what === "local"
      ).length;
      return [
        {
          name,
          paramTypes,
          resultType: valtype.i32,
          locals: [locals(varsCount, valtype.i32)],
          body: this.toWasm(),
        },
      ];
    },
  });
}

function compile(source: string) {
  const matchResult = wafer.match(source);
  if (!matchResult.succeeded()) {
    throw new Error(matchResult.message);
  }

  const semantics = wafer.createSemantics();
  const symbols = buildSymbolTable(wafer, matchResult);
  defineToWasm(semantics, symbols);
  defineFunctionDecls(semantics, symbols);

  const functionDecls = semantics(matchResult).functionDecls();
  return buildModule(functionDecls);
}

export * from "./chapter04.js";
export { buildModule, buildSymbolTable, defineFunctionDecls, defineToWasm };

if (import.meta.vitest) {
  describe("buildModule", () => {
    it("builds", () => {
      const functionDecls: FunctionDecl[] = [
        {
          name: "main",
          paramTypes: [],
          resultType: valtype.i32,
          locals: [locals(1, valtype.i32)],
          body: [instr.i32.const, i32(42), instr.call, funcidx(1), instr.end],
        },
        {
          name: "backup",
          paramTypes: [valtype.i32],
          resultType: valtype.i32,
          locals: [],
          body: [instr.i32.const, i32(43), instr.end],
        },
      ];
      const exports = loadMod(buildModule(functionDecls));
      expect(exports.main()).toBe(43);
      expect(exports.backup()).toBe(43);
    });
  });

  describe("toWasm", () => {
    it("locals and assignment", () => {
      expect(toWasmFlat("func main() { 42 }")).toEqual([
        instr.i32.const,
        42,
        instr.end,
      ]);
      expect(toWasmFlat("func main() { let x = 10; 42 }")).toEqual(
        flatten([
          [instr.i32.const, 10],
          [instr.local.set, 0],
          [instr.i32.const, 42],
          instr.end,
        ])
      );
      expect(toWasmFlat("func main() { let x = 10; x }")).toEqual(
        flatten([
          [instr.i32.const, 10],
          [instr.local.set, 0],
          [instr.local.get, 0],
          instr.end,
        ])
      );
      expect(toWasmFlat("func main() { let x = 10; x := 9; x }")).toEqual(
        flatten([
          [instr.i32.const, 10],
          [instr.local.set, 0],
          [instr.i32.const, 9],
          [instr.local.tee, 0],
          instr.drop,
          [instr.local.get, 0],
          instr.end,
        ])
      );
      expect(toWasmFlat("func f1(a) { let x = 12; x }")).toEqual(
        flatten([
          [instr.i32.const, 12],
          [instr.local.set, 1], // set `x`
          [instr.local.get, 1], // get `x`
          instr.end,
        ])
      );
      expect(toWasmFlat("func f2(a, b) { let x = 12; b }")).toEqual(
        flatten([
          [instr.i32.const, 12],
          [instr.local.set, 2], // set `x`
          [instr.local.get, 1], // get `b`
          instr.end,
        ])
      );
    });
  });

  describe("compile", () => {
    it("module with multiple functions", () => {
      expect(loadMod(compile("func main() { 42 }")).main()).toBe(42);
      expect(
        loadMod(
          compile("func doIt() { add(1, 2) } func add(x, y) { x + y }")
        ).doIt()
      ).toBe(3);
    });
  });
}
