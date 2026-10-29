---
name: image-techniques
description: "Prepare icons, cut-outs, vector art and PBR map inputs with image editing and deterministic image operations."
---

# Image techniques

Use the configured Asset Studio verbs and the Library image-ops catalogue. Read the live schema
for parameters and defaults; provider-specific generation needs a configured engine and any
required paid-operation approval. Keep intermediates in the private job, not in the tools repo.

## Icons and vectors

Flatten lighting before tracing rendered art. Separate colour and line layers while keeping the
canvas and registration fixed. Threshold each layer independently; compare at the actual small
display size, where fine lines may merge. For a related icon set, keep a consistent style and a
shared square viewBox based on the union of drawn bounds. Inspect light and dark backgrounds.

The image-ops `to_svg` routes include monochrome tracing, colour layers and higher-fidelity
tracing. Choose according to the source. Background removal precedes tracing when needed;
dropping a single background colour is not a semantic cut-out. Preview `currentColor` SVGs on
an explicitly composited background so transparency is not mistaken for a solid black result.

## Pixel-aligned layers

Edits must preserve framing to stack. When direct isolation retains unwanted anatomy, compare
the source with a registered version containing only the intended removal, derive a difference
mask and inspect it for unrelated edits. Do not assume a difference image is a valid mask when
the generator moved the subject. Composite with explicit colour space and mask conventions.

## PBR inputs

Agree canvas size, view registration, channels and colour space with the receiving tool. Albedo
is normally sRGB; roughness, metallic, height and AO are linear data. State the normal-map axis
convention. A coloured/shaded picture is not a physically valid data map merely because it is
grey. Define per-material values, remove illumination where appropriate, and inspect maps in
the shader that will consume them. Treat image-derived height/AO as approximations.

Deterministic height-to-normal/AO routes can give reproducible maps. Tileable inputs require
wrap-aware processing of every derived map. Inconsistent views must be fixed before projection;
extra bake iterations do not solve mismatched silhouettes or proportions.

## Cut-outs and textures

Use border flood-fill for a suitably flat background; inspect enclosed holes and edge halos.
Model-based removal may need substantial memory: confirm a bounded execution environment and
appropriate resolution before processing. Choose alpha matting for fine hair only when the tool
supports it. Preserve the original image and inspect the result before downstream generation.

For repeating images, use [seam audit](../seamless-textures/SKILL.md). Offset blending can suit
stochastic texture; distinct motifs often need wrapped composition or a min-cut repair.

Report methods/settings, the views inspected, output formats and known approximations. Public
documentation contains generic recipes; actual images, prompts tied to private subjects and
Library lineage belong to the private job record.
