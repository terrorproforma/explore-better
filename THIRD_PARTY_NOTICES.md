# Third-Party Notices

Explore Better's local 3D preview includes the following open-source components:

- Three.js 0.185.1, Copyright © 2010-2026 three.js authors, licensed under the MIT License. The complete license is packaged as `public/generated/license.three.txt`.
- occt-import-js 0.0.23, licensed under the GNU Lesser General Public License version 2.1. The complete license is packaged as `public/generated/license.occt-import-js.txt`.
- Open CASCADE Technology, used by occt-import-js to tessellate STEP files locally, licensed under the GNU Lesser General Public License version 2.1 with the Open CASCADE exception. The complete distributed notice is packaged as `public/generated/license.occt.txt`.

The corresponding upstream projects are available from:

- https://github.com/mrdoob/three.js
- https://github.com/kovacsv/occt-import-js
- https://dev.opencascade.org/

The OpenCascade JavaScript and WebAssembly files remain separate packaged assets under `public/generated/` and are loaded at runtime by the 3D preview worker.
