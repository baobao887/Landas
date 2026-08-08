/* ==========================================================================
   CourseCompass — course recommender (v1)

   Everything runs in the browser. No backend, no storage, no network calls
   beyond fetching the two JSON files in data/.

   Flow:  answers  ->  trait profile  ->  cosine similarity vs each course
                   ->  ranked shortlist  ->  templated explanation

   Screens: landing -> quiz -> results -> course detail.

   To change the CONTENT, edit data/questions.json and data/courses.json.
   You should not need to touch this file to add a course or a question.
   ========================================================================== */

/* --- The six RIASEC (Holland Code) dimensions -----------------------------
   `phrase` is dropped into the results explanation, so it must read naturally
   inside "your interest in ___". `blurb` is the landing-page card copy.

   Keep each `phrase` free of the word "and" — two of them get joined with
   "and" in the explanation, and nested "and"s make the sentence unreadable. */
const TRAITS = ['R', 'I', 'A', 'S', 'E', 'C'];

const TRAIT_INFO = {
  R: { name: 'Realistic',     phrase: 'practical, hands-on work',     blurb: 'Tools, machines, and the outdoors.' },
  I: { name: 'Investigative', phrase: 'digging into how things work', blurb: 'Research, analysis, solving problems.' },
  A: { name: 'Artistic',      phrase: 'creative, visual work',        blurb: 'Creating original, expressive work.' },
  S: { name: 'Social',        phrase: 'working directly with people', blurb: 'Helping, teaching, supporting people.' },
  E: { name: 'Enterprising',  phrase: 'taking the lead on things',    blurb: 'Leading, persuading, pursuing goals.' },
  C: { name: 'Conventional',  phrase: 'getting the details right',    blurb: 'Organizing, procedure, working with data.' }
};

/* Secondary layer: subject affinity tags. Purely supporting — they nudge the
   score slightly and add a second line to the explanation. RIASEC stays primary. */
const SUBJECT_LABELS = {
  math: 'math', biology: 'biology', science: 'science', physics: 'physics',
  writing: 'writing', art: 'visual art', tech: 'technology',
  people: 'people', business: 'business'
};

const state = {
  questions: [],
  courses: [],
  maxTraits: null, // best possible score per trait, derived from questions.json
  index: 0,        // which question we're on
  answers: [],     // answers[i] = the chosen option object, or null if skipped
  profile: null,   // last computed profile
  ranked: []       // last computed shortlist
};

/* ==========================================================================
   MATCHING ENGINE
   ========================================================================== */

