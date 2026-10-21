# nijikan: nicxlive WASM + WebGL2

nicxlive runs model loading, animation, physics and command generation in WASM.
The browser executes those commands through the WebGL2 backend. The renderer
requires WebGL2; this does not embed or emulate the native OpenGL driver.

## Build and serve (Windows)

Use an installed Emscripten SDK, CMake, Ninja and Boost headers. No native DLL is
used. `nicxlive_wasm` is a dedicated application target, independent of unit tests.

```powershell
./scripts/build_wasm.ps1 -Emsdk C:/path/to/emsdk -BoostInclude C:/path/to/boost/include -CMake cmake -Ninja ninja
python serve_wasm.py --models-dir C:/models --port 8000
```

Open `http://127.0.0.1:8000/nijikan/index.html`, select a model and start it.
The script builds the sibling `../nicxlive` source and installs the generated
`wasm/nicxlive.js`, `wasm/nicxlive.wasm`, project license, and a build manifest
containing source revision, modified-source flag and artifact SHA-256 values.
`wasm/` remains generated/ignored; deploy its contents together with the app.
Use `-NicxliveSource` and `-BuildDirectory` to override the source and build paths.

The decoder checks the WASM packet layout before rendering and flushes the native
command queue after each WebGL frame. FBO creation preserves the parent's read
and draw framebuffer bindings, including the first DynamicComposite frame.

## Browser verification

With Playwright installed and the local server running:

```powershell
node scripts/test_wasm.cjs http://127.0.0.1:8000/nijikan/index.html http://127.0.0.1:8000/nijikan/models/model.inp test-output/wasm
```

`PLAYWRIGHT_MODULE` optionally specifies a local Playwright module path;
`CHROMIUM_PATH` optionally specifies an existing Chromium executable.
The test uses Chromium/SwiftShader WebGL2 and checks real model draw calls,
parameter UI and image changes, stop/resume, resize, JavaScript errors and WebGL
draw errors. Screenshots, browser logs and result.json are retained.

Validated on Windows with Kurone-20240212-1.4-wld7.1.inp: full-body/eye display,
17 parameters, Face::Roll manipulation, stop/resume and resize passed with zero
WebGL draw errors. This is not a claim of native-renderer pixel equivalence or
cross-browser verification. Webcam tracking was not tested in this change.


## Model lifetime verification

`stop` pauses updates. Selecting another model releases the previous puppet,
renderer, GPU objects, host-allocated WASM work areas, callback registrations and
parameter controls. The WASM instance and WebAssembly.Memory remain alive.
Cleanup errors are reported and prevent silently proceeding with a replacement.

```powershell
node scripts/test_model_lifetime.cjs APP_URL MODEL_A_URL MODEL_B_URL test-output/lifetime
```

The test alternates two models seven times through the existing model selector,
checks parameter controls and stop state, and captures the displayed page.
It uses the served product page without injected runtime/API replacements or a
forced software renderer. It does not prove that all allocations are released.
With NICXLIVE_EXPECTED_REVISION set, it also verifies the build revision and the
hashes of the JS/WASM bytes actually loaded by the browser.
