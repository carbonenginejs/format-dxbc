# DXBC → GLSL ES 3.00 lowering spec: `integer-conv` family

Family: integer ALU on bitcast registers, float↔int conversions, half-float packing, bitfield ops.
Corpus (450k instructions, 1611 EVE Online DX11 effects):
`f16tof32:4572 iadd:2709 ushr:1895 imul:1001 utof:992 itof:943 imad:871 f32tof16:624 ftou:452 ftoi:390 ishl:310 ubfe:237 udiv:139 bfi:102 umax:51 imax:43 ibfe:42 ineg:39 imin:16 ishr:12 umin:3 countbits:3`

Ground truth: `vendor/HLSLcc/src/toGLSLInstruction.cpp` (all line numbers below refer to that file unless another file is named). Target language is `LANG_ES_300` (WebGL2), vertex + pixel only.

---

## 0. Family-wide conventions (read first)

### 0.1 Register storage model and bitcasts

The JS emitter stores **every** temp register as a `highp vec4` and bitcasts at use sites. This mirrors HLSLcc's behavior when its data-type analysis concludes a register is float but an instruction needs int/uint:

- **Reading** an operand as int/uint from a float-stored register: `TranslateOperand` with `TO_AUTO_BITCAST_TO_INT` / `TO_AUTO_BITCAST_TO_UINT` wraps the operand in `floatBitsToInt(...)` / `floatBitsToUint(...)` (`toGLSLOperand.cpp:327-353`, `GetBitcastOp`; applied in `TranslateVariableNameWithMask`). Per `toGLSLOperand.cpp:1617`, generate `floatBitsToUint(r0.xz)` — swizzle **inside** the call — not `floatBitsToUint(r0).xz`.
- **Writing** an int/uint-valued expression to a float-stored destination: `AddAssignToDest` → `AddOpAssignToDestWithMask` (lines 28-153). When dest data type is float and src type is `SVT_INT`/`SVT_UINT`, it emits `intBitsToFloat(` / `uintBitsToFloat(` around the RHS (lines 123-144). So the canonical statement shape for this whole family is:

  ```glsl
  rD.<mask> = intBitsToFloat(<int expr>);   // signed result
  rD.<mask> = uintBitsToFloat(<uint expr>); // unsigned result
  ```

- **Immediates** are printed directly in the requested type, never bitcast (`printImmediate32`, `toGLSLOperand.cpp:356-409`): uint → `123u` (zero on ES3 as `uint(0u)` — Adreno pre-Lollipop workaround, optional for WebGL2); int with value > `0x3ffffffe` → `int(0xXXXXXXXXu)` to avoid signed-literal overflow; otherwise plain decimal.
- **Component-count fill**: when dest has more components than the source expression, `AddOpAssignToDestWithMask` inserts the dest-type constructor `ivecN(`/`uvecN(`/`vecN(` (lines 73-77, 93-97, 111-115).

### 0.2 Comparison-mask convention

DXBC comparisons (`ieq`, `ilt`, `lt`, …) produce **0xFFFFFFFF / 0x00000000 uint masks, not bools** (stated explicitly at lines 173-182, `AddComparison` header comment; bool-upscale emits `* 0xffffffffu`, `toGLSLOperand.cpp:1622-1637`). Instructions in this family routinely consume those masks (e.g. `iadd` of a mask, `ushr` of a mask). The emitter must treat mask inputs as ordinary 32-bit bit patterns read through `floatBitsToUint`/`floatBitsToInt` — never convert them to `bool` and never assume the value is 0/1.

### 0.3 Saturate (`_sat`)

`_sat` (OpcodeToken0 & 0x2000) is legal only on float-result instructions. HLSLcc applies it generically after the instruction body as a **second statement** (lines 4821-4846):

```glsl
rD.<mask> = clamp(rD.<mask>, 0.0, 1.0);
```

(The `#ifdef UNITY_ADRENO_ES3` `min(max(...))` variant at lines 4827-4845 is a driver workaround; WebGL2/ANGLE does not need it — emit plain `clamp`.) In this family, `_sat` can only legally appear on `itof`/`utof` (float results). If the decoder ever reports `_sat` on an integer-result opcode, treat it as a decode error.

### 0.4 Source modifiers and write masks

Operand modifiers `neg`/`abs`/`absneg` wrap the translated operand as `(-x)`, `abs(x)`, `-abs(x)` (`toGLSLOperand.cpp:1677-1698`) — applied to the *typed* (post-bitcast) expression. All simple binary/ternary lowerings read sources through the destination write mask (`CallBinaryOp`, lines 507-590; `CallTernaryOp`, lines 592-621): each source is swizzle-filtered to the dest's access mask so component counts match.

### 0.5 ES 3.00 component-wise unroll for bitwise/shift ops

`CallBinaryOp` special-cases `LANG_ES_300` for `& | ^ >> <<` (lines 555-581, "Adreno 3xx fails on binary ops that operate on vectors"): instead of `a.xy >> b.xy` it emits a constructor of per-component scalar ops:

```glsl
uvec2(floatBitsToUint(a.x) >> floatBitsToUint(b.x), floatBitsToUint(a.y) >> floatBitsToUint(b.y))
```

