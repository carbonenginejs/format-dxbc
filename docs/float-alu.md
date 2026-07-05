# DXBC -> GLSL ES 3.00 Lowering Spec: `float-alu` family

Status: specification for verbatim implementation. Target: GLSL ES 3.00 (WebGL2), vertex + pixel
stages, no SSBOs/compute.

Opcodes covered (21), with corpus instruction counts from the 450k-instruction / 1611-effect sweep:

| opcode | count | opcode | count | opcode | count |
|---|---|---|---|---|---|
| mad | 54335 | mul | 49656 | mov | 46775 |
| add | 36862 | dp4 | 36534 | dp3 | 26120 |
| div | 9596 | sincos | 2402 | dp2 | 3959 |
| max | 5617 | rsq | 4578 | sqrt | 5110 |
| exp | 3113 | log | 2691 | min | 3089 |
| round_ni | 452 | frc | 1253 | round_ne | 168 |
| round_z | 166 | rcp | 15 | round_pi | 3 |

## 0. Ground truth and authority order

1. `vendor/HLSLcc/src/toGLSLInstruction.cpp` (per-opcode lowering, this is what is
   cited below; all line numbers refer to this file unless another file is named).
2. `vendor/HLSLcc/src/toGLSLOperand.cpp` (bitcast/operand printing machinery).
3. `vendor/HLSLcc/src/HLSLccToolkit.cpp` (`SVTTypeToFlag`, `TypeFlagsToSVTType`,
   `DoAssignmentDataTypesMatch`).
