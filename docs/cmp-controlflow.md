# DXBC → GLSL ES 3.00 lowering spec: `cmp-controlflow` family

Status: implementation spec, derived from HLSLcc source (authority #1). Every template below is what
`vendor/HLSLcc/src/toGLSLInstruction.cpp` emits for `LANG_ES_300`, re-expressed for this project's
register model. Line numbers cite `vendor/HLSLcc/src/toGLSLInstruction.cpp` unless
another file is named.

Opcodes covered (30): `and or xor not` · `lt ge eq ne ilt ige ieq ine ult uge` · `movc` ·
`if else endif` · `loop endloop break breakc continue` · `switch case default endswitch` ·
`ret retc discard`.

---

## 0. Family-wide conventions

### 0.1 Register model and bitcast notation

The JS emitter stores every temp register as `highp vec4` (float bits). All integer/uint reads and
writes are bitcasts at the use site, exactly as HLSLcc does when a register's inferred data type
differs from the requested type (`toGLSLOperand.cpp` `GetBitcastOp`, lines 327–353):

| Notation in this doc | Emitted GLSL | HLSLcc flag |
|---|---|---|
| `F(op)`  | raw float read, swizzle applied | `TO_FLAG_NONE` |
| `I(op)`  | `floatBitsToInt(op.swz)` | `TO_FLAG_INTEGER` / `TO_AUTO_BITCAST_TO_INT` |
| `U(op)`  | `uvecN(floatBitsToUint(op.swz))` | `TO_FLAG_UNSIGNED_INTEGER` |
| `asF_i(x)` | `intBitsToFloat(x)` before storing to a float-vec4 dest | `AddOpAssignToDestWithMask`, lines 123–143 |
| `asF_u(x)` | `uintBitsToFloat(x)` before storing to a float-vec4 dest | same |

Two ES-specific quirks the emitter MUST reproduce:

1. **`uvecN(...)` constructor around `floatBitsToUint`** — on ES targets HLSLcc wraps every
   uint bitcast in an explicit uint constructor because Adreno may treat `floatBitsToUint`'s
   return as signed (`toGLSLOperand.cpp` lines 608–613, case 1256567). So `U(r0.xy)` is
   `uvec2(floatBitsToUint(r0.xy))`, not bare `floatBitsToUint(r0.xy)`.
2. **`uint(0)` instead of `0u`** in comparisons — old ES 3.0 Adreno drivers treat `0u` as a const
   int (lines 292–294, 324–326, 2141; `toGLSLOperand.cpp` 390–392). Always emit `uint(0)` /
   `uint(0u)` for a zero uint literal.

All registers, varyings and comparisons must be `highp`: `floatBitsToUint`/`intBitsToFloat` on
mediump values does not round-trip bit patterns.

### 0.2 THE mask convention (read this before implementing anything)

SM4+ DXBC comparison instructions (`lt ge eq ne ilt ige ieq ine ult uge`) do **not** produce
booleans. They write a **32-bit mask per component**: `0xFFFFFFFF` for true, `0x00000000` for
false (HLSLcc's own comment at `AddComparison`, lines 176–183, and the caveat comment at
`OPCODE_GE`, lines 2691–2694). Downstream code then:

- combines masks **bitwise** with `and`/`or`/`xor`/`not` (an `and` of a mask with raw float bits
  is the classic branch-free select: `0xFFFFFFFF & bits == bits`, `0 & bits == 0 == +0.0f`);
- selects per component with `movc` by testing each condition component for **any bit set**
  (`!= 0`), not for `== 0xFFFFFFFF`;
- feeds scalar components into `if/breakc/retc/discard`, which test **zero vs nonzero** according
  to the instruction's boolean-test bit (`OpcodeToken0` bit 18: `0` = `_z` zero-test, `1` = `_nz`
  nonzero-test — decision shard `018-dxbc-instruction-controls-*`, and HLSLcc
  `psInst->eBooleanTestType` / `INSTRUCTION_TEST_ZERO|NONZERO`).

Because our storage is float vec4, a mask stored to a register is `uintBitsToFloat(0xFFFFFFFFu)`
(a NaN bit pattern) or `+0.0`. **Never** route a mask through float arithmetic or `mix()` — only
through bitcasts, bitwise ops, and `!= 0` tests. HLSLcc explicitly refuses `mix()` for exactly
this reason (lines 421–422 and 2594–2596: "mix() … propagates NaN from both endpoints").

### 0.3 Saturate (`_sat`) and write masks

