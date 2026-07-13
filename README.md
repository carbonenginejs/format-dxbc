# @carbonenginejs/format-dxbc

Pure-JavaScript CarbonEngineJS-facing reader for Microsoft DXBC (Direct3D
compiled shader bytecode). No native tooling, no build step; it runs in Node
and the browser.

CarbonEngine and Fenris Creations (CCP Games) are named in this package for
interoperability and target-ecosystem context only. DXBC itself is a Microsoft
format, and this package contains no CarbonEngine or Fenris Creations
(CCP Games) source code.

DXBC is not a CCP format — this package has no Carbon/Trinity vocabulary. It
parses the DXBC container and chunk directory, the input/output/patch
signatures, and decodes the complete SM4/SM5 instruction token stream
(218-opcode table, declarations included). The decoded instruction stream is
the contract shader-translation backends build against (`@carbonenginejs/format-webgl` for
GLSL ES 3.00, `@carbonenginejs/format-webgpu` later for WGSL).

## Install

```sh
npm install @carbonenginejs/format-dxbc
```

## Public API

The package root exports one public class: `CjsFormatDxbc`. The `Cjs` prefix
marks this as a CarbonEngineJS format/construction boundary, not an engine
runtime class. Internal container/signature/program/decoder machinery lives
under `src/core`; construction utilities destined for a shared Carbon library
live under `src/carbon`.

```js
import CjsFormatDxbc from "@carbonenginejs/format-dxbc";

// One-shot statics (camelCase by convention)
CjsFormatDxbc.isDxbc(bytes);                  // magic sniff
CjsFormatDxbc.inspect(bytes);                 // header/chunks/stage summary, no instruction decode
CjsFormatDxbc.read(bytes);                    // full decode, plain JSON data
CjsFormatDxbc.read(bytes, { emit: "raw" });   // container/program/decoder objects for backends

// Reusable profile
const reader = new CjsFormatDxbc({
    emit: "json",              // "json" (default) | "raw"
    source: "myshader.dxbc",   // name used in error details
    decodeInstructions: true   // false = container/signatures only
});
const result = reader.Read(bytes);
```

`emit: "json"` returns plain JSON-compatible data: container facts, program
header (stage, shader model), signature elements and the decoded instruction
records. `emit: "raw"` returns the live `DxbcContainer` / `DxbcShaderProgram`
/ `DxbcInstructionDecoder` objects.

## Semantics Contract

This package carries the audited DX11 instruction-semantics contract for float
ALU, integer/conversion, comparisons, control flow, declarations, and program
metadata. Lowering backends consume the decoded instruction stream from this
package and keep target-language policy in their own packages.

Shader Model 5.1 resource declarations additionally expose
`declaration.bindingRange` with the range id, lower/upper register bounds,
unbounded state, register count, and register space. SM5.1 executable resource,
sampler, UAV, and constant-buffer operands expose `operand.resourceReference`
with their range id, index records, and non-uniform flag. These records keep
range identity separate from the actual register index needed by WebGPU and
other explicit-binding backends. Shader Model 5.0 output retains its existing
shape.

## Tests

```sh
npm test
```

Baseline tests are fully self-contained (synthetic DXBC assembled in-test) —
no game assets, network access or fixtures required. An optional corpus sweep
decodes every DXBC payload found under the directory supplied by
`DXBC_CORPUS_DIR`:

```sh
DXBC_CORPUS_DIR=path/to/effects npm test
```

Last full sweep: 1,611 files, 12,125 DXBC payloads, 2,142,826 instructions
decoded, zero failures.

## License

MIT (see
`LICENSE` and `NOTICE`). Unlike `@carbonenginejs/format-gr2`, this package has no EUPL-derived code.
