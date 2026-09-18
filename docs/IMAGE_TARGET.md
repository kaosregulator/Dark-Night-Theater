# Image Target Watcher (V3 Forensic Engine)

Lightweight add-on for DarkNight Home Theater. Admins upload a **target image**;
the bot watches chosen channels and reacts when someone posts a visually similar
image, GIF frame, video frame, custom emoji, or sticker.

This is **not** a full moderation suite — just focused visual matching.

## How matching works (V3)

```
DISCORD MEDIA
    │
    ├─ IMAGE ──► media normalizer
    └─ VIDEO/GIF ► frame sampler
              │
              ▼
       QUICK FINGERPRINT
       (dHash/aHash/pHash/block/edge/color/PDQ)
              │
     ┌────────┼────────┐
     ▼        ▼        ▼
  obvious   skip    uncertain
   MATCH   NO MATCH     │
                        ▼
                   DEEP SCAN
            denser frames + forensic variants
            screenshot strip / collage tiles
            adaptive crops / rotations / color destruction
            ORB local features / sequence / videoHash
            multi-candidate Jina (optional)
                        │
                        ▼
                 EVIDENCE FUSION → MATCH / NO MATCH
```

1. **Quick scan first** — Normal uploads stay fast.
2. **Adaptive deep scan** — Only uncertain/suspicious media escalate.
3. **Independent evidence** — Structural hashes, PDQ, color, ORB keypoints,
   videoHash, ordered frame sequences, region/partial overlap, mirror signal,
   optional Jina — fused, not single-gated.
4. **Partial / collage / screenshot** — Deep path searches tiles, adaptive
   crops, and Discord-UI strips so cropped/collaged/screenshot copies still hit.
5. **Lab** — Hub **Lab** button self-attacks a target (JPEG, crop, mirror,
   rotate, caption, collage, …) and reports detected/missed.

V1 targets (single hash) and V2 fingerprint sets keep working.
Guild isolation and SSRF/download limits are unchanged.

## Fast setup

1. **Message Content Intent** on in the Discord Developer Portal.
2. **Postgres** `DATABASE_URL` (Railway). Schema migrates on boot (V2
   fingerprints + V3 PDQ/color/features/videoHash columns; optional pgvector).
3. Optional: `JINA_API_KEY`.
4. `npm run register` after deploy if commands need refresh.

## Commands (hub)

`/image-target` (alias `/imagetrack`) — Manage Guild required.

| Control | What it does |
|---|---|
| **Add image** | Attach image/GIF/video as a target |
| **Watch / Unwatch** | Arm live matching in the current channel |
| **Test image** | Dry-run with full forensic diagnostics |
| **Lab** | Self-attack the target; report detected/missed |
| **Set action** | log / delete_warn / timeout / kick / ban |
| **Remove target** | Delete a saved target |

Targets are **guild-scoped**.

## Optional env knobs

```
IMAGE_TARGET_MAX_FRAMES=10
IMAGE_TARGET_DEEP_MAX_FRAMES=18
IMAGE_TARGET_MAX_VARIANTS=9
IMAGE_TARGET_DEEP_MAX_VARIANTS=20
IMAGE_TARGET_MAX_JINA_CALLS=6
IMAGE_TARGET_ANALYSIS_TIMEOUT_MS=25000
IMAGE_TARGET_DEEP_ANALYSIS_TIMEOUT_MS=35000
IMAGE_TARGET_MAX_REGIONS=14
IMAGE_TARGET_MAX_ADAPTIVE_CROPS=12
IMAGE_TARGET_FEATURES=1
IMAGE_TARGET_VECTOR_TOP_K=10
```

## Tests

```bash
npm run test:image-target
```

## Limits / known limitations

- Not 100% — extreme adversarial edits, tiny collage tiles of a huge canvas,
  or content outside deep-sample budgets can still slip.
- Lab uses the stored preview JPEG when the original upload bytes are gone;
  re-add targets for the strongest lab results.
- pgvector is best-effort; without the extension, cosine search stays in JS.
- FFmpeg required for video (Railway/Nixpacks).
- SSRF protections, size limits, redirects, timeouts unchanged.
