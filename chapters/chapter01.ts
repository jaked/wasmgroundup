import { describe, expect, it } from "vitest";
import instr from "./instr.js";

type bytes = (number | bytes)[];

function flatten(arr: bytes): number[] {
  // "Type instantiation is excessively deep and possibly infinite."
  // @ts-ignore
  return arr.flat(Infinity);
}

function stringToBytes(s: string) {
  const bytes = new TextEncoder().encode(s);
  return Array.from(bytes);
}

function int32ToBytes(v: number) {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

function u32(v: number) {
  if (v <= 127) {
    return [v];
  } else {
    throw new Error("Not Implemented");
  }
}

function i32(v: number) {
  if (v <= 63) {
    return [v];
  } else {
    throw new Error("Not Implemented");
  }
}

function vec(elements: bytes) {
  return [u32(elements.length), ...elements];
}

function magic() {
  // [0x00, 0x61, 0x73, 0x6d]
  return stringToBytes("\0asm");
}

function version() {
  // [0x01, 0x00, 0x00, 0x00]
  return int32ToBytes(1);
}

function section(id: number, contents: bytes) {
  const sizeInBytes = flatten(contents).length;
  return [id, u32(sizeInBytes), contents];
}

const SECTION_ID_TYPE = 1;

const TYPE_FUNCTION = 0x60;

function functype(paramTypes: bytes, resultTypes: bytes) {
  return [TYPE_FUNCTION, vec(paramTypes), vec(resultTypes)];
}

function typesec(functypes: bytes) {
  return section(SECTION_ID_TYPE, vec(functypes));
}

const SECTION_ID_FUNCTION = 3;

const typeidx = u32;

function funcsec(typeidxs: bytes) {
  return section(SECTION_ID_FUNCTION, vec(typeidxs));
}

const SECTION_ID_CODE = 10;

function code(func: bytes) {
  const sizeInBytes = flatten(func).length;
  return [u32(sizeInBytes), func];
}

function func(locals: bytes, body: bytes) {
  return [vec(locals), body];
}

function codesec(codes: bytes) {
  return section(SECTION_ID_CODE, vec(codes));
}

const SECTION_ID_EXPORT = 7;

function name(s: string) {
  return vec(stringToBytes(s));
}

function export_(nm: string, exportdesc: bytes) {
  return [name(nm), exportdesc];
}

function exportsec(exports: bytes) {
  return section(SECTION_ID_EXPORT, vec(exports));
}

const funcidx = u32;

const exportdesc = {
  func(idx: number) {
    return [0x00, funcidx(idx)];
  },
};

function module(sections: bytes) {
  return [magic(), version(), sections];
}

export {
  bytes,
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
  int32ToBytes,
  magic,
  module,
  name,
  section,
  SECTION_ID_CODE,
  SECTION_ID_EXPORT,
  SECTION_ID_FUNCTION,
  SECTION_ID_TYPE,
  stringToBytes,
  typeidx,
  typesec,
  u32,
  vec,
  version,
};

if (import.meta.vitest) {
  function compileVoidLang(code: string) {
    if (code === "") {
      const bytes = [magic(), version()].flat();
      return Uint8Array.from(bytes);
    } else {
      throw new Error(`Expected empty code, got: "${code}"`);
    }
  }

  function compileNopLang(source: string) {
    if (source === "") {
      const mod = [
        magic(),
        version(),
        typesec([functype([], [])]),
        funcsec([typeidx(0)]),
        exportsec([export_("main", exportdesc.func(0))]),
        codesec([code(func([], [instr.end]))]),
      ];
      return Uint8Array.from(flatten(mod));
    } else {
      throw new Error(`Expected empty code, got: "${source}"`);
    }
  }

  describe("compileVoidLang", () => {
    it("compiles to a WebAssembly object", async () => {
      const { instance, module } = await WebAssembly.instantiate(
        compileVoidLang("")
      );

      expect(instance instanceof WebAssembly.Instance).toBe(true);
      expect(module instanceof WebAssembly.Module).toBe(true);
    });
  });

  describe("compileNopLang", () => {
    it("compiles to a wasm module", async () => {
      const { instance, module } = await WebAssembly.instantiate(
        compileNopLang("")
      );

      expect(instance instanceof WebAssembly.Instance).toBe(true);
      expect(module instanceof WebAssembly.Module).toBe(true);
      expect(instance.exports.main()).toBe(undefined);
      expect(() => compileNopLang("42")).toThrow();
    });
  });
}
