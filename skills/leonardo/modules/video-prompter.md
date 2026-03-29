# Video Prompter — Guided Questionnaire

Guide the user through creating the perfect video on Leonardo.ai. Ask questions using `AskUserQuestion`, then engineer the optimal prompt and configure all browser settings.

**Important:** This is a browser-based workflow. After the questionnaire, you'll set all parameters in the Leonardo.ai UI using browser tools, then fill the prompt and click Generate.

---

## Phase 1 — Vision (What do you want to create?)

Ask the user to describe their video concept. If `$TOPIC` was set by the router, use it as the starting point and skip asking — but still categorize it.

**Do NOT use AskUserQuestion here** — this requires free-text input. Output a natural chat message:

> **What kind of video do you want to create?**
> Describe your vision — what happens in the scene, what's the mood, what's the purpose? You can also paste or drag reference images for inspiration.

Wait for the user's typed response. After they respond, mentally categorize into one of:
- **Narrative/Cinematic** — story-driven, character focus, emotional
- **Product/Commercial** — showcasing a product, brand, or service
- **Nature/Landscape** — environments, weather, scenery
- **Abstract/Artistic** — experimental, mood-driven, non-literal
- **Social Media** — short-form content, hooks, trending styles
- **Corporate/Explainer** — professional, informational
- **Music/Mood** — visuals for music, atmosphere, ambiance
- **Action/Dynamic** — high-energy, sports, motion-heavy

Store as `$CATEGORY`. This informs model and style recommendations.

---

## Phase 2 — Model Selection

Present model options based on the user's concept and budget tolerance. Use `AskUserQuestion`:

> **Which video model should we use?**

Options (tailor based on `$CATEGORY`):

- **Auto (Recommended)** — "I'll pick the best model for your concept"
- **Motion 2.0 Fast** — "Free, unlimited. Best motion controls & style stacking. Great for iteration"
- **Motion 2.0** — "Free, unlimited. Higher quality than Fast, same controls & styles"
- **Kling Video 3.0** — "Premium. Longer videos with audio and strong visual consistency [~70 tokens]"
- **Veo 3.1 Fast** — "Premium Fast. Quick turnaround cinematic concepts [~35 tokens]"
- **Sora 2 Pro** — "Premium. Smooth cinematic sequences with refined detail [~70 tokens]"
- **Hailuo 2.3** — "Affordable premium. High-quality video with advanced style [~25 tokens]"
- **Let me choose from all models** — "Show me the full list"

If **Auto**, select based on category:
| Category | Recommended Model |
|----------|------------------|
| Narrative/Cinematic | Kling Video 3.0 or Veo 3.1 |
| Product/Commercial | Veo 3.1 Fast |
| Nature/Landscape | Motion 2.0 |
| Abstract/Artistic | Motion 2.0 (best style control) |
| Social Media | Motion 2.0 Fast (fast + free) |
| Corporate/Explainer | Veo 3.1 Fast |
| Music/Mood | Motion 2.0 (style stacking) |
| Action/Dynamic | Kling 2.6 or Sora 2 Pro |

If **Let me choose**, list all 23 video models from the browser-guide model table and let them pick.

Store as `$MODEL`.

**Important:** Only Motion 2.0 and Motion 2.0 Fast support Motion Controls, Motion Elements, and Style Stacking. If another model is chosen, skip Phases 3, 4, and 5.

---

## Phase 2.5 — Reference Images / Start Frame (Optional)

Check if the user attached images with their **current message** (file paths appear at the top of the prompt). Do NOT check `image_staged` here — old staged images are not reference candidates.

**If images are attached to the current message**, present options based on the selected model's capabilities. Use `AskUserQuestion`:

> **You have N reference image(s) available. How should Leonardo use them?**

Options — show ONLY those supported by `$MODEL` (see model-advisor.md video capabilities table):