- Destination write mask: HLSLcc prints the dest with its mask (`r0.xz = ...`) and sizes the RHS
  constructor to the mask's element count (`AddOpAssignToDestWithMask`, lines 28–153). Comparison
  intrinsic results get the dest swizzle applied to select the matching lanes (line 234).
- `_sat` is decoded from `OpcodeToken0 & 0x00002000` and applied by HLSLcc as a **separate
  follow-up statement** after the instruction body, clamping the just-written components
  (lines 4821–4846): `r0.xz = clamp(r0.xz, 0.0, 1.0);` (the `#ifdef UNITY_ADRENO_ES3`
  `min(max(x,0.0),1.0)` variant may be ignored for WebGL2). The JS emitter may instead clamp
  inline before the store; either is conformant, but the follow-up-statement form is what HLSLcc
  does and is safest with multi-statement lowerings (`movc` per-component path).
- `_sat` is legal only on float-result instructions. In this family that is effectively only
  `movc` (and it does appear on `movc` in real corpora). Comparisons, bitwise ops and control
  flow never carry `_sat`; assert/ignore if encountered.

### 0.4 The conditional test (`if` / `breakc` / `retc` / `continuec`), one function

HLSLcc routes all four through `ToGLSL::TranslateConditional` (lines 2089–2152). For our
typeless model (`argType` never `SVT_BOOL`, never `SVT_INT`), the emitted test is the
uint path (lines 2125–2150):

```glsl
// <op0> is ALWAYS a single selected component in DXBC (scalar swizzle .x/.y/.z/.w)
if (uvec1_bits != uint(0)) ...   // _nz  (INSTRUCTION_TEST_NONZERO)
if (uvec1_bits == uint(0)) ...   // _z   (INSTRUCTION_TEST_ZERO)
// where uvec1_bits = uint(floatBitsToUint(rN.c))
```

Signed vs unsigned bitcast is irrelevant for a zero test; HLSLcc uses uint here and int in
`discard` — both are correct. Do **not** use `any()`/vector tests: the DXBC operand of these
instructions is scalar by construction (the draft transpiler's `dx11_condition(vecN)` `any()`
overloads are dead weight and must not change semantics — treat as hypothesis, superseded).

---

## 1. Float comparisons — `lt` (4730), `ge` (9116), `eq` (429), `ne` (401)

### Semantics
Component-wise IEEE float comparison of src1 vs src2; per component the dest receives
`0xFFFFFFFF` if true else `0x00000000` (D3D11 `lt`/`ge`/`eq`/`ne` — ordered for `lt/ge/eq`,
**unordered** for `ne`). HLSLcc: `OPCODE_LT` line 2890, `OPCODE_GE` line 2689, `OPCODE_EQ`
line 4037, `OPCODE_NE` line 2860, all calling `AddComparison(psInst, CMP_*, TO_FLAG_NONE)`
(lines 173–334).

### GLSL lowering (AddComparison, SM4+ non-bool dest ⇒ `floatResult = 0`)
Vector dest (destElemCount > 1), lines 206–248:

```glsl
// lt r0.xz, r1.yyww, r2.xxzz   →
r0.xz = uintBitsToFloat(uvec2(lessThan(F(r1.yyww), F(r2.xxzz)).xz) * 0xFFFFFFFFu);
```

Structure: `dest.mask = uintBitsToFloat( uvecN( <intrinsic>(srcA, srcB).destSwz ) * 0xFFFFFFFFu );`
`uvecN(bvecN)` yields 0/1 per lane; `* 0xFFFFFFFFu` upscales to the mask (lines 238–241).
Intrinsic per `ComparisonType` (lines 208–213): `equal`, `lessThan`, `greaterThanEqual`,
`notEqual`.

Scalar dest (destElemCount == 1), lines 249–333:

```glsl
// ge r0.x, r1.w, l(0.5)   →
r0.x = uintBitsToFloat((F(r1.w) >= 0.5) ? 0xFFFFFFFFu : uint(0));
```

Operators (lines 251–256): `==`, `<`, `>=`, `!=`. The `#ifdef UNITY_ADRENO_ES3` duplicate block
(lines 260–301) is a Unity driver workaround; the JS emitter should emit only the plain form
(lines 303–329).

If one source is scalar and the other vector, auto-expand the scalar to the vector width
(lines 194–199, `TO_AUTO_EXPAND_TO_VEC*` — emit `vec2(s)`, `vec3(s)`, `vec4(s)` around the
scalar read).

