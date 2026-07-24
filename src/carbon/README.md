# Package-local binary utilities

The modules in this directory are internal binary helpers used by the DXBC
reader. They are original CarbonEngineJS implementations and are not exposed
through the package export map.

`CjsBinaryReader` supports bounded little-endian reads and optional shared
string-table references. The DXBC reader uses its bounded byte and integer
operations; the optional string-table methods remain package-local utility
capability and do not add Carbon or Trinity fields to the public DXBC output.

CarbonEngine and Fenris Creations (CCP Games) are named only for
interoperability and provenance context. See the package [NOTICE](../../NOTICE)
for the public ownership and non-affiliation statement.