| Reference Type | Supported By | What It Does |
|----------------|-------------|--------------|
| **Start Frame** | All video models | Use image as the first frame — video animates from this |
| **End Frame** | Kling Video 3.0, Kling Video O3 Omni, Veo 3.1, Kling 2.5 Turbo, Kling 2.1 Pro, Seedance 1.0 Pro/Lite, Kling O1 | Use image as the last frame — video ends here |
| **Image Reference** | Kling Video O3 Omni, Veo 3.1, Kling O1, Seedance 1.0 Lite | Visual reference for the generation |
| **Skip** | — | "Don't use reference images" |

Store as `$START_FRAME`, `$END_FRAME`, `$REFERENCE_TYPE`, `$REFERENCE_PATHS`.

**If no images are attached**, ask the user if they'd like to use reference images or frames. Use `AskUserQuestion`:

> **Would you like to use reference images or start/end frames?**
> You can provide an image to use as a starting frame, ending frame, or visual reference for the video.

- **Yes** — "I have images I'd like to use"
- **No** — "Continue without reference images"

If **Yes**, respond with this message (plain text, not AskUserQuestion):

> **Attach your reference image(s) to the chat.**
> Copy the message below, paste it in the input box, attach your images, and send:
> ```
> Here are my reference images
> ```

Then wait for the user's next message. Check for file paths at the top of their message and also check `image_staged` (action: "list", type: "attachment") for newly attached images. If images are found, proceed with the reference type selection above (the "If images are attached" flow). If no images were found, inform the user no images were detected and ask them to try again or skip.

If **No**, continue to Phase 3.

---

## Phase 3 — Motion Control (Motion 2.0 / Fast only)

Use `AskUserQuestion`:

> **What camera movement do you want?**

Present curated options based on `$CATEGORY`:

- **Smooth & Cinematic** — "Dolly In — slow push toward subject, builds intimacy"
- **Dynamic & Energetic** — "Handheld — raw, documentary feel with natural shake"
- **Dramatic Reveal** — "Crane Up — rises to reveal the full scene, epic feel"
- **Orbiting** — "Orbit Left/Right — circles around the subject, showcases all angles"
- **Zoom Impact** — "Crash Zoom In — sudden dramatic zoom for emphasis"
- **Super Push** — "Super Dolly In — intense forward drive, powerful energy"
- **Static / None** — "No camera movement — subject does all the moving"
- **Special Effect** — "Explosion, Disintegration, Freezing, and other dramatic FX"
- **Browse all 39 options** — "See every available motion control"

If **Browse all**, list all 39:
**Camera:** Dolly In/Out/Left/Right, Crane Up/Down/Over Head, Tilt Up/Down, Orbit Left/Right, Rotate, Dutch Angle, Snorricam, Robo Arm, Lazy Susan
**Zoom:** Crash Zoom In/Out, Medium Zoom In, Super Dolly In/Out, YoYo Zoom, Bullet Time
**FX:** Explosion, Disintegration, Freezing, Flood, Set on Fire, Thunder God, Night, Metal, Light Morph, Ripple Morph, Lens Crack, Touch Glass, Tattoo Motion, Handheld, Eyes In, Mouth In

Store as `$MOTION_CONTROL`.

---

## Phase 4 — Motion Elements (Motion 2.0 / Fast only)

Use `AskUserQuestion`:

> **Want to add a creative style overlay?**
> Motion Elements add artistic filters to the entire video — like shooting through a specific visual lens.

- **None (recommended for realism)** — "Keep the natural look of the video"
- **Cinematic/Film** — "Golden Age Cinema, Moody Realism, CGI Noir, Editorial Blur"
- **Animation** — "Simple Flat Animation, Claynimation, Stylized 3Dtoon, Whimsy Animation"
- **Retro/Vintage** — "Old VHS, 90s Retro Anime, Vintage Black & White, Y2K Analog, Sunny Nostalgia"
- **Art Styles** — "Watercolor, Digital Painting, Inkflow, Pixel Art, Retro Line Art"
- **Mood/Atmosphere** — "Dreamcore, Glowwave, Synthwave, Dark Fantasy, Soft Infrared, Quiet Blue Hour"
- **Craft** — "Felted, Silver Hue Analog, Oldschool Comic"
- **Browse all 27** — "See every option"