### Type rules
Sources read as **raw float** (`TO_FLAG_NONE`, no bitcast). Result type is **uint mask**, stored
through `uintBitsToFloat` (dest is float-stored). Comparison result is NOT a bool and NOT 1.0/0.0.

### Helpers needed
None — fully inline. (Optionally the emitter may wrap the vector form in a `dx11_lt/ge/eq/ne`
helper family as the draft does; the draft's mask math at `Dx11GlesDraftTranspiler.js` 1201–1228
matches this spec and may be kept, but helpers must produce exactly the pattern above.)

### Edge cases
- **NaN**: D3D defines `lt/ge/eq` ordered (any NaN operand ⇒ false ⇒ `0x0`) and `ne` unordered
  (any NaN ⇒ true ⇒ `0xFFFFFFFF`). GLSL ES 3.00 makes NaN handling partially
  implementation-defined; ANGLE/desktop back-ends follow IEEE, some mobile GPUs may not. Do not
  add NaN fix-ups; document the residual risk instead.
- `+0.0 == -0.0` is true (mask set) in both D3D and GLSL.
- `_sat` never occurs on comparisons.
- The `* 0xFFFFFFFFu` overflow-wraps per GLSL uint rules — well-defined.

### WebGL2 notes
`0xFFFFFFFFu` hex uint literals are legal in GLSL ES 3.00. Keep the `uvecN(...)` ctor wrap and
`uint(0)` zero literal (§0.1). Everything must be highp.

### Confidence
**High** — direct, unambiguous HLSLcc code path with explicit comments about the mask convention.

---

## 2. Int/uint comparisons — `ilt` (100), `ige` (770), `ieq` (126), `ine` (122), `ult` (354), `uge` (441)

### Semantics
Same mask-producing comparison, but operands are interpreted as two's-complement int32
(`ilt/ige/ieq/ine`) or uint32 (`ult/uge`). HLSLcc: `OPCODE_ILT` 2880, `OPCODE_IGE` 2870,
`OPCODE_IEQ` 2900, `OPCODE_INE` 2850 → `AddComparison(CMP_*, TO_FLAG_INTEGER)`;
`OPCODE_ULT` 2910, `OPCODE_UGE` 2920 → `AddComparison(CMP_*, TO_FLAG_UNSIGNED_INTEGER)`.

### GLSL lowering
Identical structure to §1 with bitcast source reads:

```glsl
// ige r0.x, r1.x, l(4)          (scalar)
r0.x = uintBitsToFloat((floatBitsToInt(r1.x) >= 4) ? 0xFFFFFFFFu : uint(0));

// ult r1.xy, r2.xyxx, r3.xyxx   (vector)
r1.xy = uintBitsToFloat(uvec2(lessThan(uvec4(floatBitsToUint(r2.xyxx)),
                                       uvec4(floatBitsToUint(r3.xyxx))).xy) * 0xFFFFFFFFu);
```

### Type rules
- `ilt/ige/ieq/ine`: sources `I(...)` = `floatBitsToInt`; int immediates print as signed decimal,
  except values > `0x3FFFFFFE` which print as `int(0xXXXXXXXXu)` (`toGLSLOperand.cpp`
  printImmediate32, lines 375–387).
- `ult/uge`: sources `U(...)` = `uvecN(floatBitsToUint(...))`; uint immediates print as `Nu`
  (`uint(0u)` for zero on ES, lines 388–395).
- Result: uint mask via `uintBitsToFloat`, exactly as §1.

### Helpers needed
None (inline).

### Edge cases
- There is no NaN issue; int compare is exact.
- Sign matters: `ilt` on `0xFFFFFFFF` (= -1) vs `0` is true; `ult` on the same bits is false.
  Never substitute one family for the other.
- `ieq/ine` are frequently used on masks themselves (mask == 0 tests); bit-exactness of the
  float-vec4 round-trip is required — see §9 WebGL2 note on preserving NaN bit patterns.

### WebGL2 notes
Same as §1. `lessThan/greaterThanEqual/equal/notEqual` all have `ivecN`/`uvecN` overloads in
GLSL ES 3.00.

### Confidence
**High** — same code path as §1 with only the type flag changed.

---

## 3. Bitwise — `and` (11134), `or` (535), `xor` (213), `not` (3)

### Semantics
32-bit bitwise AND/OR/XOR/complement per component. In SM4+ output these overwhelmingly operate
on comparison masks (branch-free selects: `and` of a mask and float bits) and on integer flag
words. D3D `not` is one's-complement (`~`).

