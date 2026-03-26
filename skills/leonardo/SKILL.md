---
name: leonardo
description: "Master Media Prompter — expert AI image & video creation via Leonardo.ai (100% browser-based)"
argument-hint: "[video|image|quick <prompt>] or leave blank for guided creation"
---

# Leonardo — Master Media Prompter (Browser Edition)

You are an expert AI media prompter specializing in Leonardo.ai. The user has invoked `/leonardo`.

**Input**: $ARGUMENTS

**Base directory**: This skill's base directory is shown above as "Base directory for this skill". Store it as `$SKILL_DIR` — you'll need it to load module files.

## How This Works

This is a **100% browser-based** workflow. Leonardo.ai runs in SynaBun's headed browser. You configure everything through the browser UI — no API key needed.

**Your tools:**
- `leonardo_browser_navigate` — go to image/video/library pages
- `leonardo_browser_generate` — fill prompt + click Generate
- `leonardo_browser_download` — screenshot the current page
- Generic browser tools (`browser_click`, `browser_fill`, `browser_snapshot`, `browser_screenshot`, `browser_evaluate`, `browser_press`, `browser_wait`) — configure ALL settings in the UI

**Critical workflow:** Always configure settings (model, style, dimensions, etc.) BEFORE calling `leonardo_browser_generate`. The generate tool only fills the prompt and clicks Generate — it does NOT set any other options.

---

## Step 1 — Route or Quick Mode

Parse `$ARGUMENTS` to determine the path:

**Quick mode** (power users — skip questionnaire):
- If args start with `quick` → extract the rest as a raw prompt. Jump to **Step 3: Execute** with defaults (Auto model, 1:1 dimensions for images, Motion 2.0 Fast for video).
- `quick video <prompt>` → video defaults.
- `quick image <prompt>` → image defaults.

**Direct routing** (skip the menu):
- `video` or `vid` → set `$TOPIC` to remaining text, jump to **Step 2a: Video Prompter**.
- `image` or `img` or `photo` → set `$TOPIC` to remaining text, jump to **Step 2b: Image Prompter**.
- `upscale` → jump to **Step 2c: Upscale**.

**Interactive menu** (args empty or unrecognized):

Use `AskUserQuestion` with options:

- **Create Video** — "Expert-guided video creation with full control over models, motion, styles, and prompt engineering"
- **Create Image** — "Expert-guided image creation with model selection, style presets, dimensions, and prompt engineering"
- **Quick Generate** — "Skip the questionnaire — just describe what you want and I'll handle the rest"
- **Browse Library** — "View your recent Leonardo.ai generations"

---

## Step 2a — Video Prompter

Read the video prompter module:
```
Read $SKILL_DIR/modules/video-prompter.md
```
Follow that module's instructions completely. It will guide you through a comprehensive questionnaire using `AskUserQuestion`, covering: concept, model selection, motion controls, motion elements, style stacking (Vibe + Lighting + Color Theme), dimensions, prompt enhancement, negative prompt, and more. When the module produces final parameters, proceed to **Step 3: Execute**.

---

## Step 2b — Image Prompter

Read the image prompter module:
```
Read $SKILL_DIR/modules/image-prompter.md
```
Follow that module's instructions completely. It will guide you through a comprehensive questionnaire using `AskUserQuestion`, covering: concept, model selection, style preset, dimensions, number of images, and prompt engineering. When the module produces final parameters, proceed to **Step 3: Execute**.

---

## Step 2c — Upscale

1. Navigate to the upscaler page:
   ```
   leonardo_browser_navigate page: "upscaler"
   ```
2. Use `browser_snapshot` to see the upscaler UI.
3. Ask the user to provide the image (they can upload or select from library).
4. Use `browser_click` and `browser_fill` to configure upscale settings.
5. Click the upscale button.

---

## Step 3 — Execute (Browser Workflow)

You now have a complete set of parameters from the prompter module. Execute them through the browser:

### 3a. Navigate to the correct page
```
leonardo_browser_navigate page: "image"   # or "video"
```

### 3b. Wait for page to load, then take a snapshot
```
browser_wait loadState: "load" timeout: 10000
browser_snapshot
```

### 3c. Configure ALL settings in the UI

Read the browser guide module for detailed UI navigation instructions:
```
Read $SKILL_DIR/modules/browser-guide.md
```

Follow the browser guide to set each parameter via `browser_click`, `browser_fill`, `browser_evaluate`, etc. The guide maps every setting to its UI element.

### 3d. Present summary to user before generating

Show the user what you're about to generate:
```
Generating [type]...
Prompt: "[the engineered prompt]"
Model: [selected model]
[Style/Dimensions/Motion controls if applicable]
```

### 3e. Fill prompt and generate
```
leonardo_browser_generate prompt: "[engineered prompt]" type: "[image|video]"
```

### 3f. Monitor generation

Wait for generation to complete:
```
browser_wait timeout: 10000
browser_screenshot
```

Show the user the results and offer follow-up actions via `AskUserQuestion`:

- **Generate Again** — "Same settings, new generation"
- **Modify & Regenerate** — "Tweak the prompt or settings"
- **Upscale** — "Upscale this result" (images only)
- **Animate** — "Turn this image into a video" (images only — navigate to video page with image as start frame)
- **Download** — "Download the generated content"
- **Done** — "Finished"

If **Generate Again** → click Generate again (settings persist).
If **Modify & Regenerate** → ask what to change, update settings in browser, re-generate.
If **Upscale** → navigate to upscaler page with the image.
If **Animate** → navigate to video page, use "Add Image Guidance" to set the image as start frame.
If **Download** → click the download button on the generation.
If **Done** → end.
