const instr = {
  i32: {
    add: 0x6a,
    const: 0x41,
    sub: 0x6b,
  },
  i64: { const: 0x42 },
  f32: { const: 0x43 },
  f64: { const: 0x44 },
  local: {
    get: 0x20,
    set: 0x21,
    tee: 0x22,
  },
  drop: 0x1a,
  end: 0x0b,
};

export default instr;
