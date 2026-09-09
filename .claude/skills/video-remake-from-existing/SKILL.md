---
name: video-remake-from-existing
description: Remake / upgrade a video from an existing one — keep the original audio (dialogue/narration), and REDO each original visual as a faithful re-interpretation using the original frame as an IMAGE REFERENCE (image-to-image), never a text-only re-invention. Trigger when the user wants to "refazer/reproduzir/dar upgrade" num vídeo existente mantendo o áudio, with fresher/higher-quality images that stay in the original's context.
---

# Remake a video from an existing one (faithful image upgrade)

## The one rule that matters (learned the hard way)
**Re-interpret the ORIGINAL images, do not re-invent them from text.**
- ❌ WRONG: read the narration, write text prompts, generate brand-new images. They drift out of context and don't match the original shots. (This produced a "related but wrong" video.)
- ✅ RIGHT: for each scene, take the **original frame** and run **image-to-image with that frame as an image reference**, with a prompt that asks for an *upgrade* (sharper, fresher, higher fidelity) while **preserving the same composition, subject, framing, palette and context**. The result is a re-interpretation/upgrade of the real shot.

Keep the **original audio** (the dialogue/narration) intact — that's what "mesmo diálogo" means.

## Cost discipline
- Every generation costs credits. **Estimate and confirm with the user before generating.** Prefer the provider with free/online credits (Kling MCP) for image work.
- Do a **1-scene sample first**, show it to the user, get approval, THEN batch the rest. Don't generate all N scenes blind.

## Pipeline

### 1. Understand the source
- `ffprobe` the source: duration, resolution, fps, aspect ratio. **Match these in the output** (e.g. set project to the source's WxH via `set_project_settings`).
- Detect scene cuts:
  `ffmpeg -i SRC -filter:v "select='gt(scene,0.3)',showinfo" -f null - 2>&1 | grep pts_time`
  Consolidate rapid cuts into ~8–14 coherent scene segments (start→end).
- (Context) Extract + transcribe the audio so you understand the STORY, not just the pictures:
  `ffmpeg -y -i SRC -vn -c:a aac rf_audio.m4a`
  then `faster-whisper` (model "base", vad_filter) for timestamped narration. Use it to label each scene's intent — but the image must still come from the original frame, not the transcript alone.

### 2. Extract one reference frame per scene
- For each segment, grab a representative frame (mid-scene):
  `ffmpeg -y -ss <mid> -i SRC -frames:v 1 ref_<NN>.png`
- **Read each frame** (Read tool) to confirm what the shot actually is before remaking it.

### 3. Remake each frame via IMAGE REFERENCE (image-to-image)
- Upload `ref_<NN>.png` and run image-to-image with it as the reference:
  - **Kling** (free online credits): `image_to_image`, model `kling-image-v3_0` (reference as `image_1`, cite as 图片1 in the prompt) or `kling-image-v2_1` (`subject_image_0` + `scene_image`). Aspect ratio = source's (e.g. `21:9`).
  - Prompt pattern: *"Recreate this exact shot (图片1) as a higher-quality, fresher cinematic version. Keep the SAME composition, subject, camera angle, framing, lighting mood and color palette. Upgrade detail and realism only — do not change the content or context."*
- Keep reference strength high enough to preserve composition (this is an UPGRADE, not a restyle). If the model drifts, raise reference weight / lower creativity.
- Verify each result against its original frame (Read both) — it must read as the **same shot, improved**.

### 4. Assemble via the video-editor MCP
- `set_project_settings` to the source WxH/fps.
- Keep the original video clip on a lower track for its **audio** (or import the extracted audio onto an audio track and drop the video). Put the remade images on a **top** video track (`add_track` → top), each `add_clip` at the original scene start/duration, `fit: cover`.
- Add subtle motion so it isn't a slideshow (the MCP can't set effects → edit the project JSON to add a `kenburns`/slow-zoom effect per clip; vary amount). Optional gentle crossfades.

### 5. Render + self-review
- `render` to an MP4.
- Self-review with `ffprobe`: duration within ±5% of source, **audio stream present** (narration kept), correct resolution. Extract a contact sheet and compare scene-by-scene against the original.

## Definition of done
Each output scene is the **same shot as the original, upgraded** (not a different scene), the **original narration** plays start to finish, timings match the source, and the export passes the self-review checks.
