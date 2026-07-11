# Character assets (M2) — Mixamo pipeline

Mixamo's license lets us **use** characters/animations inside the game but not
**redistribute** the raw assets. This repo is public, so raw downloads are
gitignored (`assets/raw/`) and every developer pulls them with their own free
Adobe account. Deployed builds embedding the processed GLBs are permitted use.

## What to download (once, ~10 min)

1. Go to mixamo.com, sign in.
2. Pick ONE generic character (e.g. "Y Bot" or any base human — we retint
   procedurally, no real-person likeness).
3. Download these animations **with skin, FBX, 30fps, without keyframe
   reduction** into `assets/raw/`:

| File name to save as | Mixamo search |
|---|---|
| idle.fbx | Idle |
| walk.fbx | Walking |
| jog.fbx | Jogging |
| run.fbx | Running |
| sprint.fbx | Fast Run |
| strafe_l.fbx | Left Strafe |
| strafe_r.fbx | Right Strafe |
| backpedal.fbx | Walking Backwards |
| pass.fbx | Soccer Pass |
| shot.fbx | Soccer Kick / Strike |
| trap.fbx | Soccer Trap (or Idle To Brace) |
| tackle.fbx | Soccer Tackle |
| slide.fbx | Soccer Slide Tackle (if available) |
| jockey.fbx | Standing Defensive Idle / Crouched Walk |

Missing clips are fine — the game falls back to the procedural rig for any
clip it can't find.

## Processing

```bash
npm run assets   # (lands with M2) Blender headless: FBX -> retarget -> trim
                 # -> single characters.glb + meshopt compress
```

Output goes to `public/assets/characters.glb` (also gitignored).
