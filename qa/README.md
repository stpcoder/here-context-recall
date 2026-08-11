# Product visual QA

`qa/screenshots/` contains visual QA evidence for the launch site. The product
screens used by the site are rendered from the real React renderer and CSS at
the Electron window sizes below, using only the development-only
`?showcase=1` data source so no personal window title or document is exposed.

| Surface | Native layout | Published asset |
| --- | --- | --- |
| Recall | 820 × 540 | `site/public/images/here-recall.png` (2×) |
| Settings / Work AI | 600 × 820 | `site/public/images/here-settings.png` (2×) |
| Privacy settings | 600 × 820 | `site/public/images/here-settings-privacy.png` (2×) |
| Floating bubble | 242 × 58 | `site/public/images/here-bubble@2x.png` (2×) |

The product page was checked at 1440 × 1000 and 390 × 844. The manual was
checked at the same breakpoints, including every red focus box and callout.

## Generated scene asset

`site/public/images/workday-interruption.jpg` was generated with the built-in
image generation tool and then compressed to a high-quality JPEG. It is only
an editorial scene break; it never substitutes for a product screenshot.

Final prompt:

> Create a premium, realistic editorial photograph for a Korean B2B product
> landing page. Show a modern Seoul office desk at dusk after an interruption:
> an empty chair, a few warm paper documents, a laptop, two monitors, and a
> subtle phone-notification glow. Compose the active desk on the right and keep
> generous dark negative space on the left for copy. Use charcoal, warm ivory,
> restrained cobalt, and one tiny orange accent. Wide 16:9. No people, readable
> screen content, logos, interface mockups, text, or watermark. Avoid purple
> gradients, neon, sci-fi imagery, and generic “AI” visual clichés.
