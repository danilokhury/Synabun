# Leonardo.ai Browser Navigation Guide

This module maps every Leonardo.ai UI control to browser automation instructions. Use this to configure settings before generating.

**Important:** Leonardo.ai is a React app. Some elements don't respond to standard CSS selector clicks. When `browser_click` fails, use `browser_evaluate` with JavaScript to click elements directly.

---

## General Patterns

### Clicking buttons that contain multi-line text
Leonardo buttons often contain nested elements. Use `browser_evaluate`:
```javascript
(() => {
  const btns = document.querySelectorAll('button');
  for (const b of btns) {
    if (b.textContent.includes('TARGET_TEXT')) { b.click(); return 'clicked'; }
  }
  return 'not found';
})()
```

### Closing dialogs/panels
- Press `Escape` via `browser_press key: "Escape"`
- Or click the close button if visible

### Waiting after actions
After clicking buttons that open panels/dialogs, wait 1-2 seconds before taking a snapshot:
```
browser_wait timeout: 2000
browser_snapshot
```

---

## IMAGE GENERATION PAGE

**URL:** `https://app.leonardo.ai/image-generation`

### Model Selection
1. Click the Model button:
   ```javascript
   (() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Model')); if (b) { b.click(); return 'opened'; } return 'not found'; })()
   ```
2. A dialog opens with tabs: **Image** | **Video** | **Legacy**. Image tab is selected by default.
3. Click the desired model button (each model is a button with an article inside):
   ```javascript
   (() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('MODEL_NAME')); if (b) { b.click(); return 'selected'; } return 'not found'; })()
   ```

**Available Image Models (March 2026):**
| Model | Best For | Cost | Capabilities |
|-------|----------|------|-------------|
| Auto | Let Leonardo pick | Varies | — |
| Nano Banana 2 | Fast, sharp details, editing | Paid | Image Ref |
| Seedream 4.5 | Posters, logos, text-heavy | Paid | Image Ref |
| Lucid Origin | Prompt adherence, text, HD | Unlimited | Style Ref, Content Ref |
| FLUX.2 Pro | High-fidelity, prompt adherence | Paid | Image Guidance |
| GPT Image-1.5 | Editing control, detail preservation | Paid | Image Ref |
| Nano Banana Pro | Consistency, infographics | Paid | Image Ref |
| Seedream 4.0 | Ultra quality, consistency | Paid | Image Ref |
| Nano Banana | Context-aware edits, consistency | Paid | Image Ref |
| Lucid Realism | Cinematic, pairs w/ video gen | Unlimited | Style Ref, Content Ref |
| Ideogram 3.0 | Text rendering, consistency | Paid | — |
| GPT-Image-1 | State-of-the-art generation | Paid | Image Ref |
| FLUX.1 Kontext Max | Maximum quality output | Paid | Image Ref |
| FLUX.1 Kontext | Precise, controllable generation | Paid | Image Ref |
| FLUX Dev | Detailed, realistic images | Unlimited | Style Ref, Content Ref, Elements |
| FLUX Schnell | Fast, quality outputs | Unlimited | Style Ref, Content Ref |
| Phoenix 1.0 | Prompt adherence, text rendering | Unlimited | Image to Image, Style/Content/Character Ref |
| Phoenix 0.9 | Foundational model preview | Unlimited | Image to Image, Style/Content/Character Ref |

### Style Preset
Click the Style combobox (shows current style, default "Dynamic"):
```javascript
(() => { const c = document.querySelector('[role="combobox"]'); if (c) { c.click(); return 'opened'; } return 'not found'; })()
```
Then click the desired option from the listbox:
```
browser_click selector: "option:has-text('STYLE_NAME')"
```

**Available Styles:** Dynamic (default), Cinematic, Creative, Fashion, None, Portrait, Stock Photo, Vibrant

### Image Dimensions
Click the aspect ratio radio buttons:
```
browser_click selector: "[role='radio']:has-text('RATIO')"
```

**Preset Options:** 2:3, 1:1 (default), 16:9, Custom

**Custom Dimensions** — clicking "Custom" opens a dialog with:
- Aspect ratio slider (Wide ↔ Tall, centered at 1:1)
- Social presets: Twitter/X (4:3), Instagram (4:5), TikTok (9:16)
- Device presets: Desktop (16:9), Square (1:1)