4. `vendor/HLSLcc/CARBONENGINEJS-FORK.md` (register-stable ABI: this does not change
   float-alu semantics, but confirms registers/cbuffers keep stable `cb#`/`t#`/`s#`/`r#` names and
   that constant-buffer operands may fall back to `cbN.data[i]` — the operand-printing layer this
   family's `TranslateOperand()` calls into is unaffected by opcode choice).
5. `../shaderdiscovery/TRANSPILING-GAPS.md` and `../shaderdiscovery/AGENT-FINDINGS/decisions/*.md`
   (validated corrections — notably 020-dxbc-sincos-lowering-correction.md: sincos is a
   multi-destination instruction, skip `null` destinations, do not run it through the
   single-destination saturate/result-modifier wrapper path).
6. `../shaderdiscovery/src/core/transpiler/gles/Dx11GlesDraftTranspiler.js` — hints only, never
   compiled. Cross-checked below; where it agrees with HLSLcc that is noted, where it takes a
   shortcut (e.g. scalar `1.0 / a` for `rcp` instead of HLSLcc's `vec4(1.0)/vec4(a)`, or inlined
   `sin`/`cos` instead of naming a helper) HLSLcc wins.

## 1. General model (applies to every opcode below)

### 1.1 Destination assignment machinery

Every instruction in this family funnels through `ToGLSL::AddOpAssignToDestWithMask`
(`toGLSLInstruction.cpp:28-153`, exposed for the common case as `AddAssignToDest`,
`toGLSLInstruction.cpp:155-159`) followed by the RHS expression and
`ToGLSL::AddAssignPrologue` (`toGLSLInstruction.cpp:161-171`) which closes parentheses and appends
`;\n`. The emitted shape is always:

```
<dest-with-writemask> = <possible-type-constructor>( <rhs-expression> );
```

Key rule for **write-mask/component-count mismatches**: if the destination's active write-mask
component count (`ui32DestElementCount`) is greater than the RHS's component count
(`ui32SrcElementCount`) and the assignment's dest/src types already match, HLSLcc wraps the RHS in
a same-size constructor call, e.g. `r0.xyz = vec3( <scalar-rhs> );` (`toGLSLInstruction.cpp:69-80`).
**This is the write-mask broadcast mechanism** the dot-product opcodes rely on (see 1.3) and is
also what makes `mov r0.xyzw, c0.x` legal GLSL (`r0 = vec4(c0.x);`).

If dest/src types differ, `AddOpAssignToDestWithMask` instead wraps the RHS in the appropriate
GLSL ES 3.00 bit-reinterpretation built-in — `intBitsToFloat`/`uintBitsToFloat` when writing a
float destination, `floatBitsToInt`/`floatBitsToUint` when writing an int/uint destination
(`toGLSLInstruction.cpp:82-140`; the actual built-in name table is
`GetBitcastOp` in `toGLSLOperand.cpp:327-353`). None of this family's opcodes hit that branch in
HLSLcc's own emission for the *source* reads (see 1.2), but the JS emitter must still keep the
machinery available since MOV can carry any bit pattern.

### 1.2 Source operand reads: which opcodes bitcast, which don't

This is the load-bearing subtlety for a from-scratch emitter without HLSLcc's whole-program
data-type analysis:

- `mov` (`AddMOVBinaryOp`, `toGLSLInstruction.cpp:336-349`), `add`/`mul`/`div` (`CallBinaryOp`,
  `toGLSLInstruction.cpp:507-590`), `mad` (`CallTernaryOp`, `toGLSLInstruction.cpp:592-621`), and
  the hand-written `rcp` (`toGLSLInstruction.cpp:4488-4508`) all read their source operands with
  **no explicit bitcast wrapper** — `CallBinaryOp`/`CallTernaryOp` are invoked with
  `eDataType = SVT_FLOAT`, and `SVTTypeToFlag(SVT_FLOAT)` returns `TO_FLAG_NONE`
  (`HLSLccToolkit.cpp:21-43`), i.e. plain read. HLSLcc gets away with this because its data-type
  analysis has already declared the temp register itself as `float`/`vec4` at the point it is
  read.
- `max`/`min` (`CallHelper2`, `toGLSLInstruction.cpp:655-685`), `dp2`/`dp3` (hand-written,
  `toGLSLInstruction.cpp:2804-2839`), `dp4` (`CallHelper2`, `toGLSLInstruction.cpp:2840-2849`),
  and every opcode routed through `CallHelper1` — `sqrt`, `rsq`, `exp`, `log`, `frc`,
  `round_pi`, `round_ni`, `round_z`, `round_ne`, and the two `sincos` calls
  (`toGLSLInstruction.cpp:745-762`, `2765-2802`, `2953-3120`) — hardcode
  `ui32Flags = TO_AUTO_BITCAST_TO_FLOAT` on every source read, meaning: if the operand's declared
  type is int/uint, wrap it in `intBitsToFloat`/`uintBitsToFloat`; if it is already float, this is
  a no-op.

**Practical rule for this emitter** (registers are uniformly `vec4` float, no per-register type
tracking): since storage is always float, both of the above cases degenerate to "read the vec4
directly, no wrapper call" — there is no behavioral difference in *this* emitter's output between
the two groups. Document it anyway because it tells the engineer which opcodes are safe to read
raw even if a later optimization pass adds typed-register tracking, and it is the reason `max`/
`min`/`sqrt`/`rsq`/`exp`/`log`/`frc`/round family/`sincos`/`dp2`/`dp3`/`dp4` are the ones where
HLSLcc is defensive about a source having arrived from an integer/bitwise producer, while `mov`/
`add`/`mul`/`mad`/`div`/`rcp` are not.

### 1.3 Write-mask broadcast for scalar-producing opcodes (dp2/dp3/dp4)

`dp2`/`dp3`/`dp4` all produce a scalar `dot()` result but may be written through a multi-component
destination write-mask (e.g. `dp3 r0.xyz, v0.xyz, v1.xyz` broadcasting the same dot product into
`r0.x`, `r0.y`, `r0.z`). HLSLcc achieves this purely through the section-1.1 mechanism: it calls
`AddAssignToDest(..., SVT_FLOAT, /*srcElementCount=*/1, ...)` regardless of the destination's
actual write-mask width, so if the destination mask asks for more than 1 component,
`AddOpAssignToDestWithMask` wraps the scalar `dot(...)` call in a `vecN(...)` constructor, which
GLSL broadcasts across all N components. The emitted shape is exactly:

```glsl
r0.xyz = vec3(dot(v0.xyz, v1.xyz));
```

### 1.4 Saturate (`_sat`) placement

Saturate is **not** inlined into the instruction's own expression. It is applied by
`ToGLSL::TranslateInstruction` as a second, separate statement emitted immediately after the
opcode's own statement, once per instruction, regardless of which opcode it is
(`toGLSLInstruction.cpp:4821-4846`):

```glsl
<dest> = <opcode-specific-rhs>;
<dest> = clamp(<dest>, 0.0, 1.0);
```

The re-read of `<dest>` on the RHS uses `TO_AUTO_BITCAST_TO_FLOAT` (so if the destination register
were int/uint-typed it would be unwrapped with `intBitsToFloat`/`uintBitsToFloat` first — moot for
this emitter's uniform float storage). HLSLcc also has a Unity-specific `#ifdef UNITY_ADRENO_ES3`
branch that emits `min(max(x,0.0),1.0)` instead of `clamp()` as a driver-bug workaround
(`toGLSLInstruction.cpp:4827-4845`); **do not port this** — it is gated on a Unity build macro this
project does not have, and there is no corpus evidence tying it to EVE Online DX11 effects. Always
emit plain `clamp(x, 0.0, 1.0)`.

Saturate is a per-instruction flag (`psInst->bSaturate`) valid only on float-producing opcodes —
DXBC only ever sets it there (see the assertion comment at `toGLSLInstruction.cpp:4821`), so every
opcode in this family is a legal saturate target. **sincos is the one exception the emitter must
special-case**: per
`../shaderdiscovery/AGENT-FINDINGS/decisions/020-dxbc-sincos-lowering-correction.md`, sincos is a
multi-destination instruction and must not be run through a single-destination result-modifier
(saturate) wrapper keyed off "operand 0" — if DXBC sets saturate on a sincos instruction, clamp
*both* non-null destinations independently, each with its own `clamp(dst, 0.0, 1.0)` statement.

### 1.5 Comparison-mask convention — not applicable to this family

This family contains no comparison opcodes (`eq`/`ne`/`lt`/`ge`/`ilt`/`ige`/`ult`/`uge`/etc. belong
to a separate compare/logic family and are lowered through `AddComparison`,
`toGLSLInstruction.cpp:173-334`, producing `0xFFFFFFFF`/`0x00000000` masks rather than GLSL
`bool`). None of `mov`/`mad`/`mul`/`add`/`dp*`/`div`/`max`/`min`/`sqrt`/`rsq`/`rcp`/`exp`/`log`/
`frc`/`round_*`/`sincos` read or produce comparison masks; `max`/`min` are plain
value-selecting float ops, not predicated selects (that's `movc`, also a different family).

### 1.6 Helper naming convention

No opcode in this family requires a *custom* named helper function — every lowering is either a
GLSL ES 3.00 core built-in (`dot`, `sin`, `cos`, `sqrt`, `inversesqrt`, `exp2`, `log2`, `fract`,
`floor`, `ceil`, `trunc`, `roundEven`, `min`, `max`, `clamp`) or a core bit-reinterpretation
built-in (`intBitsToFloat`, `uintBitsToFloat`, `floatBitsToInt`, `floatBitsToUint`). All of these
are guaranteed present in GLSL ES 3.00 core (see 1.7) with zero extension requirements, so "helpers
needed" per-opcode below list built-ins, not JS-emitted GLSL functions, except where noted.

### 1.7 WebGL2 / GLSL ES 3.00 blanket notes

- `roundEven()` and `trunc()` are **core** in GLSL ES 3.00 (they were not in GLSL ES 1.00 — HLSLcc
  gates a polyfill via `UseExtraFunctionDependency` only when `eTargetLanguage == LANG_ES_100`,
  `toGLSLInstruction.cpp:3020-3021, 3033-3034`). Since this project targets ES 3.00 exclusively,
  never emit that polyfill; call `trunc()`/`roundEven()` directly.
- `intBitsToFloat`/`uintBitsToFloat`/`floatBitsToInt`/`floatBitsToUint` are core in GLSL ES 3.00,
  no `#extension` pragma required.
- GLSL ES (unlike desktop GLSL) does not guarantee IEEE-754 NaN/Inf semantics on all hardware/
  precisions — see per-opcode Edge cases for `div`, `rcp`, `sqrt`, `rsq`, `log` below.
- Scalar `vecN(scalarExpr)` broadcast constructors (section 1.3) are always legal in GLSL ES 3.00
  and are the only WebGL2-safe way to fan a scalar HLSL result out to a masked vector LHS — GLSL
  does not allow implicit scalar-to-vector assignment through a swizzle (`v.xyz = scalarExpr;` is
  a compile error), so the constructor wrap is mandatory, not stylistic.

---

## 2. Per-opcode specifications

### `mov`

**Semantics**: Copies the source operand's value (component-wise, per active write-mask
components) into the destination, applying source modifiers (negate/abs) and destination write
mask. D3D11 `mov` is a bit-for-bit reinterpretation-agnostic move once the DXBC type analysis has
resolved both operand types; it can move floats, ints, or uints alike.

**GLSL lowering**: `ToGLSL::AddMOVBinaryOp` (`toGLSLInstruction.cpp:336-349`, invoked from
`OPCODE_MOV` at `2287-2332`):
```glsl
<dest>.<mask> = <srcType-constructor-if-widths-differ>( <src>.<swizzle> );
```
`eSrcType` is resolved as `pSrc->GetDataType(psContext, pDest->GetDataType(psContext))` — i.e. it
prefers the source's own declared type, falling back to the destination's declared type. The
destination-assign machinery (1.1) inserts a same-size constructor if `dest` write-mask is wider
than the source's swizzle count (e.g. `r0.xyzw = vec4(c0.x);`), and inserts a bitcast wrapper if
declared src/dest types differ.

**Type rules**: Because this emitter stores every register as a `vec4` float with no separate
declared type, `mov` degenerates to a **plain component-wise `vec4`/`vec3`/`vec2`/`float`
assignment respecting the destination write mask** — the underlying bit pattern is preserved
through a float-to-float copy regardless of what the bits "mean," so no bitcast call is emitted.
There is one HLSLcc-documented exception worth preserving in a comment but not in codegen: the
"Unity case 1158280" workaround (`toGLSLInstruction.cpp:2300-2328`) reclassifies a `mov` of an
*immediate* into an int-typed temp as float when data-type analysis couldn't prove the temp is
otherwise used as int — this is purely an artifact of HLSLcc's per-register type inference and has
no equivalent in a uniform-float-storage model (there is nothing to reclassify).

**Helpers needed**: none (plain assignment with a `vecN(...)` broadcast constructor when
widening).

**Edge cases**: Widening a scalar/partial source into a wider destination write mask broadcasts
that value into every masked destination component (constructor semantics), matching D3D11's "the
rest of the components are default filled" behavior for masked writes. NaN/Inf are moved verbatim
(no arithmetic applied).

**WebGL2 notes**: none beyond the general write-mask-broadcast note in section 1.7.

**Confidence**: high — directly cited to `toGLSLInstruction.cpp:2287-2332` and `336-349`; only
degenerate-storage-model reasoning (uniform float vec4) is inference, and that inference is
mandated by the task's own storage model.

---

### `mad`

**Semantics**: `dest = src0 * src1 + src2`, a fused float multiply-add, per-component over the
destination write mask.

**GLSL lowering**: `CallTernaryOp("*", "+", psInst, 0, 1, 2, 3, TO_FLAG_NONE)`
(`toGLSLInstruction.cpp:2372-2381`, `CallTernaryOp` body `592-621`):
```glsl
<dest>.<mask> = <src0>.<mask> * <src1>.<mask> + <src2>.<mask>;
```
This is a literal infix `a * b + c`, **not** a call to a fused-multiply-add built-in (`fma()` is
not used here — HLSLcc relies on the GLSL compiler to fuse it if the hardware supports true FMA;
functionally for this project, ordinary IEEE mul-then-add rounding is acceptable and matches
HLSLcc's own output byte-for-byte).

**Type rules**: `dataType = TO_FLAG_NONE` passed to `CallTernaryOp`; `TypeFlagsToSVTType(TO_FLAG_NONE)`
resolves to `SVT_FLOAT` (`HLSLccToolkit.cpp:45-56`, falls through to the final `return SVT_FLOAT`).
All three sources are read as float verbatim (see 1.2) — no bitcast wrapper in HLSLcc's own
emission, consistent with uniform-float storage.

**Helpers needed**: none — plain infix arithmetic.

**Edge cases**: If `src0`/`src1`/`src2` have mismatched component counts relative to each other
(e.g. one is a scalar/replicated-swizzle operand and another is a full vector), `CallTernaryOp`
adds a `TO_AUTO_EXPAND_TO_VEC{2,3,4}` flag sized to the largest operand
(`toGLSLInstruction.cpp:605-609`), which causes the narrower operand to print through a
broadcasting constructor (e.g. `vec3(scalarSrc)`) so the infix expression type-checks in GLSL.
Overflow/rounding follows ordinary IEEE-754 `float` semantics; no clamp unless `_sat` is set
(section 1.4).

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high — single, unconditional code path, directly cited.

---

### `mul`

**Semantics**: `dest = src0 * src1`, per-component float multiply over the destination write mask.

**GLSL lowering**: `CallBinaryOp("*", psInst, 0, 1, 2, SVT_FLOAT)`
(`toGLSLInstruction.cpp:2703-2712`, `CallBinaryOp` body `507-590`):
```glsl
<dest>.<mask> = <src0>.<mask> * <src1>.<mask>;
```

**Type rules**: `eDataType = SVT_FLOAT` -> `SVTTypeToFlag(SVT_FLOAT) == TO_FLAG_NONE`
(`HLSLccToolkit.cpp:21-43`) — sources read as float verbatim, no bitcast wrapper emitted (see 1.2).

**Helpers needed**: none.

**Edge cases**: Same mismatched-component-count auto-expand behavior as `mad`
(`toGLSLInstruction.cpp:544-548`). `mul` is also the one binary op where HLSLcc has an
Adreno-specific component-wise-unroll branch (`toGLSLInstruction.cpp:557-581`), but that branch is
gated on bitwise operator names (`&`,`|`,`^`,`>>`,`<<`) and never triggers for `"*"` — float `mul`
always emits the plain vector infix form.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high.

---

### `add`

**Semantics**: `dest = src0 + src1`, per-component float add over the destination write mask.

**GLSL lowering**: `CallBinaryOp("+", psInst, 0, 1, 2, SVT_FLOAT)`
(`toGLSLInstruction.cpp:2427-2436`):
```glsl
<dest>.<mask> = <src0>.<mask> + <src1>.<mask>;
```

**Type rules**: identical to `mul` — `SVT_FLOAT` -> `TO_FLAG_NONE`, no bitcast wrapper.

**Helpers needed**: none.

**Edge cases**: same auto-expand-on-mismatched-component-count rule as `mad`/`mul`.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high.

---

### `dp4`

**Semantics**: 4-component dot product; `dest.<mask> = dot(src0.xyzw, src1.xyzw)` broadcast to
every active destination component (D3D11 `dp4` always consumes all 4 components of both sources
regardless of the destination write mask).

**GLSL lowering**: `CallHelper2("dot", psInst, 0, 1, 2, /*paramsShouldFollowWriteMask=*/0)`
(`toGLSLInstruction.cpp:2840-2849`, `CallHelper2` body `655-685`). Because
`paramsShouldFollowWriteMask == 0`, `destMask` used for reading the *sources* is forced to
`OPERAND_4_COMPONENT_MASK_ALL` (`toGLSLInstruction.cpp:660`) — i.e. sources are always read in
full `.xyzw`, independent of the destination's own write mask. The destination write count is
forced to 1 (`isDotProduct` check, `toGLSLInstruction.cpp:665, 675`), then broadcast per section
1.3:
```glsl
<dest>.<mask> = vecN(dot(<src0>.xyzw, <src1>.xyzw));   // vecN elided to plain assignment if mask is a single component
```

**Type rules**: `CallHelper2` hardcodes `TO_AUTO_BITCAST_TO_FLOAT` on both source reads
(`toGLSLInstruction.cpp:658`) and forces the destination type to `SVT_FLOAT`
(`toGLSLInstruction.cpp:675`). See section 1.2 — with uniform float storage this is a plain read,
no wrapper text emitted.

**Helpers needed**: `dot()` (core GLSL built-in).

**Edge cases**: NaN in any component poisons the entire dot product (propagates through the sum).
No division, so no div-by-zero concern. Destination write-mask broadcast is mandatory — a `dp4`
targeting `.xy` writes the *same* scalar dot-product value into both `x` and `y`, this is not two
independent dot products.

**WebGL2 notes**: none beyond 1.7 (the write-mask-broadcast constructor rule from section 1.3
applies here directly).

**Confidence**: high — single unconditional code path.

---

### `dp3`

**Semantics**: 3-component dot product over `.xyz` of both sources, broadcast to the destination
write mask; `.w` of both sources is always ignored regardless of source swizzle.

**GLSL lowering**: hand-written, not through `CallHelper2` (`toGLSLInstruction.cpp:2822-2839`):
```glsl
<dest>.<mask> = dot( <src0-hardcoded-.xyz>, <src1-hardcoded-.xyz> );
```
Both sources are read with an explicit hardcoded component mask literal `7` (binary `0111` = `.xyz`)
passed as the `TranslateOperand` compMask argument (`toGLSLInstruction.cpp:2833, 2835`) combined
with `TO_AUTO_EXPAND_TO_VEC3` — this forces exactly 3 components regardless of the operand's own
swizzle or the destination's write mask. Destination is assigned with `ui32SrcElementCount = 1`
(`toGLSLInstruction.cpp:2831`), so the section-1.3 broadcast applies identically to `dp4`.

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT | TO_AUTO_EXPAND_TO_VEC3` on both source reads
(`toGLSLInstruction.cpp:2833, 2835`); destination forced to `SVT_FLOAT`, count 1.

**Helpers needed**: `dot()` (core GLSL built-in).

**Edge cases**: Same NaN-propagation and mandatory-broadcast notes as `dp4`. The 4th component of
each source register is never read, even if the DXBC source swizzle explicitly names it — HLSLcc
hardcodes the `.xyz` read mask, it does not defer to the instruction's own encoded source swizzle
beyond selecting *which* register components map to x/y/z.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high — directly cited, single code path.

---

### `dp2`

**Semantics**: 2-component dot product over `.xy` of both sources, broadcast to the destination
write mask.

**GLSL lowering**: hand-written (`toGLSLInstruction.cpp:2804-2821`):
```glsl
<dest>.<mask> = dot( <src0-hardcoded-.xy>, <src1-hardcoded-.xy> );
```
Hardcoded compMask literal `3` (binary `0011` = `.xy`) with `TO_AUTO_EXPAND_TO_VEC2`
(`toGLSLInstruction.cpp:2815, 2817`). Destination assigned with count 1, broadcast per 1.3.

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT | TO_AUTO_EXPAND_TO_VEC2` on both source reads;
destination forced `SVT_FLOAT`, count 1.

**Helpers needed**: `dot()` (core GLSL built-in). Note: unlike `dp3`/`dp4`, GLSL ES 3.00 has no
native 2-component-only concern here — `dot(vec2, vec2)` is a core overload, no emulation needed.

**Edge cases**: Same NaN-propagation and mandatory-broadcast notes as `dp3`/`dp4`. Lowest corpus
count in the dot-product trio (3959) — still common enough to require full fidelity, not a stub.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high — directly cited, single code path, structurally identical to `dp3`.

---

### `div`

**Semantics**: `dest = src0 / src1`, per-component float divide over the destination write mask.
D3D11 defines float divide by zero as producing signed infinity (nonzero/0) or NaN (0/0),
consistent with IEEE-754.

**GLSL lowering**: `CallBinaryOp("/", psInst, 0, 1, 2, SVT_FLOAT)`
(`toGLSLInstruction.cpp:2755-2764`):
```glsl
<dest>.<mask> = <src0>.<mask> / <src1>.<mask>;
```

**Type rules**: `SVT_FLOAT` -> `TO_FLAG_NONE`, sources read verbatim (see 1.2); same auto-expand
rule on component-count mismatch as `add`/`mul`/`mad`.

**Helpers needed**: none — plain infix `/`.

**Edge cases**: **GLSL ES does not guarantee IEEE-754 divide-by-zero semantics** on all hardware/
precision qualifiers (unlike D3D11, which mandates it) — some mobile GPUs may produce an
implementation-defined finite value instead of ±Inf/NaN for `x/0.0`. This is a genuine
cross-platform risk for any EVE effect relying on `div`-by-zero producing Inf (e.g. as an
`isinf`-style guard elsewhere) and should be flagged to QA/visual-diff rather than "fixed" in the
lowering — HLSLcc does not special-case it either, so faithfully reproducing `a / b` is the
correct-per-spec choice here.

**WebGL2 notes**: `highp float` is required in GLSL ES 3.00 fragment shaders for arithmetic that
needs IEEE range/precision; if the destination is UI/`mediump`-influenced, divide-by-zero behavior
is even less guaranteed. Not directly actionable by this family's lowering (declaration/precision
policy lives in `toGLSLDeclaration.cpp`), but worth a code comment at the `div` call site.

**Confidence**: high on the lowering shape; medium on precisely how div-by-zero will behave on
target GPUs (spec explicitly leaves it unspecified).

---

### `max`

**Semantics**: `dest = max(src0, src1)`, per-component, IEEE `max` (D3D11 float `max` propagates
the non-NaN operand when exactly one input is NaN, matching GLSL's `max()` on conforming
hardware).

**GLSL lowering**: `CallHelper2("max", psInst, 0, 1, 2, 1)` (`toGLSLInstruction.cpp:3075-3084`,
`paramsShouldFollowWriteMask = 1` so sources are read following the destination's own write mask,
unlike `dp4`):
```glsl
<dest>.<mask> = max( <src0>.<mask>, <src1>.<mask> );
```

**Type rules**: `CallHelper2` hardcodes `TO_AUTO_BITCAST_TO_FLOAT` on both source reads
(`toGLSLInstruction.cpp:658`) — per section 1.2 this is the group that explicitly bitcasts (a
no-op under uniform float storage). Destination forced to `SVT_FLOAT`.

**Helpers needed**: `max()` (core GLSL built-in, float overloads for scalar/vec2/vec3/vec4).

**Edge cases**: NaN-with-one-operand behavior depends on the underlying GLSL ES implementation's
`max()` — the spec does not mandate IEEE-754 minNum/maxNum semantics, so exact NaN-propagation
parity with D3D11 is not guaranteed across all WebGL2 backends (flag as risk, do not attempt a
custom NaN-safe `max` — that would itself diverge from HLSLcc's own (non-)handling).

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high on lowering shape; low-medium on NaN-edge parity (inherent GLSL ES spec gap,
not something the lowering can fix).

---

### `min`

**Semantics**: `dest = min(src0, src1)`, per-component, same IEEE/NaN caveats as `max`.

**GLSL lowering**: `CallHelper2("min", psInst, 0, 1, 2, 1)` (`toGLSLInstruction.cpp:3111-3120`):
```glsl
<dest>.<mask> = min( <src0>.<mask>, <src1>.<mask> );
```
Structurally identical to `max`.

**Type rules**: identical to `max` — `TO_AUTO_BITCAST_TO_FLOAT` on both sources.

**Helpers needed**: `min()` (core GLSL built-in).

**Edge cases**: identical caveats to `max`.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high on lowering shape; low-medium on NaN-edge parity, same reasoning as `max`.

---

### `sqrt`

**Semantics**: `dest = sqrt(src)`, per-component. D3D11 `sqrt` of a negative operand produces NaN
(no error/trap).

**GLSL lowering**: `CallHelper1("sqrt", psInst, 0, 1, 1)` (`toGLSLInstruction.cpp:2983-2992`,
`CallHelper1` body `745-762`):
```glsl
<dest>.<mask> = sqrt( <src>.<mask> );
```

**Type rules**: `CallHelper1` hardcodes `TO_AUTO_BITCAST_TO_FLOAT` on the source read
(`toGLSLInstruction.cpp:748`) — group-2 opcode per section 1.2, no-op under uniform float storage.
Destination forced `SVT_FLOAT`.

**Helpers needed**: `sqrt()` (core GLSL built-in).

**Edge cases**: `sqrt(negative)` — GLSL ES 3.00 spec: "results are undefined if x < 0" for
`sqrt()`, whereas D3D11 defines it as NaN. Most WebGL2 implementations do return NaN in practice
(they implement it via a genuine sqrt instruction with IEEE semantics on desktop-class and most
mobile GPUs), but this is implementation-defined per spec, not guaranteed — flag as a corpus risk
if any EVE shader relies on `sqrt`-of-negative behaving as a defined NaN sentinel.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high on lowering shape; medium on negative-input edge parity (spec leaves it
undefined, matching the general GLSL ES posture on invalid-domain built-ins).

---

### `rsq`

**Semantics**: `dest = 1/sqrt(src)`, per-component reciprocal square root. D3D11 defines
`rsq(0) = +Inf`, `rsq(negative) = NaN`.

**GLSL lowering**: `CallHelper1("inversesqrt", psInst, 0, 1, 1)`
(`toGLSLInstruction.cpp:2963-2972`):
```glsl
<dest>.<mask> = inversesqrt( <src>.<mask> );
```

**Type rules**: same as `sqrt` — `TO_AUTO_BITCAST_TO_FLOAT` on the source (no-op here).

**Helpers needed**: `inversesqrt()` (core GLSL built-in).

**Edge cases**: GLSL ES 3.00 spec: "results are undefined if x <= 0" for `inversesqrt()` — this is
strictly wider than D3D11's carve-out (D3D defines `rsq(0)`; GLSL leaves the whole `x <= 0` domain
undefined, including exactly zero). This is the **single highest-risk edge case in the entire
family** for a normalize()-heavy engine like EVE's shaders (rsq is extremely common in normalize
chains, `4578` corpus hits) — a source vector of exactly zero length hitting `rsq(0)` could
legitimately return `Inf`, a large finite number, or an implementation-defined NaN depending on
GPU/driver, unlike D3D11's guaranteed `+Inf`. No portable fix exists at the lowering level (HLSLcc
itself does not special-case it); document and let visual-diff testing catch regressions.

