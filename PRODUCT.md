# GFL2 Pull Tracker

## Platform

web

## Stack

SvelteKit and TypeScript with a Python FastAPI backend and SQLite. npm and uv lockfiles. Local first; the boundaries should support future public hosting.

## Users

Girls' Frontline 2 players reviewing their own recruitment history after importing game records.

## Product Purpose

Preserve accessible pull history across imports and make it understandable through item lookup, search, filters, and basic statistics.

## Operating Context

Users open a local browser app, import saved collector exports or paste a captured HTTP request, and review results. The overview and history are on the same page, with overview first and history visible without a navigation click.

## Capabilities and Constraints

- Reuse the existing Python collector with HTTPS verification, credential redaction, API-type discovery, raw response archives, and partial-import reporting.
- Preserve repeated identical pulls through occurrence-aware merging.
- Keep histories scoped to profiles; credentials stay in memory only.
- Use an independent, attributed item catalog. Unknown names, rarity, and pools stay visibly unknown.
- Provide totals, rarity and type/pool distributions, recorded dates, estimated multi-pull groups, search, combined filters, and pagination.
- Deliver an interactive impeccable mockup with synthetic records before connecting the backend. Mockups remain outside the maintained repository.
- Public login, hosting, sharing, pity, guarantees, and automatic token capture are later work.

## Evidence on Hand

Existing collector script and 21 passing tests. A private saved export contains 1,799 records, including 124 source-type-6 records. Personal records must not become test fixtures or committed assets.

## Product Principles

- A record is never silently discarded or relabeled to make the data look complete.
- Explain the extent of saved history without claiming lifetime completeness.
- Keep overview and detailed history connected through the same filters.
- Retain provenance so derived information can be checked.

## Accessibility & Inclusion

Keyboard-operable controls, visible focus, readable contrast, text rarity labels, and responsive desktop/mobile layouts. English first.
