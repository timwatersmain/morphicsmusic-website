-- Seeds the four-tier avatar ladder into avatar_catalogue. Idempotent —
-- safe to re-run; ids are stable so re-running can never re-issue or
-- orphan a fan's unlock. Plain VALUES rows rather than a compound SELECT —
-- D1 caps the number of terms in a compound SELECT very low, and this
-- seed has 60 rows.
--
-- The glyph itself is never stored here — every "recipe" row is a
-- style + colourway (+ artwork_key for tiers 3-4); the letter is derived
-- from the fan's own username at render time (glyph.ts). art_path holds a
-- documented non-file sentinel, '(procedural)', for tiers 1-2, which need
-- no artwork file at all — the render task reads style/colourway/
-- artwork_key instead of art_path for any row where `style` is set. Tiers
-- 3-4 point art_path at the existing 960px webp variant under
-- public/images/visuals/ as a size-appropriate fallback/preview source;
-- the actual duotone recolour happens at render time from the same file.
--
-- Tier 1 (glyph_solid) rows use unlock_rule {"type":"tier1_default"},
-- which never grants (see unlocks.ts) — tier 1 is available to everyone by
-- rule (the `tier` column), not by ledger row, so these must never be
-- evaluated into fan_avatar_unlocks. Tier 2 (glyph_inverted) rows use
-- {"type":"has_password"}. Tiers 3-4 use {"type":"manual"} — granted only
-- via POST /api/admin/grant-avatar.

INSERT INTO avatar_catalogue
  (id, kind, release_slug, name, art_path, unlock_rule, hint, sort_order, style, colourway, artwork_key, tier)
