# Fire asset contract and review

Agree the contract with the receiving runtime before authoring the asset. Anchor names, dimensions,
axes, source count and animation limits come from the current brief.

## Anchor and metadata

Use a mesh-free named anchor at the burner surface. Declare its local up, length and width axes,
units and the complete transform to world space. Inspect parent scale, skew and mirroring.
Record burner dimensions, corner shape, estimated low/typical/maximum flame heights and any
lip or guard that should occlude the effect. Mark estimates explicitly.

Optional endpoint markers at plus/minus half the burner length independently check the exported
axis and dimensions. Set the allowed disagreement for the asset's scale. Export only the intended
extras through the documented verb, then inspect the actual GLB metadata and transforms.

## Independently controlled glow

Represent glow with a deliberately chosen set of auxiliary emitters; author positions from the
current burner and nearby occluders. Freeze IDs, ordering, local/world positions, units, source
normalization and attenuation in a private job manifest before baking. Layer numbers are not
source identities. The runtime must avoid double-counting imported live lights and baked light.

Choose source count from a bounded proof near important surfaces. Fixed sources approximate a
flame bed; they do not track animated flame geometry or produce its moving shadows. Declare
those limits. Colour, gain and flicker controls are separate from source normalization.

## Acceptance

The operator supplies geometry, anchors, metadata and bake evidence. The runtime owner supplies
the animated flame effect. Review side, oblique and top views over time for roots, occlusion,
card edges, speed and the entire animation envelope. A still cannot prove maximum height.

For illumination checks, disable visible flames and unrelated lights, freeze flicker and hold
camera/exposure constant. Compare off, isolated sources and their combination. State whether
weights are per source or normalized across the set. Use linear readback for arithmetic and
images for appearance. Reject blocked cameras. Validate the final composition with ambient/AO
and specular effects separately from each isolated proof.