### GLSL lowering
HLSLcc has special fast paths when data-type analysis proved an operand is `SVT_BOOL`
(`OPCODE_OR` 2437–2508, `OPCODE_AND` 2513–2681). **Those paths are unreachable in this project**
(no type analysis; everything is float-stored bits). The applicable paths are:

- `and`: `CallBinaryOp("&", …, SVT_UINT)` — line 2684.
- `or`:  `CallBinaryOp("|", …, SVT_UINT)` — line 2510.
- `xor`: `CallBinaryOp("^", …, SVT_UINT)` — line 4731.

`CallBinaryOp` (507–590) with a uint dest on a float-stored register emits:

```glsl
// and r0.xyz, r1.xyzx, r2.xyzx  →  canonical form
r0.xyz = uintBitsToFloat(uvec3(floatBitsToUint(r1.xyzx).xyz) & uvec3(floatBitsToUint(r2.xyzx).xyz));
```

**Adreno note (lines 555–581):** for `LANG_ES_300` HLSLcc splits vector `& | ^ << >>` into
per-component scalar ops inside a constructor, because Adreno 3xx miscompiles vector bitwise ops
(each scalar uint read still gets the §0.1 ES ctor wrap, `uint(...)` for one component):

```glsl
r0.xyz = uintBitsToFloat(uvec3(uint(floatBitsToUint(r1.x)) & uint(floatBitsToUint(r2.x)),
                               uint(floatBitsToUint(r1.y)) & uint(floatBitsToUint(r2.y)),
                               uint(floatBitsToUint(r1.z)) & uint(floatBitsToUint(r2.z))));
```

The JS emitter SHOULD emit the split form to match HLSLcc's ES300 behavior; the vector form is
spec-legal GLSL ES 3.00 and acceptable if we decide to drop Adreno-3xx-class devices — record
whichever choice is made as an emitter-wide policy, not per opcode.

`not` (`OPCODE_NOT`, 4693–4722): for ES300 HLSLcc **always** uses the `op_not` helper (condition
at line 4701 explicitly includes `LANG_ES_300`; Adreno ICEs on `~a`):

```glsl
// not r0.x, r0.x
r0.x = intBitsToFloat(op_not(floatBitsToInt(r0.x)));
```

Scalar/vector auto-expand: if src widths differ, expand the scalar side (lines 544–548).

### Type rules
- `and/or/xor`: both sources `U(...)`; result uint, stored via `uintBitsToFloat`.
- `not`: source `I(...)`; result int, stored via `intBitsToFloat` (HLSLcc uses `SVT_INT` here,
  line 4706 — complement is bit-identical for int and uint).
- Mask algebra guarantee: `mask & floatBits` yields either the float bits unchanged or `0x0`
  (`+0.0`), and `mask1 | mask2`, `mask1 ^ mask2`, `~mask` stay canonical all-ones/all-zeros masks.

### Helpers needed
`op_not` (from `toGLSL.cpp` lines 1167–1171 plus `PrintComponentWrapper1`):

```glsl
int   op_not(int value) { return -value - 1; }
ivec2 op_not(ivec2 a) { a.x = op_not(a.x); a.y = op_not(a.y); return a; }
ivec3 op_not(ivec3 a) { a.x = op_not(a.x); a.y = op_not(a.y); a.z = op_not(a.z); return a; }
ivec4 op_not(ivec4 a) { a.x = op_not(a.x); a.y = op_not(a.y); a.z = op_not(a.z); a.w = op_not(a.w); return a; }
```

(`-value - 1 == ~value` in two's complement, including `INT_MIN` under GLSL's wrapping rules.)

### Edge cases
- `and` with a mask and NaN-bit float data is the normal case — must stay purely bitwise.
- `_sat` never occurs (D3D forbids saturate on integer ops).
- `xor` with `0xFFFFFFFF` immediates is how fxc negates masks (`not` is nearly absent from the
  corpus: 3 instances vs 213 `xor`).

### WebGL2 notes
`& | ^ ~ << >>` all exist in GLSL ES 3.00; the split-scalar and `op_not` choices are purely
driver-bug hygiene inherited from HLSLcc, not spec requirements.

### Confidence
**High** for the uint bitwise path; **medium** on the decision to keep/drop the Adreno
per-component split (policy, not semantics).

---

## 4. `movc` (5026) — conditional move / per-component select

### Semantics
`movc dest, src0, src1, src2`: for each dest component, if the corresponding src0 component has
**any bit set** (`!= 0`), copy the src1 component, else the src2 component (HLSLcc's verbatim
comment, lines 362–374; D3D11 `movc`). This is the consumer of comparison masks.

