# Image Prompter — Guided Questionnaire

Guide the user through creating the perfect image on Leonardo.ai. Ask questions using `AskUserQuestion`, then engineer the optimal prompt and configure all browser settings.

**Important:** This is a browser-based workflow. After the questionnaire, you'll set all parameters in the Leonardo.ai UI using browser tools, then fill the prompt and click Generate.

---

## Phase 1 — Vision (What do you want to create?)

Ask the user to describe their image concept. If `$TOPIC` was set by the router, use it as the starting point and skip asking — but still categorize it.

Use `AskUserQuestion`:
> **What kind of image do you want to create?**
> Describe your vision — subject, scene, mood, purpose.

After they respond, categorize into one of:
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

## Phase 6 — Prompt Engineering

Now engineer the optimal prompt based on everything gathered. Follow these rules:

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
Using the user's description from Phase 1 and all style context, craft the perfect prompt. Show it to the user and ask for approval before proceeding.

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
