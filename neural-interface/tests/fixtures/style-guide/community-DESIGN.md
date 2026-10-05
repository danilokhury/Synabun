---
version: alpha
name: Nimbus
description: A calm, dense dashboard for cloud operators. # an invented brand, in the community collection's shape
colors:
  primary: "#5b5bd6"
  secondary: '#00a2c7'
  background: "#0b0d12"
  surface: "#151821"
  on-surface: "#e6e8ee"
  text-secondary: "#9aa3b2"
  outline: "#2a2f3a"
  on-primary: "#ffffff"
  error: "#e5484d"
  success: "#3dd68c"
  brand-mint: #3dd68c
typography:
  display-lg:
    fontFamily: Geist
    fontSize: 3.5rem
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Geist
    fontSize: 28px
    fontWeight: 600
    lineHeight: 36px
    letterSpacing: -0.28px
  body-md:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
  label-sm:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: medium
    lineHeight: 1.3
    letterSpacing: 0.04em
  code-sm:
    fontFamily: Geist Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: '"zero" 1'
rounded:
  sm: 4px
  md: 8px
  lg: 0.75rem
  pill: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 1.5rem
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.pill}"
    padding: 12px 20px
    hover:
      backgroundColor: "{colors.secondary}"
  card-metric:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  tag-status:
    backgroundColor: "{colors.brand-mint}"
    rounded: "{rounded.sm}"
---

# Nimbus

## Overview

A calm, dense dashboard for cloud operators. Dark first, with hairline borders and one violet accent.

It should feel like an instrument panel, not a marketing site.

### Key Characteristics

- Dark surfaces one step apart in lightness
- Hairline borders instead of shadows
- **Violet** for action, mint for healthy state

## Colors

### Brand & Accent

- **Primary** `#5b5bd6` — actions and links

## Typography

### Principles

- Numbers are tabular
- Headlines are set tight

## Layout

### Whitespace Philosophy

Density over decoration: 8px rhythm, no empty hero areas.

## Do's and Don'ts

### Do

- Keep density high
- Use mint only for healthy state

### Don't

- Use drop shadows
- Mix more than two accents on a screen

## Responsive Behavior

### Breakpoints

- 640px: single column
- 1024px: sidebar appears

## Iteration Guide

1. Start from the tokens in the frontmatter.
2. Change one variable at a time.
