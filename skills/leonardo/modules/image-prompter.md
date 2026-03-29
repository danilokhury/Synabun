# Image Prompter — Guided Questionnaire

Guide the user through creating the perfect image on Leonardo.ai. Ask questions using `AskUserQuestion`, then engineer the optimal prompt and configure all browser settings.

**Important:** This is a browser-based workflow. After the questionnaire, you'll set all parameters in the Leonardo.ai UI using browser tools, then fill the prompt and click Generate.

---

## Phase 1 — Vision (What do you want to create?)

Ask the user to describe their image concept. If `$TOPIC` was set by the router, use it as the starting point and skip asking — but still categorize it.

**Do NOT use AskUserQuestion here** — this requires free-text input. Output a natural chat message:

> **What kind of image do you want to create?**
> Describe your vision — subject, scene, mood, purpose. You can also paste or drag reference images for inspiration.

Wait for the user's typed response. After they respond, categorize into one of:
- **Portrait/People** — headshots, characters, fashion, editorial
- **Landscape/Architecture** — environments, buildings, scenery
- **Product/Commercial** — product shots, e-commerce, branding
- **Illustration/Art** — concept art, digital painting, fantasy
- **Abstract** — patterns, textures, experimental
- **Photography** — street, documentary, lifestyle
- **Logo/Design** — logos, icons, typography, posters
- **Anime/Manga** — anime-style characters, manga illustrations
- **Sci-Fi/Fantasy** — futuristic, otherworldly, imaginative

Store as `$CATEGORY`.

---

## Phase 2 — Model Selection

Present model options based on `$CATEGORY`. Use `AskUserQuestion`:

> **Which image model should we use?**

- **Auto (Recommended)** — "I'll pick the best model for your concept"
- **Lucid Origin** — "Free, unlimited. Excellent prompt adherence and text rendering, HD output"
- **Lucid Realism** — "Free, unlimited. Best for cinematic shots, pairs great with video generation"
- **FLUX Dev** — "Free, unlimited. Detailed, realistic images with style/content reference support"
- **FLUX Schnell** — "Free, unlimited. Fast, quality outputs"
- **Phoenix 1.0** — "Free, unlimited. Great prompt adherence, text rendering, image-to-image support"
- **Seedream 4.5** — "Premium. Best for posters, logos, and text-heavy designs"
- **FLUX.2 Pro** — "Premium. Advanced prompt adherence with high-fidelity results"
- **GPT Image-1.5** — "Premium. Superior editing control and detail preservation"
- **Ideogram 3.0** — "Premium. Best text rendering and consistent generation"
- **Let me choose from all models** — "Show me the full list"

If **Auto**, select based on category:
| Category | Recommended Model | Why |
|----------|------------------|-----|
| Portrait/People | Lucid Realism | Cinematic realism, free |
| Landscape/Architecture | FLUX.2 Pro or FLUX Dev | High fidelity |
| Product/Commercial | GPT Image-1.5 | Editing control |
| Illustration/Art | FLUX Dev or Phoenix 1.0 | Creative flexibility |
| Abstract | FLUX Dev | Style/content ref support |
| Photography | Lucid Realism | Photorealistic |
| Logo/Design | Seedream 4.5 or Ideogram 3.0 | Text rendering |
| Anime/Manga | Phoenix 1.0 | Preset support |
| Sci-Fi/Fantasy | FLUX.2 Pro | High fidelity |

Store as `$MODEL`.

---

## Phase 2.5 — Reference Images (Optional)

Check if the user attached images with their **current message** (file paths appear at the top of the prompt). Do NOT check `image_staged` here — old staged images are not reference candidates.

**If images are attached to the current message**, present options based on the selected model's capabilities. Use `AskUserQuestion`:

> **You have N reference image(s) available. How should Leonardo use them?**

Options — show ONLY those supported by `$MODEL` (see model-advisor.md capability table):

| Reference Type | Supported By | What It Does |
|----------------|-------------|--------------|
| **Image Reference** | Nano Banana 2, Seedream 4.5, GPT Image-1.5, Nano Banana Pro, FLUX.1 Kontext | Use image as direct visual reference |
| **Style Reference** | Lucid Origin, Lucid Realism, FLUX Dev, FLUX Schnell, Phoenix 1.0/0.9 | Extract and apply the visual style |
| **Content Reference** | Lucid Origin, Lucid Realism, FLUX Dev, FLUX Schnell, Phoenix 1.0/0.9 | Extract and match the content/composition |
| **Character Reference** | Phoenix 1.0, Phoenix 0.9 | Maintain character consistency |
| **Image-to-Image** | Phoenix 1.0, Phoenix 0.9 | Transform the reference into a new image |
| **Skip** | — | "Don't use reference images" |

If the selected model supports NONE of the reference types, inform the user and skip: *"[Model] doesn't support reference images. Continuing without."*

Store as `$REFERENCE_TYPE` and `$REFERENCE_PATHS`.

**If no images are attached**, ask the user if they'd like to use reference images. First check if `$MODEL` supports any reference types from the table above — if it supports NONE, skip this phase silently.

If the model supports at least one reference type, use `AskUserQuestion`:

> **Would you like to use reference images?**
> Reference images let Leonardo match a style, composition, or visual from an existing image.

- **Yes** — "I have images I'd like to use as reference"
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

## Phase 3 — Style Preset

Use `AskUserQuestion`:

> **What visual style do you want?**