### GLSL lowering (`AddMOVCBinaryOp`, lines 351–505; dispatched at `OPCODE_MOVC`, 2930–2938)

**Case A — src0 is scalar or replicate-swizzled** (`s0ElemCount == 1 || IsSwizzleReplicated()`,
lines 377–418): single ternary, condition read once from `.x`-equivalent component:

```glsl
// movc r0.xyz, r1.xxxx, r2.xyzx, r3.xyzx
r0.xyz = (floatBitsToInt(r1.x) != 0) ? F(r2.xyzx).xyz : F(r3.xyzx).xyz;
```

Condition bitcast: int (`TO_AUTO_BITCAST_TO_INT`, line 389) with `!= 0` (line 403). If src1/src2
are scalar while dest is vector, auto-expand them (`vec3(s)`, lines 406–415).

**Case B — vector src0** (lines 419–504): one statement **per dest component** (no `mix()`,
lines 421–422):

```glsl
// movc r0.xz, r1.xxzz, r2.xyzw, r3.xyzw   (destSwz walks x,z; srcElem walks the same positions)
r0.x = (floatBitsToInt(r1.x) != 0) ? F(r2.x) : F(r3.x);
r0.z = (floatBitsToInt(r1.z) != 0) ? F(r2.z) : F(r3.z);
```

Component pairing rule (lines 456–489): iterate `destElem` 0..3, skip components not in the dest
write mask; the source component index used for src0/src1/src2 is the **positional** element
(`1 << srcElem` where `srcElem` increments every loop iteration including skipped ones — i.e.
POS-swizzle: dest component k reads swizzle slot k of each source).

**Aliasing guard (lines 427–454, 492–503):** if dest is the same register as src1 or src2, the
sequential per-component writes would corrupt later reads. HLSLcc wraps the statements in a block
computing into `hlslcc_movcTemp` and copies back:

```glsl
{
    vec4 hlslcc_movcTemp = r0;
    hlslcc_movcTemp.x = (floatBitsToInt(r1.x) != 0) ? F(r2.x) : F(r3.x);
    hlslcc_movcTemp.z = (floatBitsToInt(r1.z) != 0) ? F(r2.z) : F(r3.z);
    r0 = hlslcc_movcTemp;
}
```

The guard is also required when dest aliases **src0** in our emitter (HLSLcc only checks
src1/src2 because its condition reads precede the write per statement — with per-statement
emission dest==src0 is only unsafe if a written component is later read as a condition; apply
the temp whenever dest register == any source register for safety).

### Type rules
src0 read as `I(...)` and tested `!= 0` (any-bit-set — NOT `== -1`, NOT `bool()`); src1/src2 read
in the **dest's** data type — in our model, raw float (no bitcast), which preserves bits for
float data. Result: float store, no wrap. If the surrounding code moved int data through `movc`,
bits are still preserved because no arithmetic conversion happens.

### Helpers needed
None required. (The draft's `dx11_movc` helpers, `Dx11GlesDraftTranspiler.js` 1317–1320, are
semantically compatible — condition tested per component on raw bits `!= 0` — but they force
full-vector evaluation and cannot express the aliasing-temp or mixed widths; prefer inline.)

### Edge cases
- **NaN**: masks are NaN-patterned floats; ternary select is bit-safe, `mix()` is forbidden.
- `_sat` on `movc` is legal and observed: apply §0.3 (clamp the written components after the
  last per-component statement / after the temp copy-back).
- src0 tested per D3D as "any bit set", so `-0.0` (`0x80000000`) counts as TRUE. The int bitcast
  `!= 0` handles this correctly; a float `!= 0.0` test would not. Never test conditions in float.
- Replicated swizzle detection (Case A) is an optimization only; emitting Case B for everything
  is semantically identical.

### WebGL2 notes
Nothing forbidden; ternaries on scalars are fine. Keep everything highp.

### Confidence
**High** — the HLSLcc path is explicit, commented, and battle-tested; the only local addition is
the widened aliasing guard (defensive, conservative).

---

## 5. Structured branches — `if` (2148), `else` (1136), `endif` (2148)

### Semantics
DXBC SM4/5 control flow is fully structured; `if`/`else`/`endif` map 1:1 to a GLSL block. `if`
carries the boolean-test bit: `if_z r0.x` or `if_nz r0.x`, testing the single selected component
of a (usually mask) register against zero.

### GLSL lowering
- `if` (`OPCODE_IF`, 3851–3869) → `TranslateConditional` (§0.4) with an opening brace, then
  indent+1:

