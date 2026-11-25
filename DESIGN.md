---
version: alpha
name: ZenBot
description: Discord bot canvas renderers for X post cards, Fortnite minimap overlays, and system tray branding.
colors:
  primary: "#1D9BF0"
  text: "#0F1419"
  muted: "#536471"
  border: "rgba(0,0,0,0.08)"
  verified-gov: "#829AAB"
  verified-biz: "#E0B400"
  media-placeholder: "#EFF3F4"
  panel-bg: "rgba(255,255,255,0.94)"
  white: "#FFFFFF"
  avatar-initials: "rgba(255,255,255,0.9)"
  overlay-dark: "rgba(0,0,0,0.7)"
  overlay-mid: "rgba(0,0,0,0.6)"
  overlay-play: "rgba(0,0,0,0.55)"
  avatar-purple: "#7856FF"
  avatar-green: "#00BA7C"
  avatar-red: "#E0525F"
  avatar-amber: "#FFAD1F"
  avatar-violet: "#9C6ADE"
  poi-dot: "red"
  poi-stroke: "black"
  blurple: "#5865f2"
typography:
  body:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'
    fontWeight: 400
    fontSize: 16px
    lineHeight: 24px
  author:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'
    fontWeight: 700
    fontSize: 15px
  body-sm:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'
    fontWeight: 400
    fontSize: 14px
    lineHeight: 20px
  sensitive:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'
    fontWeight: 600
    fontSize: 14px
  meta:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'
    fontWeight: 400
    fontSize: 13px
  quote-author:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'
    fontWeight: 700
    fontSize: 13px
  badge:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif'
    fontWeight: 600
    fontSize: 11px
  map-label:
    fontFamily: sans-serif
    fontWeight: 700
    fontSize: 26px
rounded:
  xs: 2px
  sm: 8px
  md: 10px
  lg: 12px
  full: 9999px
spacing:
  xxs: 2px
  xs: 8px
  sm: 14px
  md: 18px
  lg: 24px
  xl: 36px
components:
  tweet-panel:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: 14px
    width: 792px
  tweet-author:
    textColor: "{colors.text}"
    typography: "{typography.author}"
  tweet-handle:
    textColor: "{colors.muted}"
    typography: "{typography.body-sm}"
  tweet-link:
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  tweet-footer:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    rounded: "{rounded.lg}"
    padding: 14px
  quote-panel:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: 14px
  quote-author:
    textColor: "{colors.text}"
    typography: "{typography.quote-author}"
  quote-accent:
    backgroundColor: "{colors.border}"
    rounded: "{rounded.xs}"
    width: 3px
  quote-media:
    rounded: "{rounded.sm}"
  verified-gov:
    textColor: "{colors.verified-gov}"
    size: 18px
  verified-biz:
    textColor: "{colors.verified-biz}"
    size: 18px
  media-tile:
    backgroundColor: "{colors.media-placeholder}"
    rounded: "{rounded.lg}"
  media-play:
    backgroundColor: "{colors.overlay-play}"
    textColor: "{colors.white}"
    rounded: "{rounded.full}"
    size: 64px
  media-gif-badge:
    backgroundColor: "{colors.overlay-mid}"
    textColor: "{colors.white}"
    typography: "{typography.badge}"
    rounded: "{rounded.md}"
    height: 20px
  media-sensitive-overlay:
    backgroundColor: "{colors.overlay-dark}"
    textColor: "{colors.white}"
    typography: "{typography.sensitive}"
  avatar-purple:
    backgroundColor: "{colors.avatar-purple}"
    textColor: "{colors.avatar-initials}"
    rounded: "{rounded.full}"
    size: 40px
  avatar-green:
    backgroundColor: "{colors.avatar-green}"
    rounded: "{rounded.full}"
    size: 40px
  avatar-red:
    backgroundColor: "{colors.avatar-red}"
    rounded: "{rounded.full}"
    size: 40px
  avatar-amber:
    backgroundColor: "{colors.avatar-amber}"
    rounded: "{rounded.full}"
    size: 40px
  avatar-violet:
    backgroundColor: "{colors.avatar-violet}"
    rounded: "{rounded.full}"
    size: 40px
  map-poi-dot:
    backgroundColor: "{colors.poi-dot}"
    rounded: "{rounded.full}"
    size: 14px
  map-poi-label:
    backgroundColor: "{colors.poi-stroke}"
    textColor: "{colors.white}"
    typography: "{typography.map-label}"
  tray-icon:
    backgroundColor: "{colors.blurple}"
    size: 32px