Click presets:
```
browser_click selector: "[role='radio']:has-text('Instagram (4:5)')"
```

### Number of Images
Click the count radio:
```
browser_click selector: "[role='radio']:has-text('NUMBER')"
```
**Options:** 1 (default), 2, 3, 4

### Add Elements / Reference Images
Click the "Add elements" button near the prompt to access image-to-image, style reference, content reference, and other advanced features (availability depends on selected model).

**Preferred method — use the dedicated tool:**
```
leonardo_browser_reference type: "style_ref" filePaths: ["/path/to/image.png"] autoClear: true
```
This automates the full flow: opens the panel, selects the reference type, uploads the file(s), and auto-clears from the SynaBun image store.

**Manual method (fallback):**
1. Click "Add elements":
```javascript
(() => {
  const btns = document.querySelectorAll('button');
  for (const b of btns) {
    if (b.textContent.includes('Add elements')) { b.click(); return 'opened'; }
  }
  return 'not found';
})()
```
2. Wait for panel to open, then `browser_snapshot` to see available reference types.
3. Click the desired reference type (e.g., "Style Reference", "Image Reference", "Content Reference").
4. Upload the image file:
```
browser_upload selector: "input[type='file']" filePaths: ["/path/to/image.png"]
```
5. Optionally adjust the strength slider if visible.
6. Close the panel with Escape or continue to prompt.

**Reference type availability by model:**
| Model | Image Ref | Style Ref | Content Ref | Character Ref | Image-to-Image |
|-------|-----------|-----------|-------------|---------------|----------------|
| Lucid Origin | — | Yes | Yes | — | — |
| Lucid Realism | — | Yes | Yes | — | — |
| FLUX Dev | — | Yes | Yes | — | — |
| FLUX Schnell | — | Yes | Yes | — | — |
| Phoenix 1.0 | — | Yes | Yes | Yes | Yes |
| Phoenix 0.9 | — | Yes | Yes | Yes | Yes |
| Nano Banana 2 | Yes | — | — | — | — |
| Seedream 4.5 | Yes | — | — | — | — |
| GPT Image-1.5 | Yes | — | — | — | — |
| Nano Banana Pro | Yes | — | — | — | — |
| FLUX.1 Kontext | Yes | — | — | — | — |
| Ideogram 3.0 | — | — | — | — | — |

### Prompt
The prompt textbox has `aria-label="Prompt"`. Use `leonardo_browser_generate` to fill it and click Generate, or fill manually:
```
browser_fill selector: "[aria-label='Prompt']" value: "your prompt here"
```

---

## VIDEO GENERATION PAGE

**URL:** `https://app.leonardo.ai/image-generation/video`

### Model Selection
Same pattern as image — click the Model button, but the Video tab is auto-selected on the video page.

**Available Video Models (March 2026):**
| Model | Best For | Cost | Capabilities |
|-------|----------|------|-------------|
| Kling Video 3.0 | Longer videos, audio, consistency | Paid | Start/End Frame, Audio |
| Kling Video O3 Omni | Longer videos, audio, image ref | Paid | Start/End Frame, Image Ref, Audio |
| Veo 3.1 Fast | Fast video concepts | Paid | Fast, Start/End Frame, Audio |
| Hailuo 2.3 | Affordable, high-quality, style | Paid | Start Frame |
| Kling 2.6 | Visuals, voiceovers, sound | Paid | Start Frame, Audio |
| Seedance 1.0 Pro Fast | Prompt following, details | Paid | Start Frame, Fast |
| Kling O1 Video Model | Accuracy, multi-instruction prompts | Paid | Start/End Frame, Image Ref |
| Hailuo 2.3 Fast | Fast, lifelike motion | Paid | Start Frame |
| Sora 2 Pro | Smooth cinematic, refined detail | Paid | Start Frame, Audio |
| Sora 2 | Multi-shot continuity, audio | Paid | Start Frame, Audio |
| Veo 3.1 | Cinematic storytelling | Paid | Start/End Frame, Image Ref, Audio |
| Kling 2.5 Turbo | Narrative control, start frames | Paid | Start/End Frame |
| Kling 2.5 Turbo Standard | Fast, lower cost | Paid | Start Frame |
| Seedance 1.0 Pro | Precise motion, consistency | Paid | Start/End Frame |
| Kling 2.1 Pro | Seamless video transitions | Paid | Start/End Frame |
| LTX-2 Pro | Polished visuals, quick | Paid | Start Frame, Audio |
| Seedance 1.0 Lite | Fast, camera shots, expressions | Paid | Start/End Frame, Image Ref |
| LTX-2 Fast | Enhanced textures, industry speed | Paid | Fast, Start Frame, Audio |
| Veo 3 | Realistic cinematic, audio | Paid | Start Frame, Audio |
| Veo 3 Fast | Quick concepts, fast viz | Paid | Fast, Start Frame, Audio |
| Motion 2.0 | High-quality, fine-tuned controls | **Unlimited** | Start Frame, Controls, Elements, Styles |
| Motion 2.0 Fast | Fast preview, high quality | **Unlimited** | Fast, Start Frame, Controls, Elements, Styles |
| Motion 1.0 | Basic, subtle motion | **Unlimited** | Start Frame |