VALUES
  ('tier1:glyph_solid:cyan', 'special', NULL, 'Signal — Cyan', '(procedural)', '{"type":"tier1_default"}', 'Yours from day one', 2000, 'glyph_solid', 'cyan', NULL, 1),
  ('tier1:glyph_solid:mint', 'special', NULL, 'Signal — Mint', '(procedural)', '{"type":"tier1_default"}', 'Yours from day one', 2001, 'glyph_solid', 'mint', NULL, 1),
  ('tier1:glyph_solid:lavender', 'special', NULL, 'Signal — Lavender', '(procedural)', '{"type":"tier1_default"}', 'Yours from day one', 2002, 'glyph_solid', 'lavender', NULL, 1),
  ('tier1:glyph_solid:pale', 'special', NULL, 'Signal — Pale', '(procedural)', '{"type":"tier1_default"}', 'Yours from day one', 2003, 'glyph_solid', 'pale', NULL, 1),
  ('tier1:glyph_solid:green', 'special', NULL, 'Signal — Green', '(procedural)', '{"type":"tier1_default"}', 'Yours from day one', 2004, 'glyph_solid', 'green', NULL, 1),
  ('tier1:glyph_solid:teal', 'special', NULL, 'Signal — Teal', '(procedural)', '{"type":"tier1_default"}', 'Yours from day one', 2005, 'glyph_solid', 'teal', NULL, 1),
  ('tier2:glyph_inverted:cyan', 'special', NULL, 'Verified — Cyan', '(procedural)', '{"type":"has_password"}', 'Finish setting up your account', 2006, 'glyph_inverted', 'cyan', NULL, 2),
  ('tier2:glyph_inverted:mint', 'special', NULL, 'Verified — Mint', '(procedural)', '{"type":"has_password"}', 'Finish setting up your account', 2007, 'glyph_inverted', 'mint', NULL, 2),
  ('tier2:glyph_inverted:lavender', 'special', NULL, 'Verified — Lavender', '(procedural)', '{"type":"has_password"}', 'Finish setting up your account', 2008, 'glyph_inverted', 'lavender', NULL, 2),
  ('tier2:glyph_inverted:pale', 'special', NULL, 'Verified — Pale', '(procedural)', '{"type":"has_password"}', 'Finish setting up your account', 2009, 'glyph_inverted', 'pale', NULL, 2),
  ('tier2:glyph_inverted:green', 'special', NULL, 'Verified — Green', '(procedural)', '{"type":"has_password"}', 'Finish setting up your account', 2010, 'glyph_inverted', 'green', NULL, 2),
  ('tier2:glyph_inverted:teal', 'special', NULL, 'Verified — Teal', '(procedural)', '{"type":"has_password"}', 'Finish setting up your account', 2011, 'glyph_inverted', 'teal', NULL, 2),
  ('tier3:duotone:cyan:dscf3589', 'special', NULL, 'Duotone — Cyan / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2012, 'duotone', 'cyan', 'dscf3589', 3),
  ('tier3:duotone:cyan:morphics-banner', 'special', NULL, 'Duotone — Cyan / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2013, 'duotone', 'cyan', 'morphics-banner', 3),
  ('tier3:duotone:cyan:screenshot-macro', 'special', NULL, 'Duotone — Cyan / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2014, 'duotone', 'cyan', 'screenshot-macro', 3),
  ('tier3:duotone:cyan:timeline-02', 'special', NULL, 'Duotone — Cyan / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2015, 'duotone', 'cyan', 'timeline-02', 3),
  ('tier3:duotone:mint:dscf3589', 'special', NULL, 'Duotone — Mint / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2016, 'duotone', 'mint', 'dscf3589', 3),
  ('tier3:duotone:mint:morphics-banner', 'special', NULL, 'Duotone — Mint / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2017, 'duotone', 'mint', 'morphics-banner', 3),
  ('tier3:duotone:mint:screenshot-macro', 'special', NULL, 'Duotone — Mint / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2018, 'duotone', 'mint', 'screenshot-macro', 3),
  ('tier3:duotone:mint:timeline-02', 'special', NULL, 'Duotone — Mint / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2019, 'duotone', 'mint', 'timeline-02', 3),
  ('tier3:duotone:lavender:dscf3589', 'special', NULL, 'Duotone — Lavender / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2020, 'duotone', 'lavender', 'dscf3589', 3),
  ('tier3:duotone:lavender:morphics-banner', 'special', NULL, 'Duotone — Lavender / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2021, 'duotone', 'lavender', 'morphics-banner', 3),
  ('tier3:duotone:lavender:screenshot-macro', 'special', NULL, 'Duotone — Lavender / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2022, 'duotone', 'lavender', 'screenshot-macro', 3),
  ('tier3:duotone:lavender:timeline-02', 'special', NULL, 'Duotone — Lavender / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2023, 'duotone', 'lavender', 'timeline-02', 3),
  ('tier3:duotone:pale:dscf3589', 'special', NULL, 'Duotone — Pale / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2024, 'duotone', 'pale', 'dscf3589', 3),
  ('tier3:duotone:pale:morphics-banner', 'special', NULL, 'Duotone — Pale / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2025, 'duotone', 'pale', 'morphics-banner', 3),
  ('tier3:duotone:pale:screenshot-macro', 'special', NULL, 'Duotone — Pale / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2026, 'duotone', 'pale', 'screenshot-macro', 3),
  ('tier3:duotone:pale:timeline-02', 'special', NULL, 'Duotone — Pale / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2027, 'duotone', 'pale', 'timeline-02', 3),
  ('tier3:duotone:green:dscf3589', 'special', NULL, 'Duotone — Green / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2028, 'duotone', 'green', 'dscf3589', 3),
  ('tier3:duotone:green:morphics-banner', 'special', NULL, 'Duotone — Green / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2029, 'duotone', 'green', 'morphics-banner', 3),
  ('tier3:duotone:green:screenshot-macro', 'special', NULL, 'Duotone — Green / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2030, 'duotone', 'green', 'screenshot-macro', 3),
  ('tier3:duotone:green:timeline-02', 'special', NULL, 'Duotone — Green / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2031, 'duotone', 'green', 'timeline-02', 3),
  ('tier3:duotone:teal:dscf3589', 'special', NULL, 'Duotone — Teal / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2032, 'duotone', 'teal', 'dscf3589', 3),
  ('tier3:duotone:teal:morphics-banner', 'special', NULL, 'Duotone — Teal / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2033, 'duotone', 'teal', 'morphics-banner', 3),
  ('tier3:duotone:teal:screenshot-macro', 'special', NULL, 'Duotone — Teal / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2034, 'duotone', 'teal', 'screenshot-macro', 3),
  ('tier3:duotone:teal:timeline-02', 'special', NULL, 'Duotone — Teal / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'A gift, for the loyal', 2035, 'duotone', 'teal', 'timeline-02', 3),
  ('tier4:glyph_overlay:cyan:dscf3589', 'special', NULL, 'Overlay — Cyan / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2036, 'glyph_overlay', 'cyan', 'dscf3589', 4),
  ('tier4:glyph_overlay:cyan:morphics-banner', 'special', NULL, 'Overlay — Cyan / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2037, 'glyph_overlay', 'cyan', 'morphics-banner', 4),
  ('tier4:glyph_overlay:cyan:screenshot-macro', 'special', NULL, 'Overlay — Cyan / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2038, 'glyph_overlay', 'cyan', 'screenshot-macro', 4),
  ('tier4:glyph_overlay:cyan:timeline-02', 'special', NULL, 'Overlay — Cyan / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2039, 'glyph_overlay', 'cyan', 'timeline-02', 4),
  ('tier4:glyph_overlay:mint:dscf3589', 'special', NULL, 'Overlay — Mint / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2040, 'glyph_overlay', 'mint', 'dscf3589', 4),
  ('tier4:glyph_overlay:mint:morphics-banner', 'special', NULL, 'Overlay — Mint / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2041, 'glyph_overlay', 'mint', 'morphics-banner', 4),
  ('tier4:glyph_overlay:mint:screenshot-macro', 'special', NULL, 'Overlay — Mint / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2042, 'glyph_overlay', 'mint', 'screenshot-macro', 4),
  ('tier4:glyph_overlay:mint:timeline-02', 'special', NULL, 'Overlay — Mint / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2043, 'glyph_overlay', 'mint', 'timeline-02', 4),
  ('tier4:glyph_overlay:lavender:dscf3589', 'special', NULL, 'Overlay — Lavender / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2044, 'glyph_overlay', 'lavender', 'dscf3589', 4),
  ('tier4:glyph_overlay:lavender:morphics-banner', 'special', NULL, 'Overlay — Lavender / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2045, 'glyph_overlay', 'lavender', 'morphics-banner', 4),
  ('tier4:glyph_overlay:lavender:screenshot-macro', 'special', NULL, 'Overlay — Lavender / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2046, 'glyph_overlay', 'lavender', 'screenshot-macro', 4),
  ('tier4:glyph_overlay:lavender:timeline-02', 'special', NULL, 'Overlay — Lavender / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2047, 'glyph_overlay', 'lavender', 'timeline-02', 4),
  ('tier4:glyph_overlay:pale:dscf3589', 'special', NULL, 'Overlay — Pale / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2048, 'glyph_overlay', 'pale', 'dscf3589', 4),
  ('tier4:glyph_overlay:pale:morphics-banner', 'special', NULL, 'Overlay — Pale / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2049, 'glyph_overlay', 'pale', 'morphics-banner', 4),
  ('tier4:glyph_overlay:pale:screenshot-macro', 'special', NULL, 'Overlay — Pale / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2050, 'glyph_overlay', 'pale', 'screenshot-macro', 4),
  ('tier4:glyph_overlay:pale:timeline-02', 'special', NULL, 'Overlay — Pale / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2051, 'glyph_overlay', 'pale', 'timeline-02', 4),
  ('tier4:glyph_overlay:green:dscf3589', 'special', NULL, 'Overlay — Green / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2052, 'glyph_overlay', 'green', 'dscf3589', 4),
  ('tier4:glyph_overlay:green:morphics-banner', 'special', NULL, 'Overlay — Green / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2053, 'glyph_overlay', 'green', 'morphics-banner', 4),
  ('tier4:glyph_overlay:green:screenshot-macro', 'special', NULL, 'Overlay — Green / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2054, 'glyph_overlay', 'green', 'screenshot-macro', 4),
  ('tier4:glyph_overlay:green:timeline-02', 'special', NULL, 'Overlay — Green / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2055, 'glyph_overlay', 'green', 'timeline-02', 4),
  ('tier4:glyph_overlay:teal:dscf3589', 'special', NULL, 'Overlay — Teal / DSCF3589', '/images/visuals/dscf3589-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2056, 'glyph_overlay', 'teal', 'dscf3589', 4),
  ('tier4:glyph_overlay:teal:morphics-banner', 'special', NULL, 'Overlay — Teal / Banner', '/images/visuals/morphics-banner-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2057, 'glyph_overlay', 'teal', 'morphics-banner', 4),
  ('tier4:glyph_overlay:teal:screenshot-macro', 'special', NULL, 'Overlay — Teal / Macro', '/images/visuals/screenshot-macro-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2058, 'glyph_overlay', 'teal', 'screenshot-macro', 4),
  ('tier4:glyph_overlay:teal:timeline-02', 'special', NULL, 'Overlay — Teal / Timeline', '/images/visuals/timeline-02-960.webp', '{"type":"manual"}', 'Reserved for the top of the board', 2059, 'glyph_overlay', 'teal', 'timeline-02', 4)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name, art_path = excluded.art_path,
  unlock_rule = excluded.unlock_rule, hint = excluded.hint,
  sort_order = excluded.sort_order, style = excluded.style,
  colourway = excluded.colourway, artwork_key = excluded.artwork_key,
  tier = excluded.tier;