---

## Overview

ZenBot is a Discord bot with no web frontend. Its visual surfaces are server-rendered PNG images generated with `@napi-rs/canvas` for X/Twitter post previews (`twitter.js`) and Fortnite minimap overlays (`app.js`), Discord embeds for status updates (`fortnite-status-stream.js`), and a Windows system tray icon (`assets/build-tray-icon.py`).

## Colors

X post cards render on a transparent canvas using translucent white panels (`rgba(255,255,255,0.94)`), dark ink (`#0F1419`), muted slate (`#536471`), and X blue (`#1D9BF0`) for links, mentions, hashtags, and verified badges. Government and business badges use `#829AAB` and `#E0B400`. Missing avatars fall back to a six-color deterministic palette (`#7856FF`, `#1D9BF0`, `#00BA7C`, `#E0525F`, `#FFAD1F`, `#9C6ADE`) with `rgba(255,255,255,0.9)` initials. Discord status embeds reuse `#1D9BF0`, Fortnite map pins use red dots with white text and black strokes, and the Windows tray icon tints the lotus glyph in Discord blurple (`#5865f2`).

## Typography

Post cards use the system UI stack (`"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif`) across five sizes: 16px body text and article titles (`24px` line height), 15px bold author names, 14px handles and quote bodies (`20px` line height), 13px metadata and footer stats, and 11px semibold GIF badges. Minimap labels use `bold 26px sans-serif`.

## Layout

Post cards have a fixed `840px` canvas width with `24px` outer padding (`14px` bottom), producing a `792px` content column. Vertical blocks (header and body, media grid, quote block, stats footer) are separated by `8px` gaps, with `14px` inner panel padding and `2px` gaps inside multi-image grids.

## Elevation & Depth

Text, quote, and footer panels cast a soft drop shadow (`rgba(0,0,0,0.10)`, `16px` blur, `4px` vertical offset). Media grid tiles sit directly on the transparent canvas without a backing panel and cast a deeper halo (`rgba(0,0,0,0.32)`, `28px` blur, `8px` vertical offset) to separate image edges from light or dark Discord themes.

## Shapes

Panels and media grid cells use `12px` rounded corners. Embedded quote media uses `8px`, GIF badges use `10px` pills, quote vertical accent bars use `2px` ends, and avatars and video play buttons are circular (`arc`).

## Components

- **Tweet panels**: `792px` wide translucent white cards with `14px` inset, `40px` header avatars, `18px` verified badges, and right-aligned timestamps.
- **Media grid**: One-to-four image layouts with `2px` gutters, `rgba(0,0,0,0.55)` circular play buttons (`64px`), `20px`-tall GIF badges (`rgba(0,0,0,0.6)`), and `rgba(0,0,0,0.7)` sensitive-content overlays.
- **Footer stats**: Centered row of `20px` SVG icons (replies, retweets, likes, views) spaced by `36px`.
- **Minimap POI markers**: `14px` diameter red dots (`7px` radius) with `3px` black-stroked white labels.
- **System tray icon**: Multi-size BMP ICO (`256px`, `48px`, `32px`, `16px`) recolored to `#5865f2`.

## Do's and Don'ts

- Do keep the outer canvas background transparent so rendered PNG cards adapt to both light and dark Discord themes.
- Do mask media corners with `destination-in` anti-aliased paths rather than raw canvas clipping.
- Don't introduce extra accent colors or fonts outside the system stack and canvas helpers without updating `twitter.js` or `app.js`.
