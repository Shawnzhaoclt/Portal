# Third-party notices

The PMTiles v3 directory and header encoding in `pmtiles_v3.py` is adapted from
the Protomaps PMTiles Python reference implementation.

Copyright (c) Protomaps and PMTiles contributors.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES ARISING IN ANY
WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.

## GDAL

The fallback PMTiles conversion engine invokes the GDAL command-line tools from
the configured Python environment. GDAL is distributed under an MIT-style
license. Portal Manager does not modify or redistribute the GDAL binaries.

## Tippecanoe and packaged runtime

Portal Manager packages Tippecanoe and `tile-join` as its primary PMTiles
conversion engine. The corresponding Tippecanoe license, MSYS2 runtime notice,
GNU runtime license and exception, SQLite notice, and zlib license are retained
under `vendor/tippecanoe` beside the binaries.