This is a mobile-driver workaround. On WebGL2 (ANGLE) vector shifts are legal and reliable; the emitter MAY use the vector form, but following HLSLcc's ES300 unroll is the maximum-fidelity choice and costs nothing. This spec shows the vector form for brevity; implementers choosing strict HLSLcc parity should unroll `ushr`/`ishl`/`ishr` per component.

---

## 1. `f16tof32` (count 4572)

**Semantics.** Interprets the low 16 bits of each source uint component as an IEEE half-float and expands to float32 (D3D11 `f16tof32`). Upper 16 bits of the source are ignored.

**GLSL lowering** (lines 4535-4559). HLSLcc unrolls **per destination component** (write-mask loop at 4545-4548), because `unpackHalf2x16` is scalar-in/vec2-out:

```glsl
// f16tof32 r0.xy, r1.xy   →  per component i in {x,y}:
r0.x = unpackHalf2x16(floatBitsToUint(r1.x)).x;
r0.y = unpackHalf2x16(floatBitsToUint(r1.y)).x;
```

Source is read with `TO_AUTO_BITCAST_TO_UINT` (line 4555); result is `SVT_FLOAT` assigned through `AddAssignToDest` (line 4552) — for a float-stored register the types match, so no dest wrapper. `.x` of the unpack result selects the low 16 bits — exactly the D3D-defined field; the garbage upper halfword lands in `.y` and is discarded.

**Type rules.** src: uint (bitcast from float storage). dst: float (no bitcast). One statement per set write-mask bit.

**Helpers.** None (built-in `unpackHalf2x16`, core GLSL ES 3.00).

