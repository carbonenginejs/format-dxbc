# @carbonenginejs/format-dxbc

Reads Microsoft DXBC containers, signatures, and SM4/SM5 instruction streams
as plain JavaScript data or internal decoder objects.

Use this package when a browser or Node application needs a pure-JavaScript
DXBC decoder. Shader lowering remains in `@carbonenginejs/format-webgl` and
`@carbonenginejs/format-webgpu`; compiled effect-container parsing remains in
`@carbonenginejs/format-hlsl`.

## Install

```sh
npm install @carbonenginejs/format-dxbc
```

## Quick start

Inspect or fully decode caller-supplied DXBC bytes:

```js
import { CjsFormatDxbc } from "@carbonenginejs/format-dxbc";

const summary = CjsFormatDxbc.inspect(shaderBytes);
const decoded = CjsFormatDxbc.read(shaderBytes);

console.log(summary.shaderModel, decoded.instructions.length);
```

The default `json` output contains plain data suitable for serialization.
Advanced backends may request `emit: "raw"` for the package's internal
container, signature, program, and instruction-decoder instances.

## Documentation

- [Package documentation](docs/README.md)
- [Architecture and boundaries](docs/architecture.md)
- [Public API reference](docs/reference/api.md)
- [Decoded output contract](docs/reference/decoded-output.md)
- [Class-purpose catalog](docs/reference/classes/README.md)

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). DXBC is a Microsoft format;
CarbonEngine and Fenris Creations (CCP Games) are named only for
interoperability and target-ecosystem context. This package contains no
Microsoft, CarbonEngine, or Fenris Creations source code and is not affiliated
with or endorsed by CCP Games.