**WebGL2 notes**: none beyond 1.7 (this is a spec-level gap, not GLSL-ES-vs-desktop-GLSL
divergence — desktop GLSL's `inversesqrt` has the same "undefined for x <= 0" language).

**Confidence**: high on lowering shape; **low** on zero/negative-input parity — call this out to
the implementing engineer explicitly, it is a real corpus-relevant risk (rsq is used 4578 times,
almost certainly dominated by `normalize()`-style `rsq(dot(v,v))` patterns where `v` can be exactly
zero, e.g. degenerate tangent vectors).

---

### `rcp`

**Semantics**: `dest = 1/src`, per-component reciprocal. D3D11 defines `rcp(±0) = ±Inf`,
`rcp(±Inf) = ±0`.

**GLSL lowering**: hand-written, not through `CallBinaryOp` (`toGLSLInstruction.cpp:4488-4508`):
```glsl
<dest>.<mask> = vecN(1.0) / vecN( <src>.<destAccessMaskSwizzle> );
```
Concretely, both the numerator `1.0` and the denominator are wrapped in a same-width vector
constructor sized to `destElemCount` (`toGLSLInstruction.cpp:4500-4503`), and the source is read
with the **destination's** access mask/swizzle (`toGLSLInstruction.cpp:4505`), not its own natural
swizzle count. Note the draft transpiler (`Dx11GlesDraftTranspiler.js:1868-1869`) instead emits a
bare scalar `1.0 / a` — **do not follow that shortcut**; for a masked multi-component destination
HLSLcc's `vecN(1.0)/vecN(src)` form is required to type-check and to correctly reciprocate every
active component (a scalar `1.0 / a.xyz` would not compile as `1.0` is untyped-scalar but `a.xyz`
is `vec3` — GLSL does allow scalar/vector mixed arithmetic via implicit scalar promotion, so `1.0 /
vec3` is actually legal GLSL and elementwise-equivalent; still, match HLSLcc's literal emitted
shape for byte-level parity and to avoid relying on implicit scalar promotion inconsistently
elsewhere in the family).

**Type rules**: source read with `TO_FLAG_NONE` (`toGLSLInstruction.cpp:4505`) — group-1 opcode
per section 1.2, no bitcast wrapper, plain float read.

**Helpers needed**: none — plain infix division with constructor-wrapped operands.

**Edge cases**: `rcp(0)` — same GLSL ES caveat as `div`/`sqrt`/`rsq`: divide-by-zero is not
IEEE-754-guaranteed across all GLSL ES implementations, so `+Inf` is likely but not certain on all
target GPUs. Lowest-priority opcode in the family by corpus count (**15** occurrences total across
1611 effects) — implement for completeness/correctness but do not spend extra validation budget
here relative to `rsq`/`div`.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high on lowering shape (directly cited); medium on zero-input parity (same
spec-level gap as `div`/`sqrt`/`rsq`).

---

### `exp`

**Semantics**: DXBC `exp` is **base-2** exponentiation: `dest = 2^src`, per-component. (D3D11 ISA
`exp` is always base-2; there is no separate natural-log-base opcode — HLSL's `exp()` intrinsic,
which is natural-base `e^x`, compiles down to DXBC as `log`/`exp` combined with a
`0.6931472` (`ln(2)`) multiply constant folded by the HLSL compiler *before* DXBC emission, so by
the time this opcode is reached in the bytecode it is unconditionally base-2.)

**GLSL lowering**: `CallHelper1("exp2", psInst, 0, 1, 1)` (`toGLSLInstruction.cpp:2973-2982`):
```glsl
<dest>.<mask> = exp2( <src>.<mask> );
```
Confirmed also in `../shaderdiscovery/TRANSPILING-GAPS.md:339` ("`exp` and `log` lower to `exp2`
and `log2`" — listed under "Already handled").

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT` on the source (group-2 per 1.2, no-op here).

**Helpers needed**: `exp2()` (core GLSL built-in). **Do not use `exp()`** — that is natural-base
and would silently change the numeric result for every use site; this is the single most
important base-mixup risk in the family given the explicit family focus on "exp/log base-2 vs
natural."

**Edge cases**: Large positive `src` can overflow to `+Inf` in `highp float`; GLSL ES 3.00's
`exp2()` spec does not mandate overflow-to-Inf behavior either (implementation-defined for
out-of-range results), consistent with the general float-range caveats in this family.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high — directly cited, corroborated by an independent validated-decisions doc.

---

### `log`

**Semantics**: DXBC `log` is **base-2** logarithm: `dest = log2(src)`, per-component. D3D11 defines
`log(0) = -Inf`, `log(negative) = NaN`. Same base-2-not-natural caveat as `exp` above — this is the
inverse operation and shares the same DXBC-level base convention.

**GLSL lowering**: `CallHelper1("log2", psInst, 0, 1, 1)` (`toGLSLInstruction.cpp:2953-2962`):
```glsl
<dest>.<mask> = log2( <src>.<mask> );
```

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT` on the source (group-2 per 1.2, no-op here).

**Helpers needed**: `log2()` (core GLSL built-in). **Do not use `log()`** (natural-base) — same
base-mixup risk called out for `exp`.

**Edge cases**: GLSL ES 3.00 spec for `log2()`: "results are undefined if x <= 0" — wider than
D3D11's defined `log(0) = -Inf`/`log(negative) = NaN` split. Same class of risk as `rsq`/`sqrt`:
zero or negative input is a real possibility if `log` is ever fed an unclamped value (e.g. a
`dot()` result that could be exactly zero), and the result is implementation-defined rather than a
guaranteed `-Inf`/`NaN`.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high on lowering shape and base-2 fidelity (independently corroborated by
TRANSPILING-GAPS.md); medium on zero/negative-input parity (spec-level gap, same family as
`sqrt`/`rsq`).

---

### `frc`

**Semantics**: `dest = src - floor(src)`, per-component fractional part. Always non-negative for
finite input (D3D11 `frc` matches HLSL's `frac()`).

**GLSL lowering**: `CallHelper1("fract", psInst, 0, 1, 1)` (`toGLSLInstruction.cpp:3039-3048`):
```glsl
<dest>.<mask> = fract( <src>.<mask> );
```
GLSL's `fract(x)` is defined as `x - floor(x)`, an exact semantic match to D3D11 `frc`.

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT` on the source (group-2 per 1.2, no-op here).

**Helpers needed**: `fract()` (core GLSL built-in).

**Edge cases**: For very large `|src|`, floating-point precision loss in `src - floor(src)` can
produce results outside `[0,1)` on some hardware (a `highp`-vs-`mediump` precision concern);
document but do not special-case — this matches HLSLcc's own unconditional `fract()` emission.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high.

---

### `round_ne`

**Semantics**: Round-to-nearest-even (banker's rounding), per-component. D3D11 `round_ne` ties
round to the nearest even integer.

**GLSL lowering**: `CallHelper1("roundEven", psInst, 0, 1, 1)` (`toGLSLInstruction.cpp:3026-3038`):
```glsl
<dest>.<mask> = roundEven( <src>.<mask> );
```
HLSLcc gates a JS/GLSL-ES-1.00 polyfill via `UseExtraFunctionDependency("roundEven")` only when
`eTargetLanguage == LANG_ES_100` (`toGLSLInstruction.cpp:3033-3034`) — **irrelevant for this
project**, since `roundEven()` is a core GLSL ES 3.00 built-in (see 1.7). Call it directly, no
helper needed.

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT` on the source (group-2 per 1.2, no-op here).

**Helpers needed**: `roundEven()` (core in GLSL ES 3.00 — no polyfill needed, unlike HLSLcc's
ES 1.00 path).

**Edge cases**: Exact-half ties (e.g. `2.5`) round to the nearest even integer (`2.0`), not
away-from-zero — verify this against GLSL ES 3.00's `roundEven()` spec text, which matches
IEEE-754 roundTiesToEven, so no divergence expected from D3D11.

**WebGL2 notes**: no polyfill required (core built-in) — simpler than HLSLcc's own multi-target
code path.

**Confidence**: high.

---

### `round_ni`

**Semantics**: Round toward negative infinity (floor), per-component.

**GLSL lowering**: `CallHelper1("floor", psInst, 0, 1, 1)` (`toGLSLInstruction.cpp:3003-3012`):
```glsl
<dest>.<mask> = floor( <src>.<mask> );
```

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT` on the source (group-2 per 1.2, no-op here).

**Helpers needed**: `floor()` (core GLSL built-in).

**Edge cases**: none beyond ordinary floating-point `floor()` semantics; exact match to D3D11.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high.

---

### `round_pi`

**Semantics**: Round toward positive infinity (ceiling), per-component.

**GLSL lowering**: `CallHelper1("ceil", psInst, 0, 1, 1)` (`toGLSLInstruction.cpp:2993-3002`):
```glsl
<dest>.<mask> = ceil( <src>.<mask> );
```

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT` on the source (group-2 per 1.2, no-op here).

**Helpers needed**: `ceil()` (core GLSL built-in).

**Edge cases**: none beyond ordinary floating-point `ceil()` semantics.

**WebGL2 notes**: none beyond 1.7. Only **3** corpus occurrences across the entire 1611-effect
sweep — implement for completeness, minimal validation budget needed.

**Confidence**: high (trivial, single code path) though essentially unexercised by the corpus.

---

### `round_z`

**Semantics**: Round toward zero (truncate), per-component.

**GLSL lowering**: `CallHelper1("trunc", psInst, 0, 1, 1)` (`toGLSLInstruction.cpp:3013-3025`):
```glsl
<dest>.<mask> = trunc( <src>.<mask> );
```
Same ES-1.00-only polyfill gate as `round_ne` (`toGLSLInstruction.cpp:3020-3021`,
`UseExtraFunctionDependency("trunc")`) — irrelevant here since `trunc()` is core in GLSL ES 3.00.

**Type rules**: `TO_AUTO_BITCAST_TO_FLOAT` on the source (group-2 per 1.2, no-op here).

**Helpers needed**: `trunc()` (core in GLSL ES 3.00, no polyfill needed).

**Edge cases**: none beyond ordinary floating-point `trunc()` semantics.

**WebGL2 notes**: no polyfill required.

**Confidence**: high.

---

### `sincos`

**Semantics**: Dual-output instruction: computes `sin(src)` into destination operand 0 and
`cos(src)` into destination operand 1, per-component, from a single shared angle source operand
(operand 2). Either destination may be `OPERAND_TYPE_NULL` if the shader does not need that output
(very common — many effects only want `sin` or only want `cos`).

**GLSL lowering**: hand-written (`toGLSLInstruction.cpp:2765-2802`), each destination lowered
independently via `CallHelper1`:
```glsl
<sinDest>.<mask> = sin( <angleSrc>.<mask> );   // only if sinDest is not null
<cosDest>.<mask> = cos( <angleSrc>.<mask> );   // only if cosDest is not null
```
**Ordering hazard**: if the sin-destination register **aliases** the angle-source register (same
operand type and register number), HLSLcc emits `cos` *first*, then `sin`
(`toGLSLInstruction.cpp:2773-2788`) — because writing `sin`'s result into that register first would
corrupt the source value `cos` still needs to read. When there is no aliasing, the natural order
(`sin` then `cos`) is used (`toGLSLInstruction.cpp:2790-2800`). **This ordering check must be
replicated exactly** — getting it backwards silently corrupts `cos` output only in the aliased
case, which is easy to miss in testing. Per
`../shaderdiscovery/AGENT-FINDINGS/decisions/020-dxbc-sincos-lowering-correction.md`: treat
`sincos` as a genuinely multi-destination instruction, skip null destinations outright (do not
emit an assignment to a placeholder), and do not route it through a single-destination
result-modifier (saturate) wrapper — apply `_sat` (if set) to each non-null destination
independently after its own `sin`/`cos` statement (see section 1.4).

**Type rules**: `CallHelper1` hardcodes `TO_AUTO_BITCAST_TO_FLOAT` on the shared angle-source read
for both the `sin` and `cos` calls (group-2 per 1.2, no-op under uniform float storage).
Destination type forced to `SVT_FLOAT` for both outputs.

**Helpers needed**: `sin()`, `cos()` (core GLSL built-ins). No custom helper — this is a case where
the draft transpiler's inline `sin(...)`/`cos(...)` emission
(`Dx11GlesDraftTranspiler.js:1722-1731`) already agrees with HLSLcc's approach (both correctly
gate on `isWritableDestination`/null-operand checks), **except** the draft does not replicate the
alias-ordering hazard above — that must still be added when porting logic from the draft.

**Edge cases**: Standard `sin`/`cos` range/precision behavior; no special NaN/Inf beyond what an
out-of-range or NaN angle source would already produce (propagates through). The
register-aliasing reordering above is the only DXBC-specific correctness hazard, not a numeric
edge case.

**WebGL2 notes**: none beyond 1.7.

**Confidence**: high on the dual-output/null-skip/alias-ordering shape (directly cited to
`toGLSLInstruction.cpp:2765-2802` and independently corroborated by a validated decisions doc);
this is also the second-highest corpus count in the family among the "harder" opcodes (2402
instances) so the alias-ordering hazard is worth explicit unit-test coverage, not just a code
comment.

---

## 3. Helpers summary

No custom/named JS-emitted GLSL helper functions are required anywhere in this family — every
opcode lowers to a GLSL ES 3.00 **core built-in**. The full built-in surface this family depends
on:

| Built-in | Used by | Core in GLSL ES 3.00? |
|---|---|---|
| `dot()` | dp2, dp3, dp4 | yes |
| `sin()`, `cos()` | sincos | yes |
| `sqrt()` | sqrt | yes |
| `inversesqrt()` | rsq | yes |
| `exp2()` | exp | yes |
| `log2()` | log | yes |
| `fract()` | frc | yes |
| `floor()` | round_ni | yes |
| `ceil()` | round_pi | yes |
| `trunc()` | round_z | yes (no ES-1.00-style polyfill needed) |
| `roundEven()` | round_ne | yes (no ES-1.00-style polyfill needed) |
| `min()`, `max()` | min, max | yes |
| `clamp()` | saturate (`_sat`), any opcode | yes |
| `intBitsToFloat()`, `uintBitsToFloat()`, `floatBitsToInt()`, `floatBitsToUint()` | bitcast machinery (section 1.1/1.2), latent for `mov` and any mixed-type path | yes, no extension pragma |

No plain infix-only opcodes (`mad`, `mul`, `add`, `div`, `rcp`, `mov`) need an entry here beyond
`*`, `+`, `/` and constructor syntax (`vecN(...)`), which are language primitives, not built-in
functions.
