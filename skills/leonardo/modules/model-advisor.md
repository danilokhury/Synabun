# Model Advisor — Reference Guide

Quick reference for Leonardo.ai model selection. Use this when you need to recommend the best model for a specific use case.

---

## Image Models — Decision Matrix

| Use Case | Best Model | Why | Cost |
|----------|-----------|-----|------|
| Photorealistic portraits | Lucid Realism | Cinematic realism, pairs w/ video | Unlimited |
| Product photography | GPT Image-1.5 | Superior editing & detail | Paid |
| Landscapes & architecture | FLUX.2 Pro | High-fidelity, prompt adherence | Paid |
| Concept art & illustration | FLUX Dev | Creative flexibility, style ref | Unlimited |
| Anime/Manga | Phoenix 1.0 + style preset | Preset support, character ref | Unlimited |
| Text in images / logos | Ideogram 3.0 or Seedream 4.5 | Best text rendering | Paid |
| Quick iterations | FLUX Schnell | Fastest free model | Unlimited |
| Maximum quality | Seedream 4.5 | Ultra quality, posters/logos | Paid |
| Style transfer / editing | FLUX.1 Kontext Max | Precise control, max quality | Paid |
| Context-aware editing | Nano Banana 2 | Fast, sharp, simple editing | Paid |
| HD with text rendering | Lucid Origin | Prompt adherence + text + HD | Unlimited |
| Consistency & infographics | Nano Banana Pro | Gemini 3 Pro based | Paid |
| Budget-conscious | Lucid Origin / FLUX Dev / Phoenix 1.0 | All unlimited/free | Unlimited |

### Model Capabilities Quick Reference
| Model | Image Ref | Style Ref | Content Ref | Character Ref | Image-to-Image | Elements |
|-------|-----------|-----------|-------------|---------------|----------------|----------|
| Lucid Origin | — | Yes | Yes | — | — | — |
| Lucid Realism | — | Yes | Yes | — | — | — |
| FLUX Dev | — | Yes | Yes | — | — | Yes |
| FLUX Schnell | — | Yes | Yes | — | — | — |
| Phoenix 1.0 | — | Yes | Yes | Yes | Yes | — |
| Phoenix 0.9 | — | Yes | Yes | Yes | Yes | — |
| FLUX.2 Pro | — | — | — | — | — | Image Guidance |
| Nano Banana 2 | Yes | — | — | — | — | — |
| Seedream 4.5 | Yes | — | — | — | — | — |
| GPT Image-1.5 | Yes | — | — | — | — | — |
| Nano Banana Pro | Yes | — | — | — | — | — |
| Ideogram 3.0 | — | — | — | — | — | — |

---

## Video Models — Decision Matrix

| Use Case | Best Model | Why | Cost |
|----------|-----------|-----|------|
| Quick testing / iteration | Motion 2.0 Fast | Fast, free, all controls | Unlimited |
| Best free quality | Motion 2.0 | Higher quality, all controls | Unlimited |
| Cinematic storytelling | Veo 3.1 | Start/end frame, audio | ~70 tokens |
| Fast premium | Veo 3.1 Fast | Quick turnaround | ~35 tokens |
| Realistic people & audio | Kling Video 3.0 | Longer videos, consistency | ~70 tokens |
| Voiceovers & sound FX | Kling 2.6 | Natural voiceovers, audio | Paid |
| Smooth cinematic | Sora 2 Pro | Refined detail, motion | ~70 tokens |
| Social media (fast + free) | Motion 2.0 Fast | Speed + no cost | Unlimited |
| Product showcase | Veo 3.1 Fast | Quick, professional | ~35 tokens |
| Budget premium | LTX-2 Pro / Hailuo 2.3 | Quality per token | ~25 tokens |
| Multi-instruction prompts | Kling O1 | Exceptional accuracy | Paid |
| Image ref / start+end frame | Kling Video O3 Omni | Audio + image ref | Paid |
| Basic subtle motion | Motion 1.0 | Simple image animation | Unlimited |

### Video Model Capabilities
| Model | Audio | Start Frame | End Frame | Image Ref | Controls | Elements | Styles | Fast |
|-------|-------|-------------|-----------|-----------|----------|----------|--------|------|
| Motion 2.0 | — | Yes | — | — | **Yes** | **Yes** | **Yes** | — |
| Motion 2.0 Fast | — | Yes | — | — | **Yes** | **Yes** | **Yes** | Yes |
| Motion 1.0 | — | Yes | — | — | — | — | — | — |
| Kling Video 3.0 | Yes | Yes | Yes | — | — | — | — | — |
| Kling Video O3 Omni | Yes | Yes | Yes | Yes | — | — | — | — |
| Kling 2.6 | Yes | Yes | — | — | — | — | — | — |
| Kling O1 | — | Yes | Yes | Yes | — | — | — | — |
| Kling 2.5 Turbo | — | Yes | Yes | — | — | — | — | — |
| Kling 2.5 Turbo Std | — | Yes | — | — | — | — | — | — |
| Kling 2.1 Pro | — | Yes | Yes | — | — | — | — | — |
| Veo 3.1 | Yes | Yes | Yes | Yes | — | — | — | — |
| Veo 3.1 Fast | Yes | Yes | Yes | — | — | — | — | Yes |
| Veo 3 | Yes | Yes | — | — | — | — | — | — |
| Veo 3 Fast | Yes | Yes | — | — | — | — | — | Yes |
| Sora 2 Pro | Yes | Yes | — | — | — | — | — | — |
| Sora 2 | Yes | Yes | — | — | — | — | — | — |
| Hailuo 2.3 | — | Yes | — | — | — | — | — | — |
| Hailuo 2.3 Fast | — | Yes | — | — | — | — | — | — |
| Seedance 1.0 Pro | — | Yes | Yes | — | — | — | — | — |
| Seedance 1.0 Pro Fast | — | Yes | — | — | — | — | — | Yes |
| Seedance 1.0 Lite | — | Yes | Yes | Yes | — | — | — | — |
| LTX-2 Pro | Yes | Yes | — | — | — | — | — | — |
| LTX-2 Fast | Yes | Yes | — | — | — | — | — | Yes |

### Key Insight
**Controls, Elements, and Styles are exclusive to Motion 2.0 / Motion 2.0 Fast.** All other models rely purely on prompt engineering for style and motion guidance.

---

## Cost Optimization Tips

1. **Start with Motion 2.0 Fast** for video iteration — it's free and unlimited
2. **Use unlimited image models** (Lucid Origin, Lucid Realism, FLUX Dev, Phoenix) when experimenting
3. **Switch to premium only for final renders** — Veo 3.1 Fast over Veo 3.1 saves ~50% tokens
4. **Hailuo 2.3 and LTX-2 Pro** offer the best quality-per-token for premium video
5. **Avoid 1080p unless necessary** — 720p is usually sufficient
6. **Generate 1 at a time** to conserve tokens while iterating
