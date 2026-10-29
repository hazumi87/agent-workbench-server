# mesh-sidecar

Runs local image-to-3D engines for the asset workflow: four (or fewer) views of one part in, a GLB
mesh out. It wraps Hunyuan3D-2mv, TRELLIS and TripoSR behind one command (`run_once.py`) and one
small HTTP job service (`sidecar.py`) that matches the Model Studio backend contract in `tool.json`
of the Library's model-studio tool. It needs an NVIDIA GPU; the Library and `blender-agent` do not.

## Files
- `run_once.py` — one run: `--engine hunyuan|triposr|trellis --char <name> --views <dir with <name>_<view>.png> --out <dir>`
  (`--cuts <dir>` reuses RGBA cut-outs and skips background removal). Guards: free-VRAM floor,
  timeout, shared-GPU-memory spill abort. Writes `report.json` and the GLB. `--help` lists all flags.
- `fixed_frame.py` (+ `test_fixed_frame.py`) — fixed-frame multiview conditioning. The stock Hunyuan
  multiview processor crops each view to its own alpha box and rescales it, so views of one part get
  different scales. `run_once.py --fixed-frame --cuts <dir>` feeds the views as already framed to one
  square, writes the exact images fed and `framing.json`, and asserts the model received them.
  `--frame-pad` pads to the largest square (never scales); `--frame-meta` merges a JSON note.
- `landmark_fit.py` (+ `test_landmark_fit.py`) — fits a redrawn part image to the common source image with
  one uniform scale, reports residuals and x/y drift, and gives ACCEPT/REJECT before any inference.
- `export_contract.py` — raw GLB to the GLB contract: metres, +Y up facing +Z, one mesh, origin at the
  lowest slice (`--height-m H`).
- `render.py`, `compare.py`, `geomdiff.py` — CPU preview sheet, mesh comparison and geometry diff
  (run inside Blender: `blender -b --python render.py -- <glb> <png>`).
- `sidecar.py` — the job service (`GET /manifest`, `POST /run`, `GET /jobs/:id`, `POST /jobs/:id/cancel`)
  with a bearer-token check (it stores only the token's sha256), a GPU gate (`MESH_GPU_ENABLED=1`),
  one child process per job so VRAM is freed on exit, and Library publishing with lineage.
  Configure with environment variables: `MESH_ROOT`, `MESH_WORK`, `MESH_SHARE_DIR`, `MESH_SHARE_URL`,
  `MESH_LIBRARY`, `MESH_BIND`, `MESH_PORT`, `MESH_TOKEN_SHA256_FILE`, `MESH_GPU_ENABLED`.

## Installing an engine (Linux; untested here — these follow the pinned versions the tool was built with)
```bash
python3 -m venv $MESH_ROOT/venv && . $MESH_ROOT/venv/bin/activate
pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
# Hunyuan3D-2 (pinned commit f8db63096c8282cb27354314d896feba5ba6ff8a)
git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git $MESH_ROOT/src/Hunyuan3D-2
git -C $MESH_ROOT/src/Hunyuan3D-2 checkout f8db63096c8282cb27354314d896feba5ba6ff8a
pip install diffusers einops opencv-python numpy transformers omegaconf tqdm trimesh pymeshlab pygltflib xatlas accelerate rembg onnxruntime huggingface_hub safetensors
pip install --no-deps -e $MESH_ROOT/src/Hunyuan3D-2
hf download tencent/Hunyuan3D-2mv --local-dir $MESH_ROOT/models/tencent/Hunyuan3D-2mv   # plus the turbo VAE files from tencent/Hunyuan3D-2 for --flashvdm
```
TRELLIS (`microsoft/TRELLIS`, model `microsoft/TRELLIS-image-large`) additionally needs `xformers==0.0.29.post3`,
`spconv-cu124==2.3.8`, `kaolin==0.18.0` (NVIDIA wheel index for torch 2.6.0/cu124), `transformers==4.46.3`,
`utils3d` and a CUDA toolkit that includes cuSPARSE headers if any extension must compile. TripoSR
(`VAST-AI-Research/TripoSR`) needs `omegaconf==2.3.0`, `einops==0.7.0`, `transformers==4.46.3` and `torchmcubes`
(builds a CUDA extension). Run `run_once.py --help` for the exact flags per engine.

## Licences (check before commercial use)
Hunyuan3D-2 weights: the community licence excludes the EU, UK and South Korea including outputs, so
treat its output as evaluation only (`sidecar.py` stamps `evaluation_only` on it). TRELLIS and TripoSR are
MIT-licensed; background removal uses `rembg` with `birefnet-general` (MIT).
