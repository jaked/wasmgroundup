const instr = {
  i32: {
    const: 0x41,
    eqz: 0x45,
    eq: 0x46,
    ne: 0x47,
    lt_s: 0x48,
    ls_u: 0x49,
    gt_s: 0x4a,
    gt_u: 0x4b,
    le_s: 0x4c,
    le_u: 0x4d,
    ge_s: 0x4e,
    ge_u: 0x4f,
    add: 0x6a,
    sub: 0x6b,
    and: 0x71,
    or: 0x72,
  },
  i64: { const: 0x42 },
  f32: { const: 0x43 },
  f64: { const: 0x44 },
  local: {
    get: 0x20,
    set: 0x21,
    tee: 0x22,
  },
  block: 0x02,
  loop: 0x03,
  call: 0x10,
  drop: 0x1a,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
};

export default instr;