Store as `$MOTION_ELEMENT`.

---

## Phase 5 — Style Stacking (Motion 2.0 / Fast only)

Style stacking lets you layer up to 3 styles: one Vibe + one Lighting + one Color Theme.

Use `AskUserQuestion`:

> **Style Stacking — Layer up to 3 styles for the perfect look.**
> Pick one from each category, or skip any.

**Vibe** (the overall aesthetic):
- Pro Photo, Stock Footage, Sci-Fi, Sketch, Clay, Color Sketch, Logo, Papercraft, None

**Lighting** (how light behaves):
- Golden Hour, Chiaroscuro (cinematic), Volumetric, Lens Flare, Backlight, Candle Lit, Film Haze, Foggy, Hardlight, Light Art, Low Key, Luminous, Mystical, Rainy, Soft Light, None

**Color Theme** (color palette):
- Warm, Cool, Vibrant, Dark, Autumn, Earthy, Electric, Iridescent, Pastel, Complimentary, Split, Terracotta Teal, Ultraviolet, None

**Recommended combos by concept:**
| Concept | Vibe | Lighting | Color |
|---------|------|----------|-------|
| Hollywood blockbuster | Pro Photo | Chiaroscuro | Warm |
| Cyberpunk/Sci-Fi | Sci-Fi | Volumetric | Dark |
| Product commercial | Pro Photo | Soft Light | Vibrant |
| Music video | — | Lens Flare | Electric |
| Nature documentary | Stock Footage | Golden Hour | Earthy |
| Horror/Dark | — | Low Key | Dark |
| Vintage/Retro | — | Film Haze | Autumn |
| Clean corporate | Pro Photo | Soft Light | Cool |
| Dreamy/Ethereal | — | Luminous | Iridescent |
| Social media bright | — | Backlight | Vibrant |

Present the recommendation for their `$CATEGORY`, but let them customize.

Store as `$STYLE_VIBE`, `$STYLE_LIGHTING`, `$STYLE_COLOR`.

---

## Phase 6 — Technical Settings

Use `AskUserQuestion`:

> **Technical settings:**

- **Video Dimensions** — "Auto (recommended), 2:3 (portrait), 4:5 (social), 9:16 (vertical/TikTok)"
- **Prompt Enhance** — "Auto (expands short prompts), On (always enhance), Off (use my exact prompt)"
- **Number of generations** — "1 (default), 2, 3, or 4 variations"

Then ask about advanced settings:

> **Advanced options (all optional):**
- **Negative prompt?** — "Describe what you DON'T want in the video"
- **Smooth Video?** — "Enable frame interpolation for smoother motion"
- **Fixed Seed?** — "Use a fixed seed for reproducible results"

Store all as: `$DIMENSIONS`, `$PROMPT_ENHANCE`, `$NUM_GENERATIONS`, `$NEGATIVE_PROMPT`, `$SMOOTH_VIDEO`, `$FIXED_SEED`.

---

## Phase 6.5 — Creative Brief

You've gathered all the technical settings. Now get the user's **detailed creative vision** before engineering the prompt.

**Do NOT use AskUserQuestion here** — this requires free-text input. Output a natural chat message summarizing the config and asking for the detailed description:

> **Here's your setup:**
> - **Model:** $MODEL
> [If Motion 2.0/Fast: **Motion Control:** $MOTION_CONTROL | **Motion Element:** $MOTION_ELEMENT]
> [If Motion 2.0/Fast: **Style:** $STYLE_VIBE + $STYLE_LIGHTING + $STYLE_COLOR]
> - **Dimensions:** $DIMENSIONS
> - **Generations:** $NUM_GENERATIONS
> [If start/end frame: **Start Frame:** attached | **End Frame:** attached]
>
> **Now describe your video scene in detail.**
> What happens? What's the subject doing? What's the environment, lighting, mood, movement, and atmosphere? Think of it as directing a camera operator — the more specific, the better the result.