```glsl
if (uint(floatBitsToUint(r0.x)) != uint(0)) {      // if_nz r0.x
if (uint(floatBitsToUint(r0.x)) == uint(0)) {      // if_z  r0.x
```

- `else` (`OPCODE_ELSE`, 3883–3900): dedent, `} else {`, indent.
- `endif` (`OPCODE_ENDIF`, 3919–3935): dedent, `}`.

### Type rules
Condition operand: scalar component read as uint bits (int equally valid), compared to zero.
The test direction comes from `OpcodeToken0` bit 18 (`INSTRUCTION_TEST_NONZERO` when set).
No result register.

### Helpers needed
None.

### Edge cases
- The operand is a mask in ~all corpus cases but may be any bits (e.g. a counter); zero-vs-nonzero
  on raw bits is always the correct test.
- Gradient/implicit-LOD texture samples inside non-uniform `if` bodies produce undefined
  derivatives — pre-existing DXBC property, do not "fix".
- Nesting depth is bounded (D3D 64); no emitter action needed.

### WebGL2 notes
None; plain structured `if/else` is universal.

### Confidence
**High**.

---

## 6. Loops — `loop` (946), `endloop` (946), `break` (347), `breakc` (946), `continue` (9)

### Semantics
`loop`/`endloop` delimit an infinite structured loop; the only exits are `break`/`breakc`
(and `ret`/`retc`/`discard`). `breakc_z`/`breakc_nz` is a conditional break testing a scalar
component against zero. `continue` jumps to the next iteration (`continuec` is its conditional
form — 0 in corpus but trivially supported).

### GLSL lowering
- `loop` (`OPCODE_LOOP`, 3622–3775). HLSLcc has a for-loop reconstruction when loop inductors
  were detected (`m_LoopInductors`, lines 3650–3754, including the NVidia-OSX operand-order
  workaround at 3681–3689). That is an **optimization pass we do not have**; the baseline —
  and HLSLcc's own fallback (lines 3769–3773) — is:

```glsl
while(true){
```

  (The bounded-`for` rewrite at 3757–3768 is `LANG_ES_100`/WebGL1-only; not applicable to
  GLSL ES 3.00.)

- `endloop` (`OPCODE_ENDLOOP`, 3777–3789): dedent, `}`.
- `break` (`OPCODE_BREAK`, 3791–3812): `break;` (the other branch of that case is switch-to-if
  conversion state, ES2-only — see §7).
- `breakc` (`OPCODE_BREAKC`, 3814–3837) → `TranslateConditional` with statement `break`
  (lines 2094–2097, 2143–2146):

```glsl
if (uint(floatBitsToUint(r0.x)) != uint(0)) {break;}    // breakc_nz r0.x
if (uint(floatBitsToUint(r0.x)) == uint(0)) {break;}    // breakc_z  r0.x
```

- `continue` (`OPCODE_CONTINUE`, 3937–3941): `continue;`.
  `continuec` (`OPCODE_CONTINUEC`, 3839–3849): same `TranslateConditional` shape with
  `{continue;}`.

### Type rules
As §0.4: scalar uint-bits zero test, direction from the test bit. No results.

### Helpers needed
None.

### Edge cases
- Every corpus `loop` contains a `breakc` (946/946); still, `while(true)` without a provable
  bound is legal in GLSL ES 3.00 — no iteration-cap hack needed (that is a WebGL1-only
  restriction).
- `break` inside a `loop` that is itself inside a DXBC `switch` binds to the **innermost**
  construct in both DXBC and GLSL — correct by direct mapping, but see §7 for `break` directly
  inside `switch`.
- Extremely long loops can still hit browser watchdog/TDR; not an emitter concern.

### WebGL2 notes
`while(true)` + `break` is fine in GLSL ES 3.00 (WebGL2). Do not port WebGL1 loop-bounding.
Some ANGLE versions unroll/analyze loops slowly, but correctness is unaffected.

### Confidence
**High** for the baseline lowering. The for-inductor reconstruction is explicitly out of scope
(pure optimization; skipping it cannot change semantics).

---

## 7. `switch` (42), `case` (270), `default` (36), `endswitch` (42)

### Semantics
DXBC structured switch on a scalar 32-bit selector. `case` operands are 32-bit immediates.
D3D asm allows fall-through **only** as consecutive `case` labels sharing one block; every
non-empty case block ends in `break` (or `ret`/`continue`). `break` inside a switch exits the
switch.

