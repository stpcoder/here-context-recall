# Product visual QA

`qa/screenshots/` contains visual QA evidence for the launch site. The landing
page now uses the deterministic React demo workspace as its primary product
evidence. The settings screens are rendered from the real Electron renderer
with development-only fixture data, so no personal window title or document is
exposed.

| Surface | Native layout | Published asset |
| --- | --- | --- |
| Recall | 860 × 540 | `site/public/images/here-recall.png` (2×) |
| Settings / Work AI | 600 × 820 | `site/public/images/here-settings.png` (2×) |
| Privacy settings | 600 × 820 | `site/public/images/here-settings-privacy.png` (2×) |
| Floating bubble | 242 × 58 | `site/public/images/here-bubble@2x.png` (2×) |

The published landing-page demo assets are copied from the verified 1440 × 900
POC capture without cropping:

- `site/public/media/here-demo.mp4`
- `site/public/images/demo-teams-request.png`
- `site/public/images/demo-outlook-interruption.png`
- `site/public/images/demo-here-handoff.png`
- `site/public/images/demo-work-resumed.png`

The product page was checked at 1440 × 1000 and 390 × 844. The manual was
checked at the same breakpoints, including every red focus box and callout.

## SK AI hackathon demo video

`qa/video/here-sk-ai-hackathon-demo.mp4` is a 78.32-second product-experience
POC recorded at 1440 × 900 and 25 fps. It uses safe synthetic data and real
Playwright clicks through this complete React interaction:

1. A concise Here title card introduces the interrupted-work problem.
2. A June payroll-closing request arrives in Teams and the user types and sends a reply.
3. The user opens the attached workbook and is interrupted by an Outlook meeting alert.
4. The user returns to Excel and clicks `왜 이 창을 열었지?`.
5. Here briefly shows `하던 일을 찾고 있습니다` before revealing the observed Teams → Excel → Outlook → Excel sequence.
6. The user returns to the review location in Excel and reaches the final Here title card.

Run `npm run dev:renderer -- --port 4173 --strictPort`, then run
`npm run demo:capture` to execute both the fast assertion flow and the paced
recording. `qa/video/captions.ass` contains the Pretendard captions.

The video demonstrates the intended product interaction with an implemented
POC workspace. The packaged desktop application remains the source of truth
for Windows foreground-window capture, local retention, and model endpoint
behavior.

Visual evidence:

- `qa/screenshots/demo-contact-sheet.png`
- `qa/screenshots/demo-04-loading.png`
- `qa/screenshots/demo-04-here.png`
- `qa/screenshots/demo-05-success.png`
- `qa/screenshots/demo-06-outro.png`

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
