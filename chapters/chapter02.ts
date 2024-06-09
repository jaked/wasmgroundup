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
  module,
  typeidx,
  typesec,
} from "./chapter01.js";

const grammarDef = `
  Wafer {
    Main = number
    number = digit+
  }
`;

const wafer = ohm.grammar(grammarDef);

const semantics = wafer.createSemantics();
semantics.addOperation<number>("jsValue", {
  Main(num) {
    return num.jsValue();
  },
  number(_digits) {
    return parseInt(this.sourceString, 10);
  },
});

const valtype = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
};

semantics.addOperation<bytes>("toWasm", {
  Main(num) {
    return [num.toWasm(), instr.end];
  },
  number(digits) {
    const value = this.jsValue();
    return [instr.i32.const, i32(value)];
  },
});

function compile(source: string) {
  const matchResult = wafer.match(source);
  if (!matchResult.succeeded()) {
    throw new Error(matchResult.message);
  }

  const mod = module([
    typesec([functype([], [valtype.i32])]),
    funcsec([typeidx(0)]),
    exportsec([export_("main", exportdesc.func(0))]),
    codesec([code(func([], semantics(matchResult).toWasm()))]),
  ]);
  return Uint8Array.from(flatten(mod));
}

function loadMod(bytes: BufferSource) {
  const mod = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(mod).exports;
}

export * from "./chapter01.js";
export { loadMod, valtype };

if (import.meta.vitest) {
  describe("Wafer", () => {
    it("should match the empty string", () => {
      expect(wafer.match("42").succeeded()).toBe(true);
      expect(wafer.match("abc").succeeded()).toBe(false);
    });

    it("should parse numbers", () => {
      const match = wafer.match("42");
      expect(match.succeeded()).toBe(true);
      expect(semantics(match).jsValue()).toBe(42);
    });
  });

  describe("toWasm", () => {
    it("compiles constants", () => {
      expect(loadMod(compile("42")).main()).toBe(42);
      expect(loadMod(compile("0")).main()).toBe(0);
      expect(loadMod(compile("31")).main()).toBe(31);
    });
  });
}