**Note:** Only Motion 2.0 and Motion 2.0 Fast support Motion Controls, Motion Elements, and Style Stacking. Other models use their own built-in styles.

### Motion Control
Click the "Motion Control" button to open the motion control dialog:
```javascript
(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Motion Control') && !b.textContent.includes('Elements')); if (b) { b.click(); return 'opened'; } return 'not found'; })()
```

Select a motion control from the dialog:
```javascript
(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'CONTROL_NAME'); if (b) { b.click(); return 'selected'; } return 'not found'; })()
```

**39 Motion Controls:**
**Camera Movement:** Dolly In, Dolly Out, Dolly Left, Dolly Right, Crane Up, Crane Down, Crane Over Head, Tilt Up, Tilt Down, Orbit Left, Orbit Right, Rotate, Dutch Angle, Snorricam, Robo Arm, Lazy Susan
**Zoom:** Crash Zoom In, Crash Zoom Out, Medium Zoom In, Super Dolly In, Super Dolly Out, YoYo Zoom, Bullet Time
**Effects:** Explosion, Disintegration, Freezing, Flood, Set on Fire, Thunder God, Night, Metal, Light Morph, Ripple Morph, Lens Crack, Touch Glass, Tattoo Motion, Handheld, Eyes In, Mouth In
**None:** Removes any motion control

### Motion Elements
Click the "Motion Elements" button:
```javascript
(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Motion Elements') ); if (b) { b.click(); return 'opened'; } return 'not found'; })()
```

**27 Motion Elements (creative style overlays):**
90s Retro Anime, CGI Noir, Claynimation, Dark Fantasy, Digital Painting, Dreamcore, Editorial Blur, Felted, Glowwave, Golden Age Cinema, Inkflow, Moody Realism, Oldschool Comic, Old VHS, Pixel Art, Quiet Blue Hour, Retro Line Art, Silver Hue Analog, Simple Flat Animation, Soft Infrared, Stylized 3Dtoon, Sunny Nostalgia, Synthwave, Vintage Black & White, Watercolor, Whimsy Animation, Y2K Analog, None

### Style Stacking (Vibe + Lighting + Color Theme)
The Style section has three layers. Click each button to open its panel, then select from the options. You can stack one from each layer.

**Opening style panels:**
Click the Vibe/Lighting/Color Theme button in the sidebar. A panel opens with tabs for the other two layers.

**Vibe options (9):** Clay, Color Sketch, Logo, Papercraft, Pro Photo, Sci-Fi, Sketch, Stock Footage, None

**Lighting options (16):** Backlight, Candle Lit, Chiaroscuro, Film Haze, Foggy, Golden Hour, Hardlight, Lens Flare, Light Art, Low Key, Luminous, Mystical, Rainy, Soft Light, Volumetric, None

**Color Theme options (14):** Autumn, Complimentary, Cool, Dark, Earthy, Electric, Iridescent, Pastel, Split, Terracotta Teal, Ultraviolet, Vibrant, Warm, None

**To select a style from any layer:**
1. Click the layer button (Vibe/Lighting/Color Theme) to open the panel
2. If needed, click the tab to switch between layers
3. Click the style button:
```javascript
(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'STYLE_NAME'); if (b) { b.click(); return 'selected'; } return 'not found'; })()
```
4. Close the panel with Escape or click the close button

**To clear all styles:** Click "Clear all" button in the Style section.

### Prompt Enhance
Click the Prompt Enhance combobox:
```javascript
(() => { const c = document.querySelector('[role="combobox"]'); if (c) { c.click(); return 'opened'; } return 'not found'; })()
```

