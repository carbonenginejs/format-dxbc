# Decoded output contract

Status: Evolving
Scope: `@carbonenginejs/format-dxbc` JSON output
Audience: Shader-tool authors and lowering-backend authors
Summary: Defines the stable top-level JSON fields and the decoder records consumed by shader-lowering packages.

## Top-level result

`CjsFormatDxbc.read(bytes)` returns:

| Field | Meaning |
| --- | --- |
| `source` | Caller-provided diagnostic label. |
| `container` | Container version, declared size, and chunk summaries. |
| `program` | Shader stage, shader model, chunk tag, and token count, or `null`. |
| `inputSignature` | Input signature elements, or `null`. |
| `outputSignature` | Output signature elements, or `null`. |
| `patchSignature` | Patch-constant signature elements, or `null`. |
| `instructions` | Decoded instruction records, or `null` when disabled or absent. |

`Inspect` returns a smaller record containing the container/chunk summary,
stage name, shader model, and input/output element counts.

## Container records

The container summary includes `version`, `totalSize`, and ordered `chunks`.
Each chunk record includes its four-character code, byte offset, and payload
size. JSON output omits raw chunk bytes.

## Program records

Program metadata includes:

- `fourCC`: `SHEX` or `SHDR`;
- numeric and named program type;
- major and minor shader-model version; and
- declared program length in 32-bit words.

Recognized program names are pixel, vertex, geometry, hull, domain, and
compute. An unknown numeric type remains observable as `"unknown"`.

## Signature elements

Each signature element records its semantic name/index, system-value and
component types, register index, masks, stream, and minimum-precision value
when that signature layout provides one.

The reader supports the SM4 and SM5 signature chunk layouts used by `ISGN`,
`ISG1`, `OSGN`, `OSG1`, `OSG5`, `PCSG`, and `PSG1`.

## Instruction records

Each instruction begins with its source token offset, opcode number/name,
declared length, and decoded control bits. Depending on the opcode, the record
may also include:

- destination and source operands with component selection and index records;
- opcode and operand extensions;
- declaration-specific fields;
- resource dimensions and return types;
- sampler, interpolation, precision, topology, or system-value metadata;
- custom-data payloads; and
- unprojected declaration words in `tailTokens`.

Executable instructions reject leftover or missing operand words. Declaration
records may preserve unfamiliar trailing payload words when their instruction
framing is valid.

## Shader Model 5.1 bindings

SM5.1 resource declarations may include `bindingRange`:

| Field | Meaning |
| --- | --- |
| `rangeId` | Class-local binding-range identity. |
| `lowerBound` / `upperBound` | Declared register bounds. |
| `unbounded` | Whether the upper bound represents an unbounded range. |
| `registerCount` | Finite range size, otherwise `null`. |
| `registerSpace` | D3D register space. |

Executable resource, sampler, UAV, and constant-buffer operands may include a
`resourceReference` retaining the range identity, index records, and
non-uniform flag. Range identity remains separate from the actual register
index needed by an explicit-binding backend.

SM5.0 declarations keep their direct-register shape.

## JSON conversion

Typed arrays become number arrays, arrays are converted recursively, maps
become plain objects, sets become arrays, and objects with `toJSON` use that
projection.

## Related documentation

- [Public API reference](api.md)
- [Architecture and boundaries](../architecture.md)
