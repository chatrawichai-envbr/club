# Third-Party Notices

This package includes third-party model assets and runtime dependencies. The
package license field is an SPDX expression: `MIT AND Apache-2.0`.

## Bundled U-2-Netp model

- File: `models/u2netp.onnx`
- Model family: U-2-Net / U-2-Netp
- Original project: https://github.com/xuebinqin/U-2-Net
- License: Apache License 2.0
- License text: `LICENSES/Apache-2.0.txt`
- Download source used by this package:
  https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx

The bundled ONNX model is redistributed under the Apache License 2.0. Keep this
notice and the Apache License 2.0 text when redistributing the package or the
model file.

## rembg release artifact source

- Project: https://github.com/danielgatis/rembg
- License: MIT

The `u2netp.onnx` file included here is downloaded from a rembg release URL.
No rembg source code is bundled in this package.

## Optional BiRefNet ONNX model

- Official project: https://github.com/ZhengPeng7/BiRefNet
- ONNX model source used by `DEFAULT_BIREFNET_MODEL_URL`:
  https://huggingface.co/onnx-community/BiRefNet-ONNX
- License: MIT

BiRefNet model files are not bundled in this package. If you use the BiRefNet
preset without passing `modelUrl`, the library loads the ONNX Community BiRefNet
model URL at runtime. Keep the upstream MIT license notice when redistributing
BiRefNet model files yourself.