**Options:**
- **Auto** (default) — Short prompts expanded, long prompts left as-is
- **On** — Always refine prompts
- **Off** — Never modify prompts

**Recommendation:** Set to "Off" when using carefully engineered prompts from the prompter modules. Set to "Auto" for quick/casual generation.

### Generation Mode / Resolution
The Generation Mode section shows resolution options. These change depending on the selected model.
- For Motion 2.0 Fast: shows "Quality 720p" as a radio option
- Other models may show different options (480p, 720p, 1080p)

### Video Dimensions
```
browser_click selector: "[role='radio']:has-text('RATIO')"
```
**Options:** Auto (default), 2:3, 4:5, 9:16

### Number of Generations
```
browser_click selector: "[role='radio']:has-text('NUMBER')"
```
**Options:** 1 (default), 2, 3, 4

### Advanced Settings
Click the "Advanced Settings" button to expand:
```javascript
(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Advanced Settings')); if (b) { b.click(); return 'expanded'; } return 'not found'; })()
```

**Reveals:**
- **Smooth Video** — toggle for smoother frame interpolation
- **Negative Prompt** — toggle on to reveal a text input for negative prompts
- **Use Fixed Seed** — toggle for reproducible results

To toggle a switch, find and click it:
```javascript
(() => {
  const switches = document.querySelectorAll('[role="switch"]');
  // Toggle Negative Prompt has aria-label
  const np = Array.from(switches).find(s => s.getAttribute('aria-label') === 'Toggle Negative Prompt');
  if (np) { np.click(); return 'toggled'; }
  return 'not found';
})()
```

### Image Guidance (Start/End Frame & Reference)

**Preferred method — use the dedicated tool:**
```
leonardo_browser_reference type: "start_frame" filePaths: ["/path/to/image.png"] autoClear: true
```
For end frames (supported models only):
```
leonardo_browser_reference type: "end_frame" filePaths: ["/path/to/image.png"] autoClear: true
```

**Manual method (fallback):**
1. Click "Add Image Guidance to generation" button near the prompt:
```javascript
(() => {
  const btns = document.querySelectorAll('button');
  for (const b of btns) {
    if (b.textContent.includes('Image Guidance') || b.textContent.includes('Add Image')) {
      b.click(); return 'opened';
    }
  }
  return 'not found';
})()
```
2. Upload the image:
```
browser_upload selector: "input[type='file']" filePaths: ["/path/to/image.png"]
```
3. For end frame, look for an "End Frame" tab or toggle after uploading the start frame.

**Video reference capabilities by model:**
| Model | Start Frame | End Frame | Image Ref |
|-------|-------------|-----------|-----------|
| All video models | Yes | — | — |
| Kling Video 3.0 | Yes | Yes | — |
| Kling Video O3 Omni | Yes | Yes | Yes |
| Veo 3.1 | Yes | Yes | Yes |
| Kling O1 | Yes | Yes | Yes |
| Seedance 1.0 Lite | Yes | Yes | Yes |
| Kling 2.5 Turbo | Yes | Yes | — |
| Kling 2.1 Pro | Yes | Yes | — |
| Seedance 1.0 Pro | Yes | Yes | — |

### Prompt & Generate
Same as image page — use `leonardo_browser_generate` to fill prompt and click Generate.

---

## LIBRARY PAGE

**URL:** `https://app.leonardo.ai/library`

Use `leonardo_browser_library` to navigate here. Use `browser_snapshot` to see generations.

**Actions on generations:**
- Copy prompt: click "Copy prompt" button
- Reuse prompt: click "Reuse prompt" button
- Iterate: click "Iterate" button to refine
- Download: click "Download All" button
- Delete: click "Delete All" button

---

## UPSCALER PAGE

**URL:** `https://app.leonardo.ai/universal-upscaler`

Navigate via `leonardo_browser_navigate page: "upscaler"`. Use `browser_snapshot` to see the UI, then interact with the available controls.

---

## Error Recovery

If a click fails:
1. Take a `browser_snapshot` to see current page state
2. Look for the element in the snapshot output
3. Try alternative selectors or `browser_evaluate` with JavaScript
4. If a dialog is blocking, press Escape first
5. If the page hasn't loaded, `browser_wait loadState: "load" timeout: 10000`