**Edge cases.** D3D requires inf/NaN preserved and half denormals expanded to the corresponding float value; GLSL ES 3.00 `unpackHalf2x16` performs the same conversion, but the ES spec allows NaN payloads to vary and some GPUs flush half denormals — visually irrelevant for this corpus (HDR color/packing paths). Modifiers `neg`/`abs` on the source wrap **outside** the bitcast (the modifier prefix is printed before the operand's bitcast wrapper, `toGLSLOperand.cpp:1677-1698`, consistent with §0.4), yielding e.g. `(-floatBitsToUint(r1.x))` — modular negation of the uint bit pattern, not a float negate. In practice DXC never emits modifiers on `f16tof32` sources; reject/warn if seen.

**WebGL2 notes.** `unpackHalf2x16` is core ES 3.00. Fully supported.

**Confidence: high** — direct 1:1 with HLSLcc lines 4535-4559 and core builtins.

---

## 2. `iadd` (count 2709)

**Semantics.** Component-wise 32-bit two's-complement integer add (wraps on overflow, D3D11 `iadd`).

**GLSL lowering** (lines 2408-2426): `CallBinaryOp("+", psInst, 0, 1, 2, eType)` where `eType` is `SVT_UINT` if HLSLcc's data-type analysis marked the dest uint, else `SVT_INT` (lines 2410, 2420-2423). Template via `CallBinaryOp` (lines 507-590):

```glsl
// iadd r0.xyz, r1.xyz, r2.xyz
r0.xyz = intBitsToFloat(floatBitsToInt(r1.xyz) + floatBitsToInt(r2.xyz));
```

**Type rules.** Two's-complement add is bit-identical for int and uint, so without data-type analysis the emitter can always pick **int**; the int/uint distinction in HLSLcc exists only to avoid mixed-type GLSL compile errors against typed uniforms. If either source is a uint-typed expression (e.g. a comparison mask), bitcast everything to one type consistently. Scalar-vs-vector sources: if swizzle counts differ, the smaller side is auto-expanded (`TO_AUTO_EXPAND_TO_VEC*`, lines 544-548).

**Helpers.** None.

**Edge cases.** Overflow wraps (GLSL ES 3.00 guarantees modulo-2^32 wrapping for highp int/uint — matches D3D). `neg` modifier on a source of `iadd` is how DXC encodes integer subtract: `(-floatBitsToInt(r1.x))` — note GLSL unary minus on `int` is two's-complement negate, which matches.

**WebGL2 notes.** Requires `highp int` in fragment shaders (declare `precision highp int;` — mediump int is 16-bit-minimum in ES).

**Confidence: high** — trivial mapping, verified against CallBinaryOp.

---

## 3. `ushr` (count 1895)

**Semantics.** Component-wise logical (zero-fill) right shift; D3D uses only the 5 LSBs of the shift amount (`src1 & 31`).

**GLSL lowering** (lines 4047-4055): `CallBinaryOp(">>", psInst, 0, 1, 2, SVT_UINT)`. Subject to the ES300 component-wise unroll (§0.5, lines 556-581):

```glsl
// ushr r0.x, r1.x, l(8)
r0.x = uintBitsToFloat(floatBitsToUint(r1.x) >> 8u);
```

**Type rules.** Both operands read as **uint** (logical shift requires unsigned left operand in GLSL). Result uint → `uintBitsToFloat` wrapper. Immediates print as `Nu`.

**Helpers.** None.

**Edge cases.** GLSL shift by ≥ 32 or negative is **undefined**; D3D masks to 5 bits. HLSLcc does **not** emit a mask. For immediate shift counts (the overwhelming corpus case, e.g. filmgrain's `ushr`) the DXC output is always 0-31 so this is safe. For a *dynamic* shift amount, harden with `(floatBitsToUint(r2.x) & 31u)` — a deviation from HLSLcc, but it converts UB into the exact D3D semantics at trivial cost. Recommended.

**WebGL2 notes.** Vector `>>` works on ANGLE; per-component unroll optional (§0.5).

**Confidence: high** — direct CallBinaryOp mapping; the &31 guard is a documented deliberate extension.

---

## 4. `imul` (count 1001)

**Semantics.** 32-bit signed multiply producing a 64-bit result: dest0 = high 32 bits, dest1 = low 32 bits (D3D11 `imul destHI, destLO, src0, src1`).

**GLSL lowering** (lines 2713-2729). HLSLcc **asserts the high destination is NULL** (line 2726: `ASSERT(psInst->asOperands[0].eType == OPERAND_TYPE_NULL)`) and lowers only the low half: `CallBinaryOp("*", psInst, 1, 2, 3, eType)` — note dest is **operand 1**, sources are operands 2 and 3. `eType` is uint if operand 1's data type is uint (lines 2721-2724), else int; low 32 bits are identical either way.

```glsl
// imul null, r0.x, r1.x, r2.x
r0.x = intBitsToFloat(floatBitsToInt(r1.x) * floatBitsToInt(r2.x));
```

**Type rules.** dest = operand 1; operand 0 must be `null`. Sources bitcast to int (or uint). Result wraps modulo 2^32 (GLSL highp guarantee = D3D low-half semantics).

**Helpers.** None for the null-HI form.

**Edge cases.** If a shader ever uses a non-null high destination, ES 3.00 has **no** `imulExtended`/`umulExtended` (those are ES 3.10+). The emitter must hard-fail (preferred, matching HLSLcc's assert) or emulate via 16-bit limb multiplication. Sweep evidence: EVE's DXC output always passes `null` for HI. Same applies to `umul` if ever encountered (not in corpus).

**WebGL2 notes.** No extended-precision multiply builtins; do not emit them.

**Confidence: high** for null-HI (the only observed form); the non-null-HI path is unimplemented by the authority too.

---

## 5. `utof` (count 992) and `itof` (count 943)

**Semantics.** Numeric conversion uint→float (`utof`) / int→float (`itof`), round-to-nearest-even for values not exactly representable (D3D11).

**GLSL lowering** (lines 2333-2371): constructor cast, with the source read via auto-bitcast:

```glsl
// itof r0.xy, r1.xy
r0.xy = vec2(floatBitsToInt(r1.xy));
// utof r0.x, r1.x
r0.x = float(floatBitsToUint(r1.x));
```

Constructor is `GetConstructorForTypeGLSL(SVT_FLOAT, dstCount)` (line 2365); the source is translated with `TO_AUTO_BITCAST_TO_UINT` for `utof`, `TO_AUTO_BITCAST_TO_INT` for `itof`, filtered by the dest access mask (line 2367). Result is float, assigned with no dest wrapper (types match float storage). Min-precision variants (`OPERAND_MIN_PRECISION_FLOAT_16/2_8`, lines 2349-2361) map to mediump; the emitter may ignore precision qualifiers and stay highp.

**Type rules.** src: uint (`utof`) / int (`itof`) — the *only* difference between the two opcodes, and it matters: `float(floatBitsToUint(x))` and `float(floatBitsToInt(x))` differ for bit patterns ≥ 0x80000000 (e.g. comparison masks: `utof` of 0xFFFFFFFF is 4294967295.0, `itof` is -1.0). Never merge these paths.

**Helpers.** None.

**Edge cases.** uint values above 2^24 lose precision in float32 — inherent, matches D3D. `_sat` is legal here (float result); apply §0.3 clamp statement afterwards.

**WebGL2 notes.** None.

**Confidence: high.**

---

## 6. `imad` (count 871)

**Semantics.** Component-wise integer multiply-add: `dest = src0 * src1 + src2`, all 32-bit two's-complement, wrapping (D3D11 `imad`; only low 32 bits of the product are kept).

**GLSL lowering** (lines 2382-2396): `CallTernaryOp("*", "+", psInst, 0, 1, 2, 3, ui32Flags)` with `TO_FLAG_INTEGER`, upgraded to `TO_FLAG_UNSIGNED_INTEGER` if dest is uint-typed (lines 2390-2393). Template via `CallTernaryOp` (lines 592-621):

```glsl
// imad r0.x, r1.x, r2.x, r3.x
r0.x = intBitsToFloat(floatBitsToInt(r1.x) * floatBitsToInt(r2.x) + floatBitsToInt(r3.x));
```

**Type rules.** All three sources and the result in one integer type (int by default; bit-identical to uint for wrap-around mul/add). Sources read through the dest write mask; scalar sources auto-expanded (lines 605-609).

**Helpers.** None.

**Edge cases.** No fused semantics to worry about (integer). Overflow wraps at each step — GLSL highp int matches.

**WebGL2 notes.** None beyond `precision highp int`.

**Confidence: high.**

---

## 7. `f32tof16` (count 624)

**Semantics.** Converts each float32 component to an IEEE half stored in the **low 16 bits** of the dest uint component, high 16 bits zero (D3D11 `f32tof16`).

**GLSL lowering** (lines 4509-4533). Per-destination-component unroll (write-mask loop 4519-4522):

```glsl
// f32tof16 r0.x, r1.x
r0.x = uintBitsToFloat(packHalf2x16(vec2(r1.x, 0.0)));
```

`packHalf2x16(vec2(v, 0.0))` puts `half(v)` in bits 0-15 and `half(0.0)`=0x0000 in bits 16-31 — exactly the D3D layout. Source read with `TO_FLAG_NONE` (float, line 4529); result assigned as `SVT_UINT` (line 4526), hence the `uintBitsToFloat` dest wrapper under float storage.

**Type rules.** src: float (no bitcast). dst: uint bit pattern → `uintBitsToFloat`. One statement per write-mask bit.

**Helpers.** None (core builtin).

**Edge cases.** **Rounding-mode mismatch**: D3D specifies round-toward-zero for `f32tof16`; GLSL ES 3.00 leaves `packHalf2x16` rounding implementation-defined (typically round-to-nearest-even). Differs by at most 1 half-ULP; EVE uses this for HDR/GBuffer packing where that is invisible. NaN→NaN (payload may differ), inf→inf, overflow→inf under RNE vs 65504 under D3D RTZ — the overflow case is the one observable divergence worth noting. Float denormal inputs may flush.

**WebGL2 notes.** `packHalf2x16` is core ES 3.00.

**Confidence: high** on the template (verbatim HLSLcc); **medium** on bit-exactness due to the rounding-mode gap, which HLSLcc itself does not close.

---

## 8. `ftou` (count 452) and `ftoi` (count 390)

**Semantics.** Float→uint / float→int conversion, **truncation toward zero**, with D3D-defined saturation: NaN→0; `ftou`: negative→0, > UINT_MAX→0xFFFFFFFF; `ftoi`: < INT_MIN→0x80000000, > INT_MAX→0x7FFFFFFF.

**GLSL lowering** (lines 2247-2285): constructor cast; dest assigned as `SVT_UINT`/`SVT_INT` via `AddAssignToDest` (line 2278), source read with `TO_AUTO_BITCAST_TO_FLOAT` filtered by dest mask (line 2281):

```glsl
// ftou r0.xy, r1.xy   (float storage)
r0.xy = uintBitsToFloat(uvec2(r1.xy));
// ftoi r0.x, r1.x
r0.x = intBitsToFloat(int(r1.x));
```

Min-precision int16/uint16 variants exist (lines 2261-2275) but only downgrade precision; ignore on WebGL2 (stay highp).

**Type rules.** src: float. Result: uint (`ftou`) / int (`ftoi`) → dest wrapper `uintBitsToFloat`/`intBitsToFloat`. Constructor arity follows `dstCount` (line 2279); source expression follows the same mask so counts agree.

**Helpers.** None in the HLSLcc-parity form. Optional hardened helpers below.

**Edge cases.** GLSL `int(float)`/`uint(float)` truncates toward zero (matches D3D for in-range values) but is **undefined** for NaN, ±inf, and out-of-range values, including all negative inputs to `uint()`. HLSLcc emits the bare cast and accepts the UB. In this corpus `ftou`/`ftoi` feed texture-size math, LUT indices and loop counters where inputs are small and non-negative, so bare casts are the default. If a shader misbehaves, swap in the D3D-exact hardened forms:

```glsl
uint dx11_ftou(float v) { return (v != v || v <= 0.0) ? 0u : (v >= 4294967296.0 ? 0xFFFFFFFFu : uint(v)); }
int  dx11_ftoi(float v) { return v != v ? 0 : (v <= -2147483648.0 ? int(0x80000000u) : (v >= 2147483648.0 ? 0x7FFFFFFF : int(v))); }
```

(The range tests use exactly representable float bounds — 2^32 and ±2^31 are float-exact — so every in-range input reaches the bare cast, which is defined; out-of-range/inf inputs clamp to the exact D3D values 0xFFFFFFFF / 0x7FFFFFFF / 0x80000000. A `clamp()`-based form with bounds like 2147483520.0 would be off by up to 127/255 at the extremes. `v != v` is the NaN test — ES 3.00 `isnan` is allowed to be optimized out on some drivers, `v != v` is not.) These are *not* what HLSLcc emits; treat as opt-in.

**WebGL2 notes.** None.

**Confidence: high** on the HLSLcc-parity cast; the hardened variants are spec-derived (D3D11 §22.2 conversion rules), not HLSLcc-verified.

---

## 9. `ishl` (count 310) and `ishr` (count 12)

**Semantics.** `ishl`: left shift (zero fill). `ishr`: **arithmetic** right shift (sign fill). Shift amount = 5 LSBs of src1 in D3D.

**GLSL lowering** (`ishl` lines 4057-4074, `ishr` lines 4075-4091): `CallBinaryOp("<<" | ">>", psInst, 0, 1, 2, eType)` with `eType` int unless dest analyzed as uint (lines 4067-4070, 4084-4087). Subject to the ES300 unroll (§0.5).

```glsl
// ishl r0.x, r1.x, l(4)
r0.x = intBitsToFloat(floatBitsToInt(r1.x) << 4);
// ishr r0.x, r1.x, l(2)
r0.x = intBitsToFloat(floatBitsToInt(r1.x) >> 2);
```

**Type rules.** `ishl`: int vs uint left operand is bit-identical — either works. `ishr`: the left operand **must** be read as `int` (`floatBitsToInt`) to get sign-fill; if HLSLcc's uint-dest upgrade path fires it would produce a logical shift — under our no-analysis emitter, always use int for `ishr` (this is the D3D semantic; `ushr` exists for the logical case). Shift-count operand: GLSL allows mixed signedness of the shift count; print immediates as plain int.

**Helpers.** None.

**Edge cases.** Same ≥32 shift UB as `ushr` (§3); mask dynamic counts with `& 31`. `ishr` of negative values rounds toward −∞ (sign-fill), matching D3D.

**WebGL2 notes.** Same as `ushr`.

**Confidence: high** (`ishl`); **high** (`ishr`) with the explicit note that we deliberately pin the left operand to int, diverging from HLSLcc's uint-upgrade branch, per the D3D definition of `ishr` as arithmetic shift.

---

## 10. `ubfe` (count 237) and `ibfe` (count 42)

**Semantics.** Bitfield extract. Operand order: `dest, width, offset, src` (operands 1=width, 2=offset, 3=source). Extracts `width` bits starting at bit `offset`; `ubfe` zero-extends, `ibfe` sign-extends from the top extracted bit. D3D reads only the 5 LSBs of width/offset.

**GLSL lowering** (lines 4451-4487). HLSLcc unrolls **per destination component** because GLSL `bitfieldExtract` takes scalar `offset`/`bits` shared by all components (comment line 4467). HLSLcc's own output (valid only on ES 3.10+ — see Helpers/WebGL2 below):

```glsl
// ubfe r0.x, l(8), l(16), r1.x        // width=8, offset=16
r0.x = uintBitsToFloat(bitfieldExtract(floatBitsToUint(r1.x), 16, 8));   // HLSLcc form; WebGL2: dx11_ubfe
// ibfe r0.x, l(5), l(3), r1.x
r0.x = intBitsToFloat(bitfieldExtract(floatBitsToInt(r1.x), 3, 5));      // HLSLcc form; WebGL2: dx11_ibfe
```

Argument order emitted: `bitfieldExtract(src3, src2, src1)` = `(value, offset, bits)` (lines 4477-4483). Source value bitcast: `TO_AUTO_BITCAST_TO_UINT` for `ubfe`, `TO_AUTO_BITCAST_TO_INT` for `ibfe` (line 4458); offset and width always read as **int** (`TO_AUTO_BITCAST_TO_INT`, lines 4480-4482). Result type uint/int → dest wrapper accordingly (line 4457, 4475). One statement per write-mask bit, each using that component's slice of all three sources (mask `1<<i`).

**Type rules.** The overload of `bitfieldExtract` (signed vs unsigned) is selected by the *value* argument's type — this is what implements zero- vs sign-extension. `offset`/`bits` are `int` in both overloads.

**Helpers.** **Required on WebGL2**: `bitfieldExtract` is a GLSL ES **3.10** builtin (ES 3.10 spec §8.8, Integer Functions) and does **not exist in GLSL ES 3.00** — HLSLcc emits it unconditionally (lines 4477-4483, no version guard), which is invalid for WebGL2. Emit `dx11_ubfe`/`dx11_ibfe` with the same `(value, offset, bits)` argument order, transcribed from the D3D11 pseudocode:

```glsl
uint dx11_ubfe(uint src, int offset, int bits) {
    if (bits == 0) return 0u;
    if (offset + bits < 32) return (src << uint(32 - bits - offset)) >> uint(32 - bits);
    return src >> uint(offset);
}
int dx11_ibfe(int src, int offset, int bits) {
    if (bits == 0) return 0;
    if (offset + bits < 32) return (src << uint(32 - bits - offset)) >> uint(32 - bits);  // >> on int = arithmetic
    return src >> uint(offset);
}
```

All shift counts are in [1,31] on every reachable path given D3D's 5-bit masking of width/offset, so no shift UB. Emission is HLSLcc's template with the builtin name swapped:

```glsl
r0.x = uintBitsToFloat(dx11_ubfe(floatBitsToUint(r1.x), 16, 8));
```

**Edge cases.** The `dx11_ubfe`/`dx11_ibfe` helpers implement the D3D pseudocode directly, so the cases that are UB for builtin `bitfieldExtract` are defined here: `bits = 0` → 0, `offset + bits >= 32` → plain `src >> offset` (logical/arithmetic per opcode) — both match D3D. DXC-generated width/offset are almost always in-range immediates. The helpers assume width/offset already fit in 5 bits (D3D masks them at decode); if *dynamic* width/offset ever appear, mask with `& 31` at the call site (opt-in, matches D3D's decode-time masking).

**WebGL2 notes.** `bitfieldExtract` is **not** available in GLSL ES 3.00 (WebGL2); it arrived in ES 3.10. ANGLE rejects it under `#version 300 es`. The `dx11_ubfe`/`dx11_ibfe` helpers above are mandatory — this is a forced divergence from HLSLcc, whose LANG_ES_300 output is not strictly ES 3.00-conformant here.

**Confidence: high** on operand roles, per-component unroll, and argument order (verbatim from lines 4451-4487); the helper bodies are D3D11-pseudocode transcriptions, not HLSLcc-derived (HLSLcc has no ES 3.00-legal path for this opcode).

---

## 11. `udiv` (count 139) — dual destination

**Semantics.** Unsigned divide: `udiv destQUOT, destREM, src0, src1` computes `destQUOT = src0 / src1` and `destREM = src0 % src1` per component. **Per D3D11 spec, divide by zero yields 0xFFFFFFFF in both quotient and remainder.** Either destination may be `null`. Operand roles confirmed by decision `../shaderdiscovery/AGENT-FINDINGS/decisions/021-dxbc-udiv-lowering-correction.md` (operand 0 = quotient dest, 1 = remainder dest, 2 = dividend, 3 = divisor; skip null destinations).

**GLSL lowering.** HLSLcc (lines 2731-2754) emits two independent `CallBinaryOp` statements with `SVT_UINT`:

```glsl
// udiv r0.x, r1.x, r2.x, r3.x        (HLSLcc-parity form)
r0.x = uintBitsToFloat(floatBitsToUint(r2.x) / floatBitsToUint(r3.x));
r1.x = uintBitsToFloat(floatBitsToUint(r2.x) % floatBitsToUint(r3.x));
```

**Ordering hazard** (lines 2740-2752): if the quotient destination aliases either source register, HLSLcc computes `%` **first**, then `/`, so the remainder reads the sources before the quotient overwrites them. Replicate: compare (regFile, regNumber) of operand 0 against operands 2 and 3; on alias, emit remainder first. (If the *remainder* dest aliases a source and quotient comes second, the same class of bug exists in HLSLcc itself; safest general rule: compute both into locals, then store — see helper form below.)

**Required project form (helpers).** HLSLcc's raw `/`/`%` is UB in GLSL when the divisor is 0 (GLSL ES 3.00 §5.9: undefined). D3D mandates 0xFFFFFFFF. Per decision 021 this project preserves bit-pattern behavior with `dx11_udiv`/`dx11_umod` helpers — and this spec **adds the div-by-zero guard** the draft helpers lacked:

```glsl
uint dx11_udiv(uint a, uint b) { return b == 0u ? 0xFFFFFFFFu : a / b; }
uint dx11_umod(uint a, uint b) { return b == 0u ? 0xFFFFFFFFu : a % b; }
// plus uvec2/uvec3/uvec4 overloads:
uvec2 dx11_udiv(uvec2 a, uvec2 b) { return uvec2(dx11_udiv(a.x,b.x), dx11_udiv(a.y,b.y)); }
uvec2 dx11_umod(uvec2 a, uvec2 b) { return uvec2(dx11_umod(a.x,b.x), dx11_umod(a.y,b.y)); }
// ... uvec3/uvec4 likewise
```

Emission:

```glsl
// udiv r0.x, r1.x, r2.x, r3.x
r0.x = uintBitsToFloat(dx11_udiv(floatBitsToUint(r2.x), floatBitsToUint(r3.x)));
r1.x = uintBitsToFloat(dx11_umod(floatBitsToUint(r2.x), floatBitsToUint(r3.x)));
```

Helper calls read sources before either store, so with non-aliasing *sources between the two statements* the only remaining hazard is quotient-dest aliasing a source consumed by the remainder statement — keep HLSLcc's swap rule.

Skip the statement for any `null` destination (decision 021). HLSLcc achieves the same effect differently: it emits both statements unconditionally, but a `OPERAND_TYPE_NULL` dest prints as `//null` on non-ES100 targets (`toGLSLOperand.cpp:1356-1379`), turning that whole line into a comment. Emitting nothing is cleaner and equivalent.

**Type rules.** Everything uint; both dests get `uintBitsToFloat` wrappers.

**Helpers.** `dx11_udiv`, `dx11_umod` (scalar + uvec2/3/4 overloads). Note the draft transpiler's float-signature versions (`Dx11GlesDraftTranspiler.js:1293-1300`) fold the bitcasts into the helper — acceptable alternative signature, but they lack the zero guard; the guard is mandatory in the final helpers.

**Edge cases.** Div-by-zero → 0xFFFFFFFF/0xFFFFFFFF (guarded). Observed usage: `hazespherical.sm_depth` (rare). Signed `idiv` does not exist in DXBC SM5 for this corpus.

**WebGL2 notes.** Integer `/`,`%` by zero can produce anything (including on some drivers a context loss via driver bugs) — the guard is cheap insurance, not just spec pedantry.

**Confidence: high** on operand roles and ordering (HLSLcc + decision 021 agree); **medium** on the guard being observable in practice (no fixture yet proves an EVE shader divides by zero).

---

## 12. `bfi` (count 102)

**Semantics.** Bitfield insert: `bfi dest, width(src1), offset(src2), insert(src3), base(src4)`. Result per component: `bits = width & 31; mask = ((1<<bits)-1) << offset; dest = ((insert << offset) & mask) | (base & ~mask)` (D3D11 `bfi`).

**GLSL lowering** (lines 3388-3437). On `LANG_ES_300` HLSLcc **requires the `int_bitfieldInsert` helper** (line 3401-3402) because Adreno rejects redefining/overloading `bitfieldInsert` and drivers mishandle it; helper source at `toGLSL.cpp:1172-1180`:

```glsl
int int_bitfieldInsert(int base, int insert, int offset, int bits) {
    uint mask = ~(uint(0xffffffff) << uint(bits)) << uint(offset);
    return int((uint(base) & ~mask) | ((uint(insert) << uint(offset)) & mask));
}
```

Emission is per-component, gathered into one constructor (lines 3404-3436). Argument order: the loop at 3424-3429 emits operands **4,3,2,1** → `int_bitfieldInsert(base, insert, offset, bits)`:

```glsl
// bfi r0.xy, l(8,8,0,0), l(0,8,0,0), r1.xyxx, r2.xyxx
r0.xy = intBitsToFloat(ivec2(
    int_bitfieldInsert(floatBitsToInt(r2.x), floatBitsToInt(r1.x), 0, 8),
    int_bitfieldInsert(floatBitsToInt(r2.y), floatBitsToInt(r1.y), 8, 8)));
```

All four sources read as **int** (`TO_FLAG_INTEGER`, line 3426), one component each (`1 << i`); result assigned as `SVT_INT` (line 3405) → `intBitsToFloat` dest wrapper. Element count = `min(width elems, offset elems, dest elems)` (line 3394) — a HLSLcc quirk; in practice DXC replicates immediates so use the dest write-mask count.

**Type rules.** int in/out at the GLSL surface; the helper does the unsigned masking internally.

**Helpers.** `int_bitfieldInsert` (verbatim above).

**Edge cases.** `bits = 32` would shift a uint by 32 in the helper (undefined) — cannot occur because D3D masks width/offset to 5 bits (0-31); DXC immediates comply. `bits = 0` → mask 0 → returns base: matches D3D. Offset+bits > 32: high bits of the insert drop off — helper mask handles it the same way D3D does.

**WebGL2 notes.** Use the helper, not builtin `bitfieldInsert`, matching HLSLcc's ES300 branch exactly (line 3419-3422). Note the builtin does not even exist in GLSL ES 3.00 (it is ES 3.10, like `bitfieldExtract` — §10), and it would additionally need identical scalar offset/bits per component, which DXBC does not guarantee — so the per-component helper form is required on WebGL2 for two independent reasons. The helper body uses only shifts/masks, all core ES 3.00.

**Confidence: high** — helper source and operand order lifted verbatim; operand-order (4,3,2,1 → base,insert,offset,bits) double-checked against the D3D operand list.

---

## 13. `umax` (51), `imax` (43), `imin` (16), `umin` (3)

**Semantics.** Component-wise integer max/min: `imax`/`imin` signed, `umax`/`umin` unsigned (D3D11).

**GLSL lowering** (`imax` 3049-3061, `umax` 3062-3074, `imin` 3085-3097, `umin` 3098-3110). On ES 3.00 (not the ES 1.00 float fallback): `CallHelper2Int("max"|"min", ...)` for signed (lines 687-714), `CallHelper2UInt` for unsigned (lines 716-743) — i.e. builtin `max`/`min` with both args bitcast to the right integer type:

```glsl
// imax r0.x, r1.x, r2.x
r0.x = intBitsToFloat(max(floatBitsToInt(r1.x), floatBitsToInt(r2.x)));
// umin r0.xy, r1.xy, r2.xy
r0.xy = uintBitsToFloat(min(floatBitsToUint(r1.xy), floatBitsToUint(r2.xy)));
```

**Type rules.** Signedness is semantic here (0xFFFFFFFF is max-uint but −1 as int) — never collapse i/u variants. Args follow dest write mask; scalar auto-expand as usual (lines 698-702, 727-731). Result wrapper matches the type.

**Helpers.** None (builtin genIType/genUType `min`/`max` overloads are core ES 3.00).

**Edge cases.** None; integer min/max is total.

**WebGL2 notes.** None.

**Confidence: high.**

---

## 14. `ineg` (count 39)

**Semantics.** Component-wise two's-complement integer negate: `dest = 0 - src` (D3D11 `ineg`; `-INT_MIN` wraps to `INT_MIN`).

**GLSL lowering** (lines 4561-4578) — HLSLcc literally emits `0 - src`:

```glsl
// ineg r0.x, r1.x
r0.x = intBitsToFloat(0 - floatBitsToInt(r1.x));
```

Dest assigned as `SVT_INT` with the **source's** swizzle count (line 4572); source read `TO_FLAG_INTEGER` through the dest access mask (line 4575). For a multi-component dest the `0` participates via GLSL scalar-vector subtraction (`0 - ivec2(...)` is valid); keep the `0 -` form rather than unary minus for HLSLcc parity (both are bit-identical in GLSL).

**Type rules.** int in, int out → `intBitsToFloat` wrapper.

**Helpers.** None.

**Edge cases.** `-INT_MIN` wraps (GLSL highp two's-complement wrap matches D3D).

**WebGL2 notes.** None.

**Confidence: high.**

---

## 15. `countbits` (count 3)

**Semantics.** Component-wise population count of the 32-bit value (D3D11 `countbits`), result in [0,32].

**GLSL lowering** (lines 3303-3331): builtin `bitCount`, with the source swizzle collapsed to the **destination's component mask** (comment lines 3312-3322; `dstCompCount` at 3324, applied to the source at 3328) so input/output arity agrees:

```glsl
// countbits r0.x, r1.x
r0.x = intBitsToFloat(bitCount(floatBitsToInt(r1.x)));
```

**Caution:** unlike most opcodes, HLSLcc writes this dest **without** `AddAssignToDest` (lines 3326-3329, direct `TranslateOperand(dst, TO_FLAG_INTEGER | TO_FLAG_DESTINATION)`) because its typed-temp system gives it a real ivec dest. Under our float-vec4 storage the emitter **must** add the `intBitsToFloat` wrapper itself, as shown — this is a documented divergence in mechanism (not semantics) from the authority.

**Type rules.** `bitCount` is `genIType bitCount(genIType)` (also accepts genUType→genIType) — in ES 3.10. Read source as int, result int → `intBitsToFloat`.

**Helpers.** **Required on WebGL2**: `bitCount` is a GLSL ES **3.10** builtin (ES 3.10 spec §8.8) and does **not exist in GLSL ES 3.00** — HLSLcc emits it unconditionally (line 3327, no version guard). Emit a parallel-popcount helper instead:

```glsl
int dx11_countbits(int value) {
    uint v = uint(value);
    v = v - ((v >> 1u) & 0x55555555u);
    v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
    v = (v + (v >> 4u)) & 0x0F0F0F0Fu;
    return int((v * 0x01010101u) >> 24u);
}
// r0.x = intBitsToFloat(dx11_countbits(floatBitsToInt(r1.x)));
```

**Edge cases.** None; defined for all inputs (helper is branch-free, shifts/masks only — all core ES 3.00).

**WebGL2 notes.** `bitCount` is **not** available in GLSL ES 3.00 (WebGL2) — the helper is mandatory; forced divergence from HLSLcc, same class as `ubfe`/`ibfe` (§10).

**Confidence: high** on semantics; medium-high on the write-path note (divergence is forced by our storage model and is behavior-preserving).

---

## Helpers summary

| Helper | Needed by | Source | Status |
|---|---|---|---|
| `int_bitfieldInsert` (scalar int) | `bfi` | Verbatim from `toGLSL.cpp:1172-1180` (see §12) | Required on ES 3.00 — HLSLcc's own ES300 branch uses it (line 3401) |
| `dx11_udiv` (uint + uvec2/3/4) | `udiv` quotient | §11; `b == 0u ? 0xFFFFFFFFu : a / b` | Required; zero-guard is a deliberate D3D-conformance extension over HLSLcc's raw `/` |
| `dx11_umod` (uint + uvec2/3/4) | `udiv` remainder | §11; `b == 0u ? 0xFFFFFFFFu : a % b` | Required; same note |
| `dx11_ubfe` / `dx11_ibfe` (scalar, `(value, offset, bits)`) | `ubfe`/`ibfe` | §10; D3D11 pseudocode transcription | Required on WebGL2 — `bitfieldExtract` is ES 3.10-only; HLSLcc's ES300 output is non-conformant here |
| `dx11_countbits` (scalar int→int popcount) | `countbits` | §15 | Required on WebGL2 — `bitCount` is ES 3.10-only; same class of forced divergence |
| `dx11_ftou` / `dx11_ftoi` (scalar float→uint/int, clamped, NaN→0) | `ftou`/`ftoi` hardening | §8 | **Optional** — default path is HLSLcc-parity bare casts |

Everything else in the family lowers to core GLSL ES 3.00 builtins (`unpackHalf2x16`, `packHalf2x16`, `min`, `max`) and operators, plus the universal bitcast quartet `floatBitsToInt` / `floatBitsToUint` / `intBitsToFloat` / `uintBitsToFloat`. (`bitfieldExtract`, `bitfieldInsert`, `bitCount`, `findMSB`, `findLSB`, `bitfieldReverse` are all GLSL ES 3.10 — never emit them for WebGL2.)

Per `../shaderdiscovery/AGENT-FINDINGS/decisions/020-helper-lowering-confidence-boundary.md`: emitting these helpers does not make helper-using shaders "done" — they stay medium confidence until GLSL compile validation and semantic fixtures pass (`f16tof32`: basiccloud; `udiv`: hazespherical; `ushr`: filmgrain; `ftou`: avatarbrdfcombined_detailed are the named corpus probes in `../shaderdiscovery/TRANSPILING-GAPS.md:354-359`).