- **Dynamic** (default) — "Balanced, versatile style for most subjects"
- **Cinematic** — "Film-like quality with dramatic lighting and depth"
- **Creative** — "Artistic, painterly, experimental"
- **Vibrant** — "Bold colors, high saturation, punchy"
- **Portrait** — "Optimized for faces and people"
- **Fashion** — "Editorial, high-fashion aesthetic"
- **Stock Photo** — "Clean, commercial, stock photography look"
- **None** — "No style preset — full prompt control"

**Auto-recommendation by category:**
| Category | Recommended Style |
|----------|------------------|
| Portrait/People | Portrait or Cinematic |
| Landscape/Architecture | Dynamic or Cinematic |
| Product/Commercial | Stock Photo or Dynamic |
| Illustration/Art | Creative |
| Abstract | Creative or None |
| Photography | Dynamic or Cinematic |
| Logo/Design | None or Dynamic |
| Anime/Manga | Dynamic or Creative |
| Sci-Fi/Fantasy | Cinematic or Creative |

Present the recommendation but let them choose.

Store as `$STYLE`.

---

## Phase 4 — Dimensions & Composition

Use `AskUserQuestion`:

> **What dimensions/aspect ratio?**

- **Square (1:1)** — "1024x1024. Versatile, social media, profile pictures"
- **Portrait (2:3)** — "Tall format. People, Pinterest, posters"
- **Landscape (16:9)** — "Wide format. Wallpapers, headers, cinematic"
- **Custom** — "Choose from social presets or set a custom ratio"

If **Custom**, offer social/device presets:
- **Twitter/X (4:3)** — "Timeline-optimized"
- **Instagram (4:5)** — "Feed-optimized, tall"
- **TikTok (9:16)** — "Vertical, full-screen"
- **Desktop (16:9)** — "Widescreen wallpaper"

Store as `$DIMENSIONS`.

---

## Phase 5 — Quantity & Details

Use `AskUserQuestion`:

> **How many images do you want?**

- **1** — "Single image, fastest"
- **2** — "Two variations to compare"
- **3** — "Three options"
- **4** — "Four variations, maximum choice"

Store as `$NUM_IMAGES`.

---

## Phase 5.5 — Creative Brief

You've gathered all the technical settings. Now get the user's **detailed creative vision** before engineering the prompt.

**Do NOT use AskUserQuestion here** — this requires free-text input. Output a natural chat message summarizing the config and asking for the detailed description:

> **Here's your setup:**
> - **Model:** $MODEL
> - **Style:** $STYLE
> - **Dimensions:** $DIMENSIONS
> - **Images:** $NUM_IMAGES
> [If reference images: **Reference:** $REFERENCE_TYPE with N image(s)]
>
> **Now describe your image in detail.**
> What's the subject? The scene, composition, lighting, mood, colors? Any specific elements you want included or avoided? The more detail you give, the better I can craft the prompt.

Wait for the user's typed response. Store their detailed description as `$CREATIVE_BRIEF`. This replaces the brief Phase 1 concept as the **primary input** for prompt engineering below.

---

## Phase 6 — Prompt Engineering

Now engineer the optimal prompt using `$CREATIVE_BRIEF` (the user's detailed description from Phase 5.5) combined with the style context from earlier phases. Follow these rules:

### Image Prompt Rules
1. **Subject first** — the main focus of the image
2. **Materials & texture** — "brushed aluminum", "weathered oak", "silk fabric"
3. **Lighting is critical** — "rim lighting", "soft diffused north-facing window", "dramatic chiaroscuro"
4. **Camera language for photorealistic** — "85mm f/1.4", "wide-angle 24mm", "macro close-up"
5. **Art medium for illustrations** — "oil painting", "watercolor wash", "digital concept art"
6. **Color palette** — "muted earth tones", "neon pink and teal", "monochromatic blue"
7. **Avoid vague words** — never "beautiful", "stunning", "amazing", "nice"
8. **1-3 sentences** — concise, every word counts
9. **Negative prompt for realism** — remove unwanted elements

### Prompt Structure Template
```
[Subject and action], [environment/setting], [lighting description], [camera/art style], [color and mood]
```

### Example Transformations
**User says:** "A portrait of a woman"
**Engineered:** "Editorial portrait of a woman in her 30s with natural curly hair, wearing a charcoal linen blazer against a blurred urban backdrop, shot at 85mm f/1.4 with soft window light from the left creating gentle catchlights, muted warm tones with shallow depth of field"

**User says:** "A fantasy castle"
**Engineered:** "Towering Gothic castle carved into a sea cliff face, waves crashing against dark volcanic rock below, twilight sky with scattered cirrus clouds catching the last amber light, ravens circling the highest tower, painted in the style of detailed fantasy concept art, deep blues and warm amber highlights"

**User says:** "A product shot of sneakers"
**Engineered:** "Pair of white minimalist sneakers floating on a clean gradient background, studio lighting with soft shadows, 3/4 angle view showing sole detail, crisp commercial photography with even diffused lighting, neutral tones with bright white product pop"

### Build the prompt
Using `$CREATIVE_BRIEF` from Phase 5.5 and all style context, craft the perfect prompt.

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

### Build negative prompt (if applicable)
For photorealistic images: "blurry, low quality, deformed, distorted, extra limbs, text, watermark, signature, cropped"
For illustration/art: "photographic, hyperrealistic, 3D render" (if you want to stay painterly)
For product shots: "busy background, shadows, reflections, text, hands, people"

---

## Output

Once all phases complete, output the final configuration:

```
$IMAGE_PARAMS:
  type: image
  model: $MODEL
  style: $STYLE
  dimensions: $DIMENSIONS
  num_images: $NUM_IMAGES
  prompt: "[engineered prompt]"
  negative_prompt: "[if any]"
```

Return to SKILL.md Step 3 for browser execution.