### GLSL lowering (non-ES2 path; the `m_SwitchStack` machinery at 2154+, 3985–4035 `else`
branches is ES2 if/else conversion — ignore it entirely for GLSL ES 3.00)
- `switch` (`OPCODE_SWITCH`, 3992–4000):

```glsl
switch(floatBitsToInt(r0.x)){
```

  (selector translated with `TO_FLAG_INTEGER`; indent increases by 2 — case labels sit one
  level in, statements two levels in.)
- `case` (`OPCODE_CASE`, 4018–4028): temporary dedent by 1, then

```glsl
case 2:
```

  Immediate printed as signed int (`printImmediate32`: decimal, or `int(0xXXXXXXXXu)` if
  > `0x3FFFFFFE` — `toGLSLOperand.cpp` 375–387).
- `default` (`OPCODE_DEFAULT`, 3943–3952): `default:` at case-label depth.
- `break` inside the switch (`OPCODE_BREAK`): `break;`.
- `endswitch` (`OPCODE_ENDSWITCH`, 3902–3917): closes with `}` and drops both indent levels.

### Type rules
Selector: `I(...)` scalar. Case labels: `int` constant expressions — the label type MUST match
the selector type in GLSL ES 3.00 (both int here). No results.

### Helpers needed
None.

### Edge cases
- Consecutive `case` labels (DXBC fall-through form) emit consecutive GLSL labels — legal.
- GLSL ES 3.00 **forbids a trailing label with no statement** before `}`. DXBC guarantees a
  `break` (or other terminator) ends each block, but a defensive emitter should append `break;`
  before `}` if the last emitted token was a label.
- Declarations inside a case block are scoped to the whole switch body in GLSL; our emitter
  declares all temps at function scope, so this is moot.
- `case` values are raw 32-bit immediates: a selector produced by `ftoi` etc. compares signed;
  if the DXBC used the same bits consistently, signed labels are always correct.

### WebGL2 notes
`switch` is fully supported in GLSL ES 3.00 (it was the ES2 target that forced HLSLcc's
if/else conversion). Selector must be scalar `int`/`uint` — never float.

### Confidence
**Medium-high** — the HLSLcc path is clear, but switch is rare in the corpus (42) and the
trailing-label rule and label-type matching are GLSL-spec constraints HLSLcc never had to state
explicitly; flag for a compile-time fixture.

---

## 8. `ret` (6592), `retc` (0), `discard` (683)

### `ret`

**Semantics.** Return from the current subroutine — in vs/ps `main`, end shader invocation.
Every DXBC program ends with `ret`; early `ret` inside control flow is common (6592 vs 1611
effects ⇒ multiple per stage).

**GLSL lowering** (`OPCODE_RET`, 3221–3246): if the current phase has post-shader code
(epilogue), paste it **before every** `return;` (lines 3228–3243), then:

```glsl
return;
```

**Placement rules for the JS emitter:**
1. Define the stage epilogue once (output copy-out / `gl_Position` fix-ups, if any).
2. Emit `epilogue; return;` at **every** `ret`, including the final one.
3. The final `ret` at top level may alternatively fall off the end of `main` after the epilogue —
   emitting `return;` anyway is harmless and simpler; HLSLcc emits it.

**Type rules.** No operands.
**Helpers.** None.
**Edge cases.** A `ret` inside a loop/switch exits the shader, not the construct — `return;`
matches. Unreachable trailing code after top-level `ret` is legal GLSL.
**WebGL2 notes.** None.
**Confidence.** **High**.

### `retc` (retc_z / retc_nz)

**Semantics.** Conditional return; scalar zero/nonzero test like `breakc`.

**GLSL lowering** (`OPCODE_RETC`, 3871–3881 → `TranslateConditional`, statement `return`,
lines 2102–2105):

```glsl
if (uint(floatBitsToUint(r0.x)) != uint(0)) {return;}
```

**Known HLSLcc deficiency (line 2102: "FIXME! Need to spew out shader epilogue"):** HLSLcc does
NOT emit the epilogue before this `return`. Our emitter MUST do better: expand to

```glsl
if (uint(floatBitsToUint(r0.x)) != uint(0)) { /*epilogue*/ return; }
```

whenever the stage epilogue is non-empty.

**Confidence.** **Medium** — zero corpus instances (`retc:0`), the lowering is trivial but the
epilogue interaction is untested; implement defensively.

### `discard` (discard_z / discard_nz)