/* Cosine similarity between two trait vectors: the cosine of the angle
   between them. It measures the SHAPE of the interest profile and ignores
   magnitude, so someone who answered enthusiastically and someone who
   answered mildly get the same match as long as their priorities line up. */
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (const t of TRAITS) {
    dot += a[t] * b[t];
    magA += a[t] * a[t];
    magB += b[t] * b[t];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/* The most points a student could possibly collect in each trait, i.e. the sum
   of the best available option per question. Depends only on questions.json, so
   it is computed once at load time. */
function maxAttainable(questions) {
  const max = { R: 0, I: 0, A: 0, S: 0, E: 0, C: 0 };
  for (const q of questions) {
    for (const t of TRAITS) {
      max[t] += Math.max(0, ...q.options.map(o => (o.weights || {})[t] || 0));
    }
  }
  return max;
}

/* Add every chosen option's weights into one student vector, then rescale each
   trait to 0-10 as a share of what was attainable for that trait.

   Why normalise: if the quiz happens to offer 15 chances to score Realistic but
   only 9 to score Enterprising, raw totals make everyone look Realistic. Cosine
   is scale-invariant overall but NOT per-axis, so that imbalance would quietly
   bias every result. Normalising means you can add or remove questions freely
   without having to keep the six traits evenly represented.

   Skipped questions are stored as null and contribute nothing — no weights, no
   subjects. Note that `max` stays the GLOBAL maximum either way: it is NOT
   recomputed from the questions this particular student answered. Skipping
   deflates every trait by roughly the same factor, which cosine ignores because
   it only reads the shape of the vector. A per-respondent denominator would
   instead re-inflate whichever traits happened to be answerable, changing that
   shape — the exact bias the normalisation exists to prevent. */
function buildProfile(answers, max) {
  const raw = { R: 0, I: 0, A: 0, S: 0, E: 0, C: 0 };
  const subjects = {};
  for (const opt of answers) {
    if (!opt) continue; // skipped
    for (const [trait, w] of Object.entries(opt.weights || {})) raw[trait] += w;
    for (const s of opt.subjects || []) subjects[s] = (subjects[s] || 0) + 1;
  }
  const riasec = {};
  for (const t of TRAITS) riasec[t] = max[t] ? (raw[t] / max[t]) * 10 : 0;
  return { riasec, raw, subjects };
}

/* How much of a course's subject tags the student showed interest in (0–1). */
function subjectOverlap(studentSubjects, courseSubjects = []) {
  if (!courseSubjects.length) return 0;
  const hits = courseSubjects.filter(s => studentSubjects[s] > 0).length;
  return hits / courseSubjects.length;
}

/* Score every course, then sort best-first.
   Final score = 90% RIASEC cosine + 10% subject overlap. RIASEC decides the
   ranking; subjects only break near-ties. Change the 0.9/0.1 split here. */
function rankCourses(profile, courses) {
  return courses
    .map(course => {
      const similarity = cosineSimilarity(profile.riasec, course.riasec);
      const subjects = subjectOverlap(profile.subjects, course.subjects);
      const score = 0.9 * similarity + 0.1 * subjects;
      return { course, score, matchPct: toPercent(score) };
    })
    .sort((a, b) => b.score - a.score);
}

/* Display-only rescale. Raw cosine between two all-positive vectors rarely
   drops below ~0.45, so showing it directly would make every course look like
   a 90% match. This stretches the useful band onto 0–99 for readability.
   Ranking always uses the raw score above, never this number. */
const SCORE_FLOOR = 0.45;
function toPercent(score) {
  const stretched = (score - SCORE_FLOOR) / (1 - SCORE_FLOOR);
  return Math.max(1, Math.min(99, Math.round(stretched * 100)));
}

/* Student trait scores are 0–10 internally; the UI shows them on 0–100. */
const pct100 = v => Math.round(v * 10);

/* How many questions must actually be answered (skips don't count) before a
   shortlist is worth showing. Cosine reads the SHAPE of a profile, and a
   profile built from two or three answers has no settled shape — it would still
   produce confident-looking percentages, which is worse than showing nothing.
   Below this the results screen shows a nudge back to the quiz instead. */
const MIN_ANSWERED = 8;

/* ==========================================================================
   EXPLANATIONS — a lookup, not generated text.

   Find the traits where the student scores high AND the course scores high,
   rank them by the product of the two, and fill a template.
   ========================================================================== */

const COURSE_TRAIT_FLOOR = 6;   // a course "scores high" on a trait at 6+/10
const STUDENT_TOP_N = 4;        // only the student's 4 strongest traits count
const MAX_REASON_TRAITS = 2;    // 3 also works, but two reads noticeably cleaner

function explain(profile, course, matchPct) {
  const studentTop = [...TRAITS]
    .sort((a, b) => profile.riasec[b] - profile.riasec[a])
    .slice(0, STUDENT_TOP_N);

  const shared = TRAITS
    .filter(t => studentTop.includes(t) &&
                 course.riasec[t] >= COURSE_TRAIT_FLOOR &&
                 profile.riasec[t] > 0)
    .sort((a, b) => (profile.riasec[b] * course.riasec[b]) -
                    (profile.riasec[a] * course.riasec[a]))
    .slice(0, MAX_REASON_TRAITS);

  // Grade the lead-in. Without this, a shortlist of similar courses opens every
  // row with the same sentence — true, but it reads as a rendering bug.
  const lead = matchPct >= 80 ? 'Strong match' : matchPct >= 65 ? 'Good match' : 'Partial match';

  const main = shared.length
    ? `${lead} on your interest in ${joinList(shared.map(t => TRAIT_INFO[t].phrase))}.`
    : `${lead} overall — your profile leans the same general direction, without one standout trait in common.`;

  // Where the course asks for noticeably more than the student showed. This is
  // what separates otherwise similar-looking rows, and it is the honest caveat.
  const gap = [...TRAITS].sort((a, b) =>
    (course.riasec[b] - profile.riasec[b]) - (course.riasec[a] - profile.riasec[a]))[0];
  const diff = (course.riasec[gap] - profile.riasec[gap]) >= 3
    ? ` It leans more ${TRAIT_INFO[gap].name} than your profile does.`
    : '';

  const sharedSubjects = (course.subjects || [])
    .filter(s => profile.subjects[s] > 0)
    .slice(0, 3)
    .map(s => SUBJECT_LABELS[s] || s);

  return {
    main: main + diff,
    sub: sharedSubjects.length ? `Your answers also pointed toward ${joinList(sharedSubjects)}.` : ''
  };
}

/* The longer form used on the course-detail screen: two points where you and
   the course agree, then one honest caveat (or a low-end agreement if there is
   no meaningful gap). Same lookup logic, just more of it. */
function detailReasons(profile, course) {
  const s = profile.riasec, c = course.riasec;
  const courseRank = [...TRAITS].sort((a, b) => c[b] - c[a]);
  const out = [];

  // Both vectors are 0-10 internally. Everything shown to the reader goes out
  // on the same 0-100 scale as the profile bars — mixing "6/10" and "48" in
  // one sentence reads as a contradiction even when the maths is right.
  const yours = t => pct100(s[t]);
  const its = t => pct100(c[t]);

  TRAITS
    .filter(t => s[t] >= 4 && c[t] >= COURSE_TRAIT_FLOOR)
    .sort((a, b) => s[b] * c[b] - s[a] * c[a])
    .slice(0, 2)
    .forEach(t => {
      const place = courseRank.indexOf(t);
      const where = place === 0 ? `this course's heaviest dimension (${its(t)})`
                  : place === 1 ? `its second-heaviest dimension (${its(t)})`
                  : `rated ${its(t)} here`;
      out.push({
        kind: 'match',
        text: `Your ${TRAIT_INFO[t].name} score (${yours(t)}) is among your highest, and ${TRAIT_INFO[t].name} is ${where} — ${TRAIT_INFO[t].phrase} runs through the coursework.`
      });
    });

  // Closing point: flag the biggest gap if there is one, otherwise note where
  // you and the course are both low — that agreement is part of the fit too.
  const gap = [...TRAITS].sort((a, b) => (c[b] - s[b]) - (c[a] - s[a]))[0];
  const bothLow = TRAITS.filter(t => s[t] < 3 && c[t] <= 4);

  if (c[gap] - s[gap] >= 3) {
    out.push({
      kind: 'caveat',
      text: `One gap worth knowing: this course leans on ${TRAIT_INFO[gap].name} (${its(gap)}) more than your answers did (${yours(gap)}).`
    });
  } else if (bothLow.length >= 2) {
    out.push({
      kind: 'match',
      text: `Your ${TRAIT_INFO[bothLow[0]].name} (${yours(bothLow[0])}) and ${TRAIT_INFO[bothLow[1]].name} (${yours(bothLow[1])}) scores are low, and this course carries little of either — nothing about the fit is dragged down there.`
    });
  }

  return out.slice(0, 3);
}

/* The "I · R · A" chip: a course's three heaviest dimensions. */
function traitTag(course) {
  return [...TRAITS]
    .sort((a, b) => course.riasec[b] - course.riasec[a])
    .slice(0, 3)
    .join(' · ');
}

/* "a", "a and b", "a, b, and c" */
function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

/* ==========================================================================
   UI
   ========================================================================== */

const $ = id => document.getElementById(id);
const SCREENS = ['landing', 'quiz', 'results', 'detail'];

function showScreen(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = (s !== name);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* --- theme ------------------------------------------------------------- */

/* One switcher per screen, injected into each topbar. Keeping it in normal flow
   rather than floating it means it can never sit on top of the comparison bars
   on a narrow screen. */
function mountThemeSwitches() {
  document.querySelectorAll('.topbar').forEach(bar => {
    const seg = document.createElement('div');
    seg.className = 'theme-switch seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Visual theme');
    seg.innerHTML = `
      <button type="button" class="seg-opt" data-theme="modernist">Modernist</button>
      <button type="button" class="seg-opt" data-theme="nocturne">Nocturne</button>`;
    seg.querySelectorAll('.seg-opt').forEach(b =>
      b.addEventListener('click', () => setTheme(b.dataset.theme)));
    bar.appendChild(seg);
  });
}

function setTheme(theme) {
  document.body.className = `theme-${theme}`;
  document.querySelectorAll('.theme-switch .seg-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === theme));
  try { localStorage.setItem('cc-theme', theme); } catch (e) { /* private mode */ }
}

/* --- landing ----------------------------------------------------------- */

function renderDimensions() {
  $('dims-grid').innerHTML = TRAITS.map(t => `
    <div class="dim">
      <div class="dim-badge">${t}</div>
      <div class="dim-name">${TRAIT_INFO[t].name}</div>
      <div class="dim-desc">${TRAIT_INFO[t].blurb}</div>
    </div>`).join('');
}

/* --- quiz -------------------------------------------------------------- */

function renderQuestion() {
  const q = state.questions[state.index];

  $('q-current').textContent = state.index + 1;
  $('q-total').textContent = state.questions.length;
  $('progress-fill').style.width = `${(state.index / state.questions.length) * 100}%`;
  $('q-prompt').textContent = q.prompt;
  $('btn-back').disabled = state.index === 0;

  const box = $('q-options');
  box.innerHTML = '';
  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option';
    btn.innerHTML = `<span class="option-key" aria-hidden="true">${i + 1}</span><span>${escapeHtml(opt.label)}</span>`;
    btn.addEventListener('click', () => choose(opt));
    box.appendChild(btn);
  });

  // The escape hatch. Forced choice makes a student who recognises none of the
  // four options invent one anyway, which injects a weight they never meant.
  // Deliberately styled down: it is a valid answer, not a competing one.
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'skip';
  skip.innerHTML =
    `<span class="skip-key" aria-hidden="true">0</span><span>None of these fit / skip</span>`;
  skip.addEventListener('click', skipQuestion);
  box.appendChild(skip);
}

