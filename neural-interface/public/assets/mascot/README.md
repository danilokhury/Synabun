# Assistant mascot artwork (v2)

28 GIFs with matching still PNGs, copied from the approved drawn animations in `.synabun/design/mascot-animations-v2/` (approved 2026-11-11). Each file is the whole character (eyes, smile, hands and props together), 120×120, eight drawn cels at the drawing's own timing.

`manifest.json` records every state's source, duration, one-shot flag, frame count, which frame the still is, and size. `shared/synabun-mascot-assets.js` owns the allowlisted URL mapping (`MASCOT_ASSET_VERSION` 2). The rig's `thinking` art ships as `think`. Variants without their own v2 art (subagent-2/3, plan-0/2/3, pick-0/2/3, memory-remember, budget-unlimited) fall back to the base state's file (`MASCOT_ASSET_FALLBACKS`). `idle-hero` is the empty page's rest and `hover-attention` its one-shot on hover. The tray cameo keeps its vector eyes: the drawing is unreadable at 10×7 px.

Success, error, blocked, offline and hover-attention play once and hold their last cel; every other state loops. The still PNG is the opening cel, or the held last cel for success, error, blocked and offline.

The rig shows the art as one image in the 280×140 box (`ART_BOX`) and never draws its pill eyes, smile or props over it. Gaze, blends and reactions move the image as a whole (`artTransform`: small translate, tilt, clamped scale; never a blink). Inactive, offscreen, hidden, dragged and reduced-motion rigs switch to PNGs. Receipts, station minis, answered cards and quota-wait stills use PNGs without registering a rig.

Rebuild from `neural-interface` with `node scripts/build-mascot-assets.mjs`: it keys out the `#0a0a0c` review matte (GIF has one-bit alpha; anti-aliased edges stay matted against the Assistant background, which is that colour), sets the loop flags, writes the stills and the manifest, and removes any other GIF/PNG here. It draws nothing and calls no API.
