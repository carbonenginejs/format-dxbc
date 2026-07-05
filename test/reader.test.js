import test from "node:test";
import assert from "node:assert/strict";

import { CjsFormatDxbc } from "../src/index.js";
import { buildMinimalVertexDxbc } from "./synthetic.js";

test("static read and instance Read share one code path", () =>
{
    const bytes = buildMinimalVertexDxbc();
    const fromStatic = CjsFormatDxbc.read(bytes, { source: "synthetic" });
    const fromInstance = new CjsFormatDxbc({ source: "synthetic" }).Read(bytes);
    assert.deepEqual(fromStatic, fromInstance);
});

test("json emit is plain data with decoded instructions", () =>
{
    const result = CjsFormatDxbc.read(buildMinimalVertexDxbc(), { source: "synthetic" });

    assert.equal(result.program.programTypeName, "vertex");
    assert.equal(result.container.chunks[0].fourCC, "SHEX");
    assert.deepEqual(result.instructions.map((instruction) => instruction.opcodeName), [ "dcl_temps", "ret", "ret" ]);
    // JSON-compatible end to end
    assert.equal(typeof JSON.stringify(result), "string");
});

test("raw emit exposes the decoder objects", () =>
{
    const result = CjsFormatDxbc.read(buildMinimalVertexDxbc(), { emit: CjsFormatDxbc.OUTPUT_RAW });

    assert.equal(result.program.constructor.name, "DxbcShaderProgram");
    assert.equal(result.decoder.constructor.name, "DxbcInstructionDecoder");
    assert.ok(result.container.getChunk("SHEX"));
});

test("inspect summarizes without instruction decode", () =>
{
    const summary = CjsFormatDxbc.inspect(buildMinimalVertexDxbc());

    assert.equal(summary.isDxbc, true);
    assert.equal(summary.programTypeName, "vertex");
    assert.equal(summary.shaderModel, "5.0");
    assert.deepEqual(summary.chunks.map((chunk) => chunk.fourCC), [ "SHEX" ]);
    assert.equal("instructions" in summary, false);
});

test("profiles hold values and reject invalid emits", () =>
{
    const reader = new CjsFormatDxbc({ emit: CjsFormatDxbc.OUTPUT_RAW, source: "profile" });
    assert.equal(reader.GetValues().emit, CjsFormatDxbc.OUTPUT_RAW);
    assert.equal(reader.GetValues({ source: "override" }).source, "override");
    assert.equal(reader.GetValues().source, "profile");
    assert.throws(() => new CjsFormatDxbc({ emit: "nonsense" }), /emit must be/);
});

test("toJSON converts typed arrays and nested structures", () =>
{
    const converted = CjsFormatDxbc.toJSON({
        tokens: new Uint32Array([ 1, 2 ]),
        nested: [ { mask: new Uint8Array([ 3 ]) } ]
    });
    assert.deepEqual(converted, { tokens: [ 1, 2 ], nested: [ { mask: [ 3 ] } ] });
});