Wait for the user's typed response. Store their detailed description as `$CREATIVE_BRIEF`. This replaces the brief Phase 1 concept as the **primary input** for prompt engineering below.

---

## Phase 7 — Prompt Engineering

Now engineer the optimal prompt using `$CREATIVE_BRIEF` (the user's detailed description from Phase 6.5) combined with the motion/style context from earlier phases. Follow these rules:

### Video Prompt Rules
1. **Lead with camera movement** — "Slow dolly forward...", "Crane up over..."
2. **Describe specific motion** — what moves, how it moves, at what speed
3. **Use time indicators** — "slowly", "suddenly", "gradually", "the camera drifts"
4. **Include sensory details** — textures, materials, light behavior, atmosphere
5. **Specify lighting explicitly** — "golden hour backlighting", "volumetric fog"
6. **Describe depth** — foreground, midground, background layers
7. **Avoid vague words** — never use "beautiful", "amazing", "stunning", "epic"
8. **2-4 sentences** — concise but descriptive
9. **End with atmosphere** — the overall mood and feeling of the scene

### Prompt Structure Template
```
[Camera movement] [through/over/toward] [environment description], [subject action and detail], [lighting and atmosphere], [color palette and mood]
```

### Example Transformations
**User says:** "A sunset over the ocean"
**Engineered:** "Slow crane up over a calm Pacific shoreline at golden hour, waves catching amber and copper light as they roll gently toward wet sand, the sun sits low on the horizon casting long shadows through scattered clouds, warm diffused light with deep navy sky gradient at the edges"

**User says:** "A futuristic city"
**Engineered:** "Super dolly in through towering neon-lit skyscrapers in a rain-soaked cyberpunk megacity, flying vehicles streak past leaving light trails, holographic advertisements flicker on glass facades, volumetric fog catches pink and teal neon from street-level vendors, camera pushes through the canyon of buildings toward a distant glowing spire"

### Build the prompt
Using `$CREATIVE_BRIEF` from Phase 6.5, the motion control from Phase 3, and all style context, craft the perfect prompt.

**You MUST display the engineered prompt before asking for review.** Show it in a formatted block:

> **Engineered Prompt:**
> ```
> [your engineered prompt here]
> ```
> [If negative prompt: **Negative:** `[negative prompt]`]

Then use `AskUserQuestion` for review:
> **How does this prompt look?**
- **Looks good — generate** — "Use this prompt as-is and proceed to generation"
- **Tweak it** — "I want to adjust the prompt before generating"
- **Rewrite it** — "Start the prompt from scratch with different direction"

If **Tweak it**: ask what they want changed (plain text, not AskUserQuestion), apply changes, show the updated prompt, and ask again.
If **Rewrite it**: ask for new direction (plain text), re-engineer from scratch, show the new prompt, and ask again.

### Build negative prompt (if enabled)
Common video negatives: "blurry, low quality, distorted faces, text overlay, watermark, static image, frozen frame, glitch artifacts, unnatural motion"

---

## Output

Once all phases complete, output the final configuration:

```
$VIDEO_PARAMS:
  type: video
  model: $MODEL
  motion_control: $MOTION_CONTROL
  motion_element: $MOTION_ELEMENT
  style_vibe: $STYLE_VIBE
  style_lighting: $STYLE_LIGHTING
  style_color: $STYLE_COLOR
  dimensions: $DIMENSIONS
  prompt_enhance: $PROMPT_ENHANCE
  num_generations: $NUM_GENERATIONS
  negative_prompt: $NEGATIVE_PROMPT
  smooth_video: $SMOOTH_VIDEO
  fixed_seed: $FIXED_SEED
  prompt: "[engineered prompt]"
```

Return to SKILL.md Step 3 for browser execution.
