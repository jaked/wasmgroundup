import * as ohm from "ohm-js";
import { describe, expect, it } from "vitest";
import instr from "./instr.js";

import {
  bytes,
  code,
  codesec,
  export_,
  exportdesc,
  exportsec,
  flatten,
  func,
  funcsec,
  functype,
  i32,
  loadMod,
  module,
  typeidx,
  typesec,
  u32,
  valtype,
} from "./chapter03.js";

function locals(n: number, type: number) {
  return [u32(n), type];
}

const localidx = u32;

const grammarDef = `
  Wafer {
    Main = Statement* Expr
    Statement = LetStatement | ExprStatement

    LetStatement = "let" identifier "=" Expr ";"

    ExprStatement = Expr ";"

    Expr = AssignmentExpr -- assignment
         | PrimaryExpr (op PrimaryExpr)* -- arithmetic

    AssignmentExpr = identifier ":=" Expr

    PrimaryExpr = number -- num
                | identifier -- var

    op = "+" | "-"
    number = digit+

    identifier = identStart identPart*
    identStart = letter | "_"
    identPart = letter | "_" | digit
  }
`;

const wafer = ohm.grammar(grammarDef);

type Symbol = {
  name: string;
  idx: number;
  what: "local";
};

function buildSymbolTable(grammar: ohm.Grammar, matchResult: ohm.MatchResult) {
  const tempSemantics = grammar.createSemantics();
  const symbols = new Map<string, Map<string, Symbol>>();
  symbols.set("main", new Map());
  tempSemantics.addOperation("buildSymbolTable", {
    _default(...children) {
      return children.forEach((c) => c.buildSymbolTable());
    },
    LetStatement(_let, id, _eq, _expr, _) {
      const name = id.sourceString;
      const idx = symbols.get("main")!.size;
      const info: Symbol = { name, idx, what: "local" };
      symbols.get("main")!.set(name, info);
    },
  });
  tempSemantics(matchResult).buildSymbolTable();
  return symbols;
}

function resolveSymbol(identNode: ohm.Node, locals: Map<string, Symbol>) {
  const identName = identNode.sourceString;
  if (locals.has(identName)) {
    return locals.get(identName)!;
  }
  throw new Error(`Error: undeclared identifier '${identName}'`);
}

function defineToWasm(
  semantics: ohm.Semantics,
  localVars: Map<string, Symbol>
) {
  semantics.addOperation("toWasm", {
    Main(statementIter, expr) {
      return [
        statementIter.children.map((c) => c.toWasm()),
        expr.toWasm(),
        instr.end,
      ];
    },
    LetStatement(_let, ident, _eq, expr, _) {
      const info = resolveSymbol(ident, localVars);
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
      const info = resolveSymbol(ident, localVars);
      return [expr.toWasm(), instr.local.tee, localidx(info.idx)];
    },
    PrimaryExpr_var(ident) {
      const info = resolveSymbol(ident, localVars);
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

function toWasmFlat(input: string) {
  const matchResult = wafer.match(input);
  const symbols = buildSymbolTable(wafer, matchResult);
  const semantics = wafer.createSemantics();
  defineToWasm(semantics, symbols.get("main")!);
  return flatten(semantics(matchResult).toWasm());
}

function compile(source: string) {
  const matchResult = wafer.match(source);
  if (!matchResult.succeeded()) {
    throw new Error(matchResult.message);
  }

  const semantics = wafer.createSemantics();
  const symbols = buildSymbolTable(wafer, matchResult);
  const localVars = symbols.get("main")!;
  defineToWasm(semantics, localVars);

  const mainFn = func(
    [locals(localVars.size, valtype.i32)],
    semantics(matchResult).toWasm()
  );
  const mod = module([
    typesec([functype([], [valtype.i32])]),
    funcsec([typeidx(0)]),
    exportsec([export_("main", exportdesc.func(0))]),
    codesec([code(mainFn)]),
  ]);
  return Uint8Array.from(flatten(mod));
}

export * from "./chapter03.js";
export { buildSymbolTable, resolveSymbol, locals, localidx };

if (import.meta.vitest) {
  describe("symbol table", () => {
    it("bind lets", () => {
      const getVarNames = (str: string) => {
        const symbols = buildSymbolTable(wafer, wafer.match(str));
        return Array.from(symbols.get("main")!.keys());
      };

      expect(getVarNames("42")).toEqual([]);
      expect(getVarNames("let x = 0; 42")).toEqual(["x"]);
      expect(getVarNames("let x = 0; let y = 1; 42")).toEqual(["x", "y"]);
    });

    it("resolves symbols", () => {
      const symbols = buildSymbolTable(
        wafer,
        wafer.match("let x = 0; let y = 1; 42")
      );
      const locals = symbols.get("main")!;
      expect(resolveSymbol({ sourceString: "x" }, locals).idx).toBe(0);
      expect(resolveSymbol({ sourceString: "y" }, locals).idx).toBe(1);
      expect(() => resolveSymbol({ sourceString: "z" }, locals)).toThrow();
    });
  });

  describe("toWasm", () => {
    it("locals and assignment", () => {
      expect(toWasmFlat("42")).toEqual([instr.i32.const, 42, instr.end]);
      expect(toWasmFlat("let x = 10; 42")).toEqual(
        flatten([
          [instr.i32.const, 10],
          [instr.local.set, 0],
          [instr.i32.const, 42],
          instr.end,
        ])
      );
      expect(toWasmFlat("let x = 10; x")).toEqual(
        flatten([
          [instr.i32.const, 10],
          [instr.local.set, 0],
          [instr.local.get, 0],
          instr.end,
        ])
      );
      expect(toWasmFlat("let x = 10; x := 9; x")).toEqual(
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
    });
  });
  describe("compile", () => {
    it("compiled with locals & assignment", () => {
      expect(loadMod(compile("42")).main()).toBe(42);
      expect(
        loadMod(compile("let a = 13; let b = 15; a := 10; a + b")).main()
      ).toBe(25);
    });
  });
}
