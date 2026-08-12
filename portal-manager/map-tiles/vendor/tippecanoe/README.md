# Packaged Tippecanoe runtime

Portal Manager distributes this directory as a self-contained Windows runtime
for PMTiles generation. The application resolves `tippecanoe.exe` and
`tile-join.exe` from this directory before considering a machine-wide install.

Packaged components:

- Tippecanoe and tile-join 2.80.0;
- MSYS2 runtime 3.6.10-2;
- GCC runtime libraries 15.3.0-1;
- SQLite runtime 3.53.4-1; and
- zlib runtime 1.3.2-1.

The corresponding license and notice files are retained beside the binaries.
When updating this runtime, update all dependent DLLs together, run
`tippecanoe.exe --version`, execute `test_pmtiles_builder.py`, and rebuild the
portable Manager package.