/* Record the response to the current question and advance. `option` is the
   chosen option object, or null for a skip. */
function choose(option) {
  state.answers[state.index] = option;
  if (state.index < state.questions.length - 1) {
    state.index++;
    renderQuestion();
  } else {
    showResults();
  }
}

/* A skip is stored as null rather than left as a hole, so the answers array
   stays aligned with the questions and Back still walks it correctly.
   buildProfile ignores nulls, so this contributes exactly zero. */
function skipQuestion() {
  choose(null);
}

function startQuiz() {
  state.index = 0;
  state.answers = [];
  renderQuestion();
  showScreen('quiz');
}

/* Number keys 1–4 pick an option while the quiz screen is up; 0 skips.
   0 is checked first, but the two can't collide anyway — parseInt('0') is 0,
   which never satisfies the n >= 1 test below. */
document.addEventListener('keydown', e => {
  if ($('screen-quiz').hidden) return;
  const q = state.questions[state.index];
  if (!q) return;
  if (e.key === '0') { skipQuestion(); return; }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= q.options.length) choose(q.options[n - 1]);
});

/* --- results ----------------------------------------------------------- */

function showResults() {
  // Not enough answered to have a shape worth ranking — see MIN_ANSWERED. Bail
  // out before scoring anything: showing a shortlist here would be misleading,
  // and so would the profile bars behind it.
  const answered = state.answers.filter(Boolean).length;
  if (answered < MIN_ANSWERED) {
    $('thin-count').textContent = `${answered} of ${state.questions.length}`;
    $('results-grid').hidden = true;
    $('results-thin').hidden = false;
    showScreen('results');
    return;
  }
  $('results-thin').hidden = true;
  $('results-grid').hidden = false;

  state.profile = buildProfile(state.answers, state.maxTraits);
  state.ranked = rankCourses(state.profile, state.courses).slice(0, 4); // top 4 = shortlist

  const list = $('results-list');
  list.innerHTML = '';

  state.ranked.forEach((r, i) => {
    const { main, sub } = explain(state.profile, r.course, r.matchPct);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'match';
    row.innerHTML = `
      <div class="match-rank">${i + 1}</div>
      <div class="match-body">
        <div class="match-title">
          <h3>${escapeHtml(r.course.name)}</h3>
          <span class="tag tag-accent">${traitTag(r.course)}</span>
        </div>
        <p class="match-reason">${escapeHtml(main)}${sub ? ' ' + escapeHtml(sub) : ''}</p>
      </div>
      <div class="match-side">
        <div class="match-pct">${r.matchPct}%</div>
        <span class="match-link">View breakdown →</span>
      </div>`;
    row.addEventListener('click', () => showDetail(i));
    list.appendChild(row);
  });

  renderProfileBars(state.profile.riasec);
  showScreen('results');
}