**Semantics.** Pixel-shader only: kill the fragment if the scalar operand tests zero (`_z`) or
nonzero (`_nz`). NOT unconditional — the draft's earlier unconditional `discard;` was wrong and
already retracted (decision shard 018, "discard is conditional").

**GLSL lowering** (`OPCODE_DISCARD`, SM4+ paths 4133–4158; the `ui32MajorVersion <= 3` path
4118–4132 is SM1–3 only, ignore):

```glsl
if((floatBitsToInt(r0.x))==0){discard;}     // discard_z  r0.x   (lines 4133–4144)
if((floatBitsToInt(r0.x))!=0){discard;}     // discard_nz r0.x   (lines 4145–4158)
```

(HLSLcc uses `TO_FLAG_INTEGER` here — int bitcast — vs uint in `TranslateConditional`; both are
valid zero tests. The `useDirectTest` bool fast path is unreachable in our typeless model.)

**Type rules.** Scalar int-bits zero test; test direction from bit 18. No result.
**Helpers.** None.
**Edge cases.** `discard` inside a loop also terminates the loop trivially (fragment is dead);
derivatives after a discard-divergent branch are undefined — pre-existing. In vertex stage:
illegal; assert.
**WebGL2 notes.** `discard` valid in fragment shaders only. Some drivers still execute
subsequent texture fetches for derivative purposes — no action.
**Confidence.** **High** — direct code path plus a validated project decision shard.

---

## 9. Cross-cutting edge cases and emitter mandates

1. **Mask bit-exactness through float storage.** `0xFFFFFFFF` is a float NaN pattern. GLSL ES
   3.00 does not guarantee NaN bit patterns survive a float **copy** on all hardware (registers
   are copied as floats: `r0 = r1;`, `r0.xz = ...` stores). In practice ANGLE-backed WebGL2
   preserves bits for simple moves/stores; this is THE load-bearing assumption of the
   float-vec4 model (same assumption HLSLcc makes when types are unknown). Mitigations if a
   platform breaks: keep masks out of float temporaries by fusing compare+consume, or store
   masks as `1.0/0.0` floats project-wide. **Do not** partially mix conventions.
2. **highp everywhere.** All temp registers, and any varying feeding comparisons, must be
   declared `highp`. mediump would corrupt both bitcasts and 32-bit masks.
3. **No `mix()` for selects, ever** (lines 421–422, 2594–2596).
4. **Scalar conditions only** for `if/breakc/retc/continuec/discard` — DXBC guarantees a single
   selected component; do not emit `any()`/`all()`.
5. **Indentation/nesting is emitter state**: `if/else/endif`, `loop/endloop`,
   `switch/case/default/endswitch` are pure block delimiters; the emitter maintains a block stack
   and must reject malformed nesting (HLSLcc asserts implicitly via structure).
6. **Instruction-controls decode** (validated, shard 018): `_sat` = bit 13 (`0x2000`); test mode =
   bit 18 (0 ⇒ `_z`, 1 ⇒ `_nz`); source modifiers (`neg`/`abs`/`absneg`) apply to source reads
   before any template in this doc. `neg` on an integer-typed read must emit int negation on the
   bitcast value (`-floatBitsToInt(x)`), not float negation.

---

## Helpers summary

Required by this family:

| Helper | Needed by | Source |
|---|---|---|
| `op_not` (int, ivec2, ivec3, ivec4 overloads) | `not` (ES300 Adreno ICE workaround; HLSLcc uses it unconditionally on ES300) | `toGLSL.cpp` 1167–1171: `int op_not(int value) { return -value - 1; }` + per-component wrappers (§3) |

Everything else in the family lowers inline with GLSL built-ins (`floatBitsToInt`,
`floatBitsToUint`, `intBitsToFloat`, `uintBitsToFloat`, `lessThan`, `greaterThanEqual`, `equal`,
`notEqual`, `clamp`, ternary select, native `& | ^`).

Optional consolidation helpers (NOT required; if kept from the draft they must match this spec
exactly): `dx11_mask` (bvecN → mask-float), `dx11_lt/ge/eq/ne/ilt/ige/ieq/ult/uge`
(draft lines 1201–1248 — semantics verified against `AddComparison`), `dx11_and/or/xor`
(draft 1249+ — verified against `CallBinaryOp`), `dx11_movc` (draft 1317–1320 — verified but
cannot express the aliasing temp; prefer inline), scalar `dx11_condition(float)`
(draft 1205 — verified). The draft's vector `dx11_condition(vecN)` overloads using `any()`
(draft 1206–1208) are **not** part of this spec — conditional operands are scalar.
