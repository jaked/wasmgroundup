import * as ohm from "ohm-js";
import { describe, expect, it } from "vitest";
import instr from "./instr.js";
import { bytes, flatten, i32 } from "./chapter02.js";

const grammarDef = `
  Wafer {
    Main = Expr
    Expr = number (op number)*
    op = "+" | "-"
    number = digit+

    // Examples:
    //+ "42", "1"
    //- "abc"
  }
`;

const wafer = ohm.grammar(grammarDef);
const semantics = wafer.createSemantics();

semantics.addOperation("jsValue", {
  Main(num) {
    return num.jsValue();
  },
  number(digits) {
    return parseInt(this.sourceString, 10);
  },
});

semantics.addOperation<bytes>("toWasm", {
  Main(expr) {
    return [expr.toWasm(), instr.end];
  },
  Expr(num, iterOps, iterOperands) {
    const result = [num.toWasm()];
    for (let i = 0; i < iterOps.numChildren; i++) {
      const op = iterOps.child(i);
      const operand = iterOperands.child(i);
      result.push(operand.toWasm(), op.toWasm());
    }
    return result;
  },
  op(char) {
    return [char.sourceString === "+" ? instr.i32.add : instr.i32.sub];
  },
  number(digits) {
    const value = this.jsValue();
    return [instr.i32.const, i32(value)];
  },
});

function toWasmFlat(input: string) {
  const matchResult = wafer.match(input);
  const bytes = semantics(matchResult).toWasm();
  return flatten(bytes);
}

export * from "./chapter02.js";

if (import.meta.vitest) {
  describe("toWasm", () => {
    it("compiles a simple expr", () => {
      expect(toWasmFlat("1 + 2 - 3")).toEqual(
        flatten([
          [instr.i32.const, 1],
          [instr.i32.const, 2],
          instr.i32.add,
          [instr.i32.const, 3],
          instr.i32.sub,
          instr.end,
        ])
      );
    });
  });
}