/* Profile bars are shown on the 0–100 scale, sorted strongest first. */
function renderProfileBars(riasec) {
  $('profile-bars').innerHTML = [...TRAITS]
    .sort((a, b) => riasec[b] - riasec[a])
    .map(t => `
      <div>
        <div class="prow-head">
          <span>${TRAIT_INFO[t].name}</span>
          <span class="prow-val">${pct100(riasec[t])}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct100(riasec[t])}%"></div></div>
      </div>`)
    .join('');
}

/* --- course detail ----------------------------------------------------- */

/* Agreements get a check; the caveat gets an alert glyph in a muted colour.
   A tick next to "one gap worth knowing" reads as an endorsement of the gap. */
const REASON_ICON = {
  match: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  caveat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.5"/></svg>'
};

function showDetail(rankIndex) {
  const r = state.ranked[rankIndex];
  const s = state.profile.riasec;
  const c = r.course.riasec;

  const mine = [...TRAITS].sort((a, b) => s[b] - s[a]);
  const theirs = [...TRAITS].sort((a, b) => c[b] - c[a]);

  $('detail-name').textContent = r.course.name;
  $('detail-tag').textContent = traitTag(r.course);
  $('detail-pct').textContent = `${r.matchPct}% match`;

  $('detail-summary').textContent =
    `${r.course.description} Your strongest interests are ${TRAIT_INFO[mine[0]].name} ` +
    `(${pct100(s[mine[0]])}) and ${TRAIT_INFO[mine[1]].name} (${pct100(s[mine[1]])}), with ` +
    `${TRAIT_INFO[mine[2]].name} behind at ${pct100(s[mine[2]])}. This course scores highest on ` +
    `${TRAIT_INFO[theirs[0]].name} and ${TRAIT_INFO[theirs[1]].name}, which is why it ranks ` +
    `${ORDINALS[rankIndex]} among your matches.`;

  $('detail-reasons').innerHTML = detailReasons(state.profile, r.course)
    .map(({ kind, text }) =>
      `<div class="reason reason-${kind}">${REASON_ICON[kind]}<p>${escapeHtml(text)}</p></div>`)
    .join('');

  // The editor-facing note from courses.json, surfaced so the scoring stays auditable.
  $('detail-scoring-note').textContent = r.course.scoringNote || '';

  $('compare-bars').innerHTML = TRAITS.map(t => `
    <div class="crow">
      <div class="crow-label">${TRAIT_INFO[t].name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct100(s[t])}%"></div></div>
      <div class="bar-track"><div class="bar-fill" style="width:${c[t] * 10}%"></div></div>
    </div>`).join('');

  showScreen('detail');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ==========================================================================
   BOOT
   ========================================================================== */

async function init() {
  // Theme first, so a stored preference applies before anything paints.
  mountThemeSwitches();
  let stored = null;
  try { stored = localStorage.getItem('cc-theme'); } catch (e) { /* private mode */ }
  setTheme(stored === 'nocturne' ? 'nocturne' : 'modernist');

  renderDimensions();

  try {
    const [questionsFile, coursesFile] = await Promise.all([
      fetch('data/questions.json').then(r => r.json()),
      fetch('data/courses.json').then(r => r.json())
    ]);
    state.questions = questionsFile.questions;
    state.courses = coursesFile.courses;
    state.maxTraits = maxAttainable(state.questions);
    $('q-total').textContent = state.questions.length;
  } catch (err) {
    const box = $('load-error');
    box.hidden = false;
    box.textContent =
      'Could not load the quiz data. If you opened this file directly (file:///), ' +
      'browsers block reading the JSON files. Serve the folder over HTTP instead — ' +
      'e.g. "python -m http.server" — or open it through your local web server.';
    document.querySelectorAll('.js-start').forEach(b => b.disabled = true);
    return;
  }

  document.querySelectorAll('.js-start').forEach(b => b.addEventListener('click', startQuiz));
  document.querySelectorAll('.js-restart').forEach(b => b.addEventListener('click', () => showScreen('landing')));
  document.querySelectorAll('.js-back-to-matches').forEach(b => b.addEventListener('click', () => showScreen('results')));

  // From the "answer a few more" notice. Resume rather than restart, and land on
  // the first question they skipped — that's what is left to fill in.
  document.querySelectorAll('.js-resume-quiz').forEach(b => b.addEventListener('click', () => {
    const firstSkipped = state.answers.findIndex(a => !a);
    state.index = firstSkipped === -1 ? state.questions.length - 1 : firstSkipped;
    renderQuestion();
    showScreen('quiz');
  }));

  $('btn-back').addEventListener('click', () => {
    if (state.index === 0) return;
    state.index--;
    renderQuestion();
  });
}

init();
