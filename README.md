# CourseCompass (Landas)

A web app that recommends college courses to students based on a short interest quiz,
with a clear explanation of why each course fits.

Everything runs in the browser. No backend, no database, no login, no build step —
just static files you can drop on GitHub Pages.

The UI implements the **CourseCompass Mockups** design file from Claude Design
(project `0bbe11a1-be75-4cf4-9c46-7457be70473d`), which ships two complete themes.
Both are built; a switcher in the header toggles between them.

---

## Running it

The app loads its content with `fetch()`, and browsers block that on `file://` URLs.
So don't double-click `index.html` — serve the folder over HTTP:

```bash
python -m http.server 8000     # then open http://localhost:8000
```

Any static server works. Since this repo lives in `htdocs`, XAMPP will also serve it at
`http://localhost/Landas/`.

**Deploying to GitHub Pages:** push the repo, then Settings → Pages → deploy from branch
(`main`, root). There's nothing to build.

---

## Files

| File | What it is |
|---|---|
| `index.html` | The four screens: landing, quiz, results, course detail |
| `styles.css` | Design system — both themes, then component rules written against tokens |
| `app.js` | Matching engine + UI. The only logic file |
| `data/questions.json` | The 15 quiz questions and their trait weights |
| `data/courses.json` | The 12 courses and their trait profiles |

---

## The design system

Two themes ship side by side, ported from the design file:

|  | Modernist | Nocturne |
|---|---|---|
| Background / text | `#f3f2f2` / `#201e1d` | `#161826` / `#e9e9ed` |
| Accent | `#ec3013` | `#9184d9` |
| Type | Archivo 800 | Inter 500 |
| Radius | `0` | `4 / 8 / 14px` |
| Spacing step | `4→32px` | `2.8→22.4px` (tighter) |
| Structure | hard 2px rules, no card fills | surface-filled cards, soft shadows |
| Primary button | filled | outlined |

Everything below the `THEMES` block in `styles.css` is written against tokens only, so
**adding a third theme means adding one more `.theme-*` block** — no component rules need
to change. The handful of places where the two themes differ *structurally* rather than
chromatically (cards vs. rules, filled vs. outlined buttons, grid vs. wrapped cards) are
marked `THEME-STRUCTURAL` in the stylesheet.

The selected theme is remembered in `localStorage` under `cc-theme`. Quiz answers are
never stored.

### Where this build departs from the mockup

- **The quiz is forced-choice, not a 1–5 Likert scale.** The mockup shows a five-point
  "Strongly dislike → Strongly like" segmented control across 60 questions. This build
  keeps the 15 forced-choice questions instead, styled in each theme's own component
  vocabulary. Self-rating scales were ruled out for this project deliberately.
- **Out-of-scope actions are omitted** rather than shipped as dead buttons: "Save to
  shortlist", "Compare with another course", and the "Browse courses" nav item.
- **Copy uses real numbers** — 15 questions and about 3 minutes, not the mockup's
  placeholder 60 and 8.
- **Quiz headings are capped smaller** than the mockup's 42px. The mockup's sample
  question is one short line; real prompts here run two to four.
- **The page is capped at 1440px**, the width the design file is authored at.

---

## How the matching works

**Traits.** The profile uses the six RIASEC / Holland Code interest dimensions:
Realistic, Investigative, Artistic, Social, Enterprising, Conventional. Subject-affinity
tags (`math`, `biology`, `writing`, …) are a light secondary layer.

The loop is four steps, all in `app.js`:

1. **Build a profile.** Add up the trait weights of every option the student picked.
2. **Normalise per trait.** Each trait is rescaled to 0–10 as a share of the most that
   trait could have scored. See the note below — this matters.
3. **Compare.** Cosine similarity between the student vector and each course vector.
   Cosine measures the *shape* of the interest profile and ignores overall magnitude,
   so it matches priorities rather than enthusiasm.
4. **Rank and explain.** Sort descending, take the top 4, and fill in a reason template.

