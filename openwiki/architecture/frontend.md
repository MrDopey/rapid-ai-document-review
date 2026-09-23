---
type: Reference
title: Frontend UI and Component Layout
description: Overview of the Vue 3 frontend application, the three-column layout, canvas rendering, branching conversation boxes, and HUD navigation.
tags: [frontend, vue3, ui, layout, hud, canvas]
---

# Frontend UI & Component Layout

The Vue 3 frontend delivers a single-user rapid review experience organized around a document canvas and branching AI chat sessions.

## Layout Structure

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "#ffffff", "primaryBackground": "#ffffff"}}}%%
graph TD
    Toolbar[Top HUD Toolbar] --> Nav[Conversation Quick-List]
    Layout[3-Column Screen] --> Preview[Preview Column]
    Layout --> Canvas[Document Canvas Column]
    Layout --> History[History Panel Column]
    Canvas --> Doc[Floating Document Page]
    Canvas --> MainChat[Main Conversation Box at Top]
    Canvas --> InlineChat[Inline Branch Conversation at Passage Anchor]
```

## Key UI Components

- **Preview Column**: Renders live Markdown/rendered preview alongside the editing canvas.
- **Canvas Column**: Contains the floating document page that pans with native browser scrolling.
- **Branching Chat Boxes**:
  - Main conversation anchors at the top of the document.
  - Highlighted-passage conversations anchor vertically at their respective line positions.
  - Nesting/branching indents columns left-to-right to display the conversation tree clearly.
- **HUD & Toolbar**: Located in the top row, displaying the document title, shortcuts, help, and an interactive list of all active conversations ordered by vertical position. Clicking any conversation jumps the canvas directly to its anchor.