Final score is `0.9 × RIASEC cosine + 0.1 × subject overlap`. RIASEC decides the ranking;
subject tags only break near-ties. Change that split in `rankCourses()`.

### Why the per-trait normalisation matters

If the quiz offers 15 chances to score Realistic but only 9 to score Enterprising, raw
totals make every student look Realistic. Cosine similarity is scale-invariant overall,
but **not** per-axis, so that imbalance would quietly bias every result toward R-heavy
courses. Normalising against the maximum attainable score per trait fixes it — and means
you can add or remove questions without carefully balancing the six traits by hand.

### Why match percentages aren't raw cosine

Cosine between two all-positive vectors rarely drops below about 0.45, so showing it
directly would make every course look like a 90% match. `toPercent()` stretches the
useful band onto 0–99 purely for readability. Ranking always uses the raw score.

Expect a realistic mixed profile to top out around 75–92%. A student who answers every
question in the same direction produces an extreme spike profile and will see a lower
top score (~60%) — that's correct, not a bug: no real course is that one-dimensional.

### Explanations are a lookup, not generation

No AI, no generated text — every sentence traces back to two numbers.

- **Results screen** (`explain()`): finds traits where the student scores high **and**
  the course scores high (≥6/10), ranks them by the product of the two, and names the top
  two. The lead-in is graded by match strength — *Strong / Good / Partial* — and a closing
  clause names the dimension the course leans on hardest relative to the student. Without
  those two touches a shortlist of similar courses opens every row with an identical
  sentence, which reads as a rendering bug even though it's accurate.
- **Detail screen** (`detailReasons()`): the same lookup, longer. Two points of agreement,
  then one honest caveat — the biggest dimension where the course asks for more than the
  student showed. The caveat gets its own alert glyph, not a checkmark.

Both the profile bars and every number in the prose are on the same 0–100 scale.
Internally the vectors are 0–10; mixing the two scales in one sentence produced
"leans on Realistic (6/10) more than your answers did (7)", which reads as nonsense.

---

## Editing the content

Both JSON files have an `_readme` key at the top with the rules; the app ignores it.

**To add a course**, append an entry to `data/courses.json`:

```json
{
  "id": "bs-marine-biology",
  "name": "BS Marine Biology",
  "description": "One line on what the student would actually study.",
  "riasec": { "R": 7, "I": 9, "A": 2, "S": 4, "E": 2, "C": 5 },
  "subjects": ["biology", "science"],
  "scoringNote": "Why it's scored this way — shown on the course detail screen."
}
```

All six RIASEC keys are required, 0–10. Score the *relative shape*: what matters is which
dimensions are high compared to the others in the same course, not the absolute numbers.
The three highest become the course's `I · R · A` chip automatically.

**To add a question**, append to `data/questions.json`:

```json
{
  "id": "q16",
  "prompt": "Behavioural framing — what would you actually do?",
  "options": [
    { "label": "…", "weights": { "R": 3, "I": 1 }, "subjects": ["tech"] }
  ]
}
```

Two things worth keeping:

- **Frame it behaviourally** ("which of these would you actually spend a Saturday on"),
  not as a 1–5 self-rating.
- **Give most options a second trait at weight 1.** Real interests co-occur. Options that
  load on a single trait produce spiky profiles that match nothing well — this was
  measurably true here, and adding secondary weights lifted top matches by ~15 points.
  Common pairings: R+I, R+C, A+I, A+E, S+E, E+C, I+C.

Any `subjects` tag used in one file should exist in the other, or it does nothing.

---

## Scope

This is v1 and deliberately narrow: quiz → profile → ranked shortlist → reasons → breakdown.

Not included, by design: university recommendations, career paths, salary data,
scholarships, board-exam info, ML, or an AI chat. The data files and `rankCourses()` are
structured so those could be layered on later without rewriting the core.

The output is always a shortlist with visible reasoning — never a single verdict.
