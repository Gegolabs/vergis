/* === Guías de Estudio — App === */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentGuide = null;
let currentGuideId = null;
let currentSection = 0;
let activeCategory = 0;
let progress = {};       // { sectionIndex: { checked, score: {correct,total}, answers } }
let allProgress = {};    // Progress for all guides (from server)
let allReports = [];     // Reports for the current student (from server)
let timerInterval = null; // Chronometer interval
let examReachedEnd = false; // Track if student has reached the last section
// H3 (#295): el nodo inyecta `window.__DAFTAR__` en el shell. El estudiante es el LOGIN, no un
// parámetro: `?s=` solo sobrevive para el admin de Daftar, y quien lo resuelve es el servidor.
const DAFTAR = window.__DAFTAR__ || {};
const BASE = DAFTAR.base || "";
const STUDENT = DAFTAR.student || null;
const IS_ADMIN = !!DAFTAR.admin;
const DEEPLINK_GUIDE = new URLSearchParams(window.location.search).get("g");
const ULTRAGO_FOCUS_URL = 'http://127.0.0.1:53131';
const ULTRAGO_FOCUS_TOKEN = 'dev-focus-token-change-me'; // Token compartido ultrago — dejar vacío para deshabilitar

// ── Bootstrap ──────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await Promise.all([loadAllProgress(), loadAllReports(), loadStudentInfo()]);
  loadGuideList();
  installImageLightbox();
  if (DEEPLINK_GUIDE) loadGuide(DEEPLINK_GUIDE);
  $("#btn-back").addEventListener("click", showSelector);
  $("#btn-check-section").addEventListener("click", () => checkCurrentSection());
  $("#btn-prev").addEventListener("click", () => navigateSection(-1));
  $("#btn-next").addEventListener("click", () => navigateSection(1));
  document.querySelectorAll("#grouping-toggle .grouping-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setGroupingMode(btn.dataset.mode);
      loadGuideList();
    });
  });
  window.addEventListener('beforeunload', () => {
    const sid = sessionStorage.getItem('ultragoFocusSid');
    if (!sid || !ULTRAGO_FOCUS_TOKEN) return;
    fetch(`${ULTRAGO_FOCUS_URL}/focus/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ultrago-Focus-Token': ULTRAGO_FOCUS_TOKEN },
      body: JSON.stringify({ session_id: sid }),
      keepalive: true,
    });
    sessionStorage.removeItem('ultragoFocusSid');
  });
});

// ── Identidad del estudiante ───────────────────────────────
async function loadStudentInfo() {
  if (!STUDENT) return;
  const info = (DAFTAR.students || {})[STUDENT];
  if (!info) return;
  if (info.grade) $("#header-subtitle").textContent = `Guías de estudio — ${info.grade}`;
  if (info.name) document.title = `Daftar · ${info.name}`;
}

// ── Confianza S·C·A (opt-in por guía: "confidence": true) ──
// Regla del proyecto: en toda medición el estudiante declara por ítem
// S = seguro · C = me costó · A = adiviné. Una correcta con A no es dominio.
// Solo aplica a secciones multiple_choice y solo si la guía trae el flag:
// sin flag, el formato de answers y el render quedan exactamente como estaban.
const CONF_LEVELS = [
  { key: "S", title: "Seguro" },
  { key: "C", title: "Me costó" },
  { key: "A", title: "Adiviné" },
];

function confidenceEnabled(section) {
  return !!(currentGuide && currentGuide.confidence &&
            (!section || section.type === "multiple_choice"));
}

// Las respuestas de multiple_choice son el índice pelado ("2") cuando no hay
// confianza, y {choice, conf} cuando sí. Estas dos leen ambos formatos.
function answerChoice(a) {
  if (a && typeof a === "object" && !Array.isArray(a)) return a.choice ?? null;
  return a;
}

function answerConf(a) {
  if (a && typeof a === "object" && !Array.isArray(a)) return a.conf || null;
  return null;
}

// ¿Falta responder este ítem? Con el flag de confianza activo, un ítem
// contestado pero sin S/C/A también cuenta como pendiente (requireConf).
function isChoiceEmpty(section, type, answer, requireConf = true) {
  const choice = answerChoice(answer);
  if (choice == null || choice === "") return true;
  if (requireConf && type === "multiple_choice" && confidenceEnabled(section) && !answerConf(answer)) return true;
  return false;
}

function newConfTally() {
  return { S: [0, 0], C: [0, 0], A: [0, 0] };  // letra → [correctas, erradas]
}

// Marca el ítem con su letra de confianza y la suma al conteo de la sección.
function tallyConfidence(section, exDiv, isCorrect, tally) {
  if (!confidenceEnabled(section)) return;
  const conf = exDiv.dataset.conf;
  if (!conf || !tally[conf]) return;
  tally[conf][isCorrect ? 0 : 1]++;
  const row = exDiv.querySelector(".conf-row");
  if (row && !row.querySelector(".conf-verdict")) {
    const v = document.createElement("span");
    v.className = "conf-verdict " + (isCorrect ? "ok" : "bad");
    v.textContent = isCorrect ? `Correcta con ${conf}` : `Errada con ${conf}`;
    row.appendChild(v);
  }
}

// Resumen de la sección: correctas por letra y —lo que importa— errores con S.
function appendConfSummary(section, sectionDiv, tally) {
  if (!confidenceEnabled(section)) return;
  const total = CONF_LEVELS.reduce((n, { key }) => n + tally[key][0] + tally[key][1], 0);
  if (total === 0) return;
  const box = document.createElement("div");
  box.className = "conf-summary";
  const parts = CONF_LEVELS.map(({ key, title }) =>
    `<span class="conf-summary-item" title="${title}"><b>${key}</b> ${tally[key][0]} correctas</span>`
  ).join("");
  const dangerous = tally.S[1];
  box.innerHTML =
    `<div class="conf-summary-title">Confianza declarada</div>` +
    `<div class="conf-summary-row">${parts}</div>` +
    `<div class="conf-summary-danger${dangerous > 0 ? " alert" : ""}">Errores con S (los peligrosos): ${dangerous}</div>`;
  sectionDiv.appendChild(box);
}

function buildConfidenceRow(exDiv) {
  const row = document.createElement("div");
  row.className = "conf-row";
  const label = document.createElement("span");
  label.className = "conf-label";
  label.textContent = "¿Qué tan seguro estás?";
  row.appendChild(label);
  CONF_LEVELS.forEach(({ key, title }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "conf-btn";
    btn.dataset.conf = key;
    btn.title = title;
    btn.textContent = key;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      row.querySelectorAll(".conf-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      exDiv.dataset.conf = key;
      exDiv.classList.remove("missing-conf");
    });
    row.appendChild(btn);
  });
  return row;
}

// ── Lightbox de imágenes ───────────────────────────────────
// En móvil (390 px) el recorte de una pregunta del preu se ve a ~9 px de
// texto. Tocar la imagen la abre a pantalla completa, con scroll y pinch
// libres. Se cierra tocando el overlay o con Escape.
function installImageLightbox() {
  const overlay = document.createElement("div");
  overlay.id = "img-lightbox";
  overlay.className = "hidden";
  overlay.innerHTML = '<img alt="Imagen ampliada">';
  document.body.appendChild(overlay);

  const close = () => overlay.classList.add("hidden");
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.addEventListener("click", (e) => {
    const img = e.target.closest ? e.target.closest(".exercise img") : null;
    if (!img) return;
    overlay.querySelector("img").src = img.currentSrc || img.src;
    overlay.classList.remove("hidden");
    overlay.scrollTop = 0;
  });
}

// ── Focus Mode (ultrago) ───────────────────────────────────
async function startExamFocus(activityId) {
  if (!ULTRAGO_FOCUS_TOKEN) return;
  // Idempotente 1: si ya tenemos una sid en sessionStorage (misma pestaña), no relanzar.
  if (sessionStorage.getItem('ultragoFocusSid')) return;
  // Idempotente 2: si la sonda ya tiene sesión activa (caso WebView2 fresco
  // donde sessionStorage está vacío pero la sonda recordó la sesión), no
  // relanzar — solo adoptar la sid existente. Sin esto: WebView2 carga la
  // guía → startExamFocus → POST /focus/start → sonda recicla WebView2 →
  // nuevo WebView2 → loop infinito.
  try {
    const sres = await fetch(`${ULTRAGO_FOCUS_URL}/focus/status`, {
      headers: { 'X-Ultrago-Focus-Token': ULTRAGO_FOCUS_TOKEN },
    });
    if (sres.ok) {
      const s = await sres.json();
      if (s.active) {
        if (s.session_id) sessionStorage.setItem('ultragoFocusSid', s.session_id);
        return;
      }
    }
  } catch (_) { /* sonda no responde — seguir con start normal */ }
  const examUrl = `${window.location.origin}${BASE}/?g=${currentGuideId}`;
  try {
    const resp = await fetch(`${ULTRAGO_FOCUS_URL}/focus/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ultrago-Focus-Token': ULTRAGO_FOCUS_TOKEN },
      body: JSON.stringify({
        mode: 'managed',
        app: 'daftar',
        activity: activityId,
        url: examUrl,
        navigation_allowlist: [window.location.hostname],
        timeout_secs: 3600,
      }),
    });
    if (!resp.ok) { console.warn('Focus mode unavailable:', resp.status, await resp.text()); return; }
    const { session_id } = await resp.json();
    sessionStorage.setItem('ultragoFocusSid', session_id);
    // El watcher recarga la página cuando la sonda termina la sesión —
    // pensado para que evals tipo exam muestren el resumen post-WebView2.
    // Para guías con auto-focus (mode=practice + focus:true) NO se instala,
    // porque genera loop infinito: cierro WebView2 → reload → focus auto → loop.
    if (currentGuide && currentGuide.mode === 'exam') {
      watchFocusForReload();
    }
  } catch (e) {
    console.warn('Sonda no responde:', e);
  }
}

// Browser-side watcher: when the probe reports the focus session ended
// (e.g. the student finished inside the WebView2), reload this page so it
// stops showing the pre-exam cover frozen from when focus was started.
function watchFocusForReload() {
  if (window._ultragoFocusWatcher) return;
  window._ultragoFocusWatcher = setInterval(async () => {
    try {
      const r = await fetch(`${ULTRAGO_FOCUS_URL}/focus/status`, {
        headers: { 'X-Ultrago-Focus-Token': ULTRAGO_FOCUS_TOKEN },
      });
      if (!r.ok) return;
      const s = await r.json();
      if (!s.active) {
        clearInterval(window._ultragoFocusWatcher);
        window._ultragoFocusWatcher = null;
        sessionStorage.removeItem('ultragoFocusSid');
        location.reload();
      }
    } catch (_) { /* probe momentarily unreachable; keep polling */ }
  }, 3000);
}

async function stopExamFocus() {
  // Devuelve true si la sonda confirmó el cierre (o no había sesión activa),
  // false si hubo un error y queda foco potencialmente colgado.
  let sid = sessionStorage.getItem('ultragoFocusSid');
  // sessionStorage is per-tab; when this code runs inside the probe's WebView2
  // the start happened in a different browser context, so the sid is missing.
  // The probe itself is the source of truth — ask it for the active session.
  if (!sid && ULTRAGO_FOCUS_TOKEN) {
    try {
      const r = await fetch(`${ULTRAGO_FOCUS_URL}/focus/status`, {
        headers: { 'X-Ultrago-Focus-Token': ULTRAGO_FOCUS_TOKEN },
      });
      if (r.ok) {
        const status = await r.json();
        if (status.active && status.session_id) sid = status.session_id;
      }
    } catch (e) {
      console.warn('stopExamFocus status lookup failed:', e);
      return false;
    }
  }
  if (!sid) return true;  // no había sesión que cerrar
  try {
    const resp = await fetch(`${ULTRAGO_FOCUS_URL}/focus/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ultrago-Focus-Token': ULTRAGO_FOCUS_TOKEN },
      body: JSON.stringify({ session_id: sid }),
    });
    sessionStorage.removeItem('ultragoFocusSid');
    if (resp.ok || resp.status === 404) return true;
    console.warn('stopExamFocus:', resp.status);
    return false;
  } catch (e) {
    console.warn('stopExamFocus error:', e);
    return false;
  }
}

// ── Progress Persistence ───────────────────────────────────
async function loadAllProgress() {
  try {
    const res = await fetch(`${BASE}/api/progress`);
    allProgress = await res.json();
  } catch { allProgress = {}; }
}

async function loadAllReports() {
  try {
    const url = IS_ADMIN && STUDENT ? `${BASE}/api/reports?s=${STUDENT}` : `${BASE}/api/reports`;
    const res = await fetch(url);
    allReports = await res.json();
  } catch { allReports = []; }
}

async function loadProgress(guideId) {
  try {
    const res = await fetch(`${BASE}/api/progress/${guideId}`);
    const data = await res.json();
    progress = data.sections || {};
    // Store timing at special keys (not numeric, won't conflict with sections)
    progress._startedAt = data._startedAt || null;
    progress._finishedAt = data._finishedAt || null;
    currentSection = data.currentSection || 0;
  } catch {
    progress = {};
    currentSection = 0;
  }
}

function maybeStartTimer() {
  if (progress._startedAt) return;
  progress._startedAt = new Date().toISOString();
  startTimer();
  saveProgress();
}

async function saveProgress() {
  // Snapshot currentGuideId at entry. If currentGuideId changes during the
  // await fetch (e.g. user navigated to another guide), the URL would otherwise
  // point to the wrong file → data of guide A would be POSTed to file B.
  // Snapshotting also requires server-side validation (guideId in body must
  // match URL) for full protection.
  const guideIdAtEntry = currentGuideId;
  const totalSections = currentGuide.sections.length;
  // Separate timing data from section data
  const { _startedAt, _finishedAt, ...sections } = progress;
  const data = {
    guideId: guideIdAtEntry,
    currentSection,
    sections,
    totalSections,
    _startedAt: _startedAt || null,
    _finishedAt: _finishedAt || null,
  };
  allProgress[guideIdAtEntry] = data;
  try {
    await fetch(`${BASE}/api/progress/${guideIdAtEntry}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch { /* silent */ }
}

// ── Home: Guide List ───────────────────────────────────────

// Columns: determined by variant
// Col 0: material para estudiar (guías oficiales del colegio + lecturas + fichas + apuntes)
// Col 1: lo que el alumno resuelve (evaluaciones, diagnósticos, prácticas, refuerzos)
// Col 2: retroalimentación recibida (reportes — no son guías, vienen de /api/reports)
const COLUMN_LABELS = ["Guías y Lecturas", "Evaluaciones", "Reportes"];

function variantColumn(g) {
  const v = g.variant;
  if (v === "Guía" || v === "Lectura" || v === "Ficha de repaso" || v === "Apunte") return 0;
  // Reportes no caen aquí — se inyectan en col 2 por separate flow
  return 1; // Evaluación, Diagnóstico, Práctica, Refuerzo, etc.
}

const MAX_REVIEW_ATTEMPTS = 3;

function subjectTagClass(subject) {
  if (subject === "Matemática") return "matematica";
  if (subject === "Biología") return "biologia";
  if (subject === "Historia") return "historia";
  if (subject === "English") return "english";
  if (subject === "Física") return "fisica";
  if (subject === "Química") return "quimica";
  if (subject === "Artes Visuales") return "artes";
  return "lengua";
}

// ── Grouping mode (sprint | subject) ──────────────────────
const GROUPING_KEY = "daftar.groupingMode";
function getGroupingMode() {
  const saved = localStorage.getItem(GROUPING_KEY);
  return saved === "subject" ? "subject" : "sprint";
}
function setGroupingMode(mode) {
  localStorage.setItem(GROUPING_KEY, mode);
}

const SPRINT_NONE_LABEL = "Sin sprint";
function sectionKeyForGroup(g, mode) {
  if (mode === "sprint") return g.sprint || SPRINT_NONE_LABEL;
  return g.subject || "—";
}
function sectionTagClass(label, mode) {
  if (mode === "sprint") return label === SPRINT_NONE_LABEL ? "sprint-none" : "sprint";
  return subjectTagClass(label);
}

function groupSummary(group) {
  const all = group.columns.flat();
  const total = all.length;
  const newCount = all.filter(g => g.new && !g.invalidated).length;
  const parts = [`${total} guía${total !== 1 ? "s" : ""}`];
  if (newCount > 0) parts.push(`${newCount} nueva${newCount !== 1 ? "s" : ""}`);
  return parts.join(" · ");
}

function renderGroupColumns(group, mode) {
  return group.columns.map((col, ci) => {
    const label = COLUMN_LABELS[ci];
    const itemsHTML = col.length === 0
      ? '<div class="col-empty">—</div>'
      : col.map((g) => {
          // Reports are rendered distinctly: no progress chip, no reset, label is the report's title/summary.
          if (g._isReport) {
            const orderTag = (mode === "sprint" && g.sprintOrder)
              ? `<span class="item-order">${g.sprintOrder}</span>`
              : "";
            const summary = g.summary ? `<span class="item-report-summary">${g.summary}</span>` : "";
            return `
              <div class="col-item">
                <button class="col-item-btn col-item-report" data-report-id="${g.id}">
                  ${orderTag}<span class="item-subname">Reporte</span>${summary}
                </button>
              </div>`;
          }
          const hasBadge = g.new;
          const rawChip = progressChip(g);
          const chip = (hasBadge && rawChip.includes("not-started")) ? "" : rawChip;
          const codeTag = g.code ? `<span class="item-code">${g.code}</span>` : "";
          const orderTag = (mode === "sprint" && g.sprintOrder)
            ? `<span class="item-order">${g.sprintOrder}</span>`
            : "";
          const displayName = col.length === 1 ? "" : `<span class="item-subname">${g.variant}</span>`;
          const hasReviews = guideHasReviews(g.id);
          const dest = hasReviews ? `${BASE}/report/${g.id}` : null;
          const hasProgress = !!(allProgress[g.id] && (allProgress[g.id]._startedAt || allProgress[g.id]._finishedAt));
          const resetBtn = hasProgress ? `<button class="col-item-reset" data-reset="${g.id}" title="Resetear progreso">↺</button>` : '';
          return `
            <div class="col-item">
              <button class="col-item-btn${g.invalidated ? ' is-invalidated' : g.new ? (allProgress[g.id] && allProgress[g.id]._finishedAt ? ' is-finished' : allProgress[g.id] && allProgress[g.id]._startedAt ? ' is-started' : ' is-new') : ''}" data-guide="${g.id}" ${dest ? `data-report="${dest}"` : ""} ${g.invalidated ? 'disabled' : ''}>
                ${orderTag}${codeTag}${displayName}${chip}
              </button>${resetBtn}
            </div>`;
        }).join("");
    return `
      <div class="guide-col">
        <div class="col-label">${label}</div>
        <div class="col-items">${itemsHTML}</div>
      </div>`;
  }).join("");
}

async function loadGuideList() {
  const url = IS_ADMIN && STUDENT ? `${BASE}/api/guides?s=${STUDENT}` : `${BASE}/api/guides`;
  const res = await fetch(url);
  const guides = await res.json();
  const mode = getGroupingMode();

  // Update toolbar toggle active state
  document.querySelectorAll("#grouping-toggle .grouping-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });

  // Group guides by the "group" field (inner grouping, same in both modes)
  const groups = {};
  const groupOrder = [];
  guides.forEach((g) => {
    const key = g.group || g.id;
    if (!groups[key]) {
      groups[key] = {
        subject: g.subject,
        sprint: g.sprint || "",
        subtitle: g.subtitle,
        columns: [[], [], []],
        maxGuideId: g.id,
      };
      groupOrder.push(key);
    } else if (g.id > groups[key].maxGuideId) {
      groups[key].maxGuideId = g.id;
    }
    groups[key].columns[variantColumn(g)].push(g);
  });

  // Merge reports into column 2. A report's group is its explicit `group` field,
  // or inferred from the group of its first `related_guides` entry.
  allReports.forEach((r) => {
    let key = r.group;
    if (!key && Array.isArray(r.related_guides) && r.related_guides.length > 0) {
      const guideMatch = guides.find((g) => g.id === r.related_guides[0]);
      if (guideMatch) key = guideMatch.group;
    }
    if (!key) {
      // Reports without a group: create their own group from the report id
      key = `report-${r.id}`;
    }
    if (!groups[key]) {
      groups[key] = {
        subject: r.subject || "",
        sprint: r.sprint || "",
        subtitle: r.subtitle || r.title || "",
        columns: [[], [], []],
        maxGuideId: r.id,
      };
      groupOrder.push(key);
    }
    // Marca el report con _isReport para distinguirlo en el render
    groups[key].columns[2].push({ ...r, _isReport: true });
  });

  // Outer grouping by sprint or subject, preserving insertion order
  const sections = {};
  const sectionOrder = [];
  const sectionMaxId = {};
  groupOrder.forEach((key) => {
    const sectionKey = sectionKeyForGroup(groups[key], mode);
    if (!sections[sectionKey]) {
      sections[sectionKey] = [];
      sectionOrder.push(sectionKey);
      sectionMaxId[sectionKey] = groups[key].maxGuideId;
    } else if (groups[key].maxGuideId > sectionMaxId[sectionKey]) {
      sectionMaxId[sectionKey] = groups[key].maxGuideId;
    }
    sections[sectionKey].push({ key, ...groups[key] });
  });

  // For sprint mode: most recent sprint first, "Sin sprint" always last
  if (mode === "sprint") {
    sectionOrder.sort((a, b) => {
      if (a === SPRINT_NONE_LABEL) return 1;
      if (b === SPRINT_NONE_LABEL) return -1;
      return (sectionMaxId[b] || "").localeCompare(sectionMaxId[a] || "");
    });
    // Within each sprint section, sort groups by min sprintOrder of their guides ascending.
    // Groups without any sprintOrder go at the end.
    Object.keys(sections).forEach((sectionLabel) => {
      sections[sectionLabel].sort((a, b) => {
        const minOrder = (g) => {
          const orders = g.columns.flat().map(x => x.sprintOrder).filter(o => typeof o === "number");
          return orders.length ? Math.min(...orders) : Infinity;
        };
        return minOrder(a) - minOrder(b);
      });
    });
  }

  const container = $("#guide-list");
  container.innerHTML = "";

  sectionOrder.forEach((sectionLabel, sectionIdx) => {
    const section = document.createElement("div");
    section.className = "subject-section";
    const tagClass = sectionTagClass(sectionLabel, mode);
    const subjectGroups = sections[sectionLabel];
    const isCurrentSprint = mode === "sprint" && sectionIdx === 0 && sectionLabel !== SPRINT_NONE_LABEL;
    const totalGuides = subjectGroups.reduce((sum, g) => sum + g.columns.flat().length, 0);
    const newGuides = subjectGroups.reduce((sum, g) => sum + g.columns.flat().filter(x => x.new && !x.invalidated).length, 0);
    const subjectSummary = newGuides > 0 ? `${totalGuides} guías · ${newGuides} nueva${newGuides !== 1 ? "s" : ""}` : `${totalGuides} guías`;

    // Section header
    const header = document.createElement("div");
    header.className = "subject-header";
    header.innerHTML = `
      <span class="subject-toggle">▶</span>
      <span class="subject-tag ${tagClass}">${sectionLabel}</span>
      <span class="subject-summary">${subjectSummary}</span>
    `;
    section.appendChild(header);

    // Subject body (collapsible)
    const body = document.createElement("div");
    body.className = "subject-body collapsed";

    subjectGroups.forEach((group) => {
      const div = document.createElement("div");
      div.className = "guide-group";
      const hasNew = group.columns.flat().some(g => g.new && !g.invalidated);

      const subjectTagHTML = mode === "sprint" && group.subject
        ? `<span class="subject-tag ${subjectTagClass(group.subject)}">${group.subject}</span>`
        : "";

      div.innerHTML = `
        <div class="guide-group-header">
          <span class="group-toggle">▶</span>
          ${subjectTagHTML}
          <div class="group-title">${group.subtitle}</div>
          <span class="group-summary">${groupSummary(group)}</span>
        </div>
        <div class="guide-columns collapsed">${renderGroupColumns(group, mode)}</div>
      `;

      // Group toggle
      div.querySelector(".guide-group-header").addEventListener("click", () => {
        const cols = div.querySelector(".guide-columns");
        const toggle = div.querySelector(".group-toggle");
        cols.classList.toggle("collapsed");
        toggle.textContent = cols.classList.contains("collapsed") ? "▶" : "▼";
      });

      // Wire up buttons
      div.querySelectorAll(".col-item-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (btn.dataset.reportId) {
            loadReport(btn.dataset.reportId);
          } else if (btn.dataset.report) {
            window.open(btn.dataset.report, "_blank");
          } else {
            loadGuide(btn.dataset.guide);
          }
        });
      });

      div.querySelectorAll(".col-item-reset").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await fetch(`${BASE}/api/reset/${btn.dataset.reset}`, { method: 'POST' });
          await loadAllProgress();
          loadGuideList();
        });
      });

      // Auto-expand groups only inside the current sprint section
      if (isCurrentSprint && hasNew) {
        div.querySelector(".guide-columns").classList.remove("collapsed");
        div.querySelector(".group-toggle").textContent = "▼";
      }

      body.appendChild(div);
    });

    section.appendChild(body);

    // Subject toggle
    header.addEventListener("click", () => {
      body.classList.toggle("collapsed");
      header.querySelector(".subject-toggle").textContent = body.classList.contains("collapsed") ? "▶" : "▼";
    });

    // Auto-expand only the current sprint (top section in sprint mode)
    if (isCurrentSprint) {
      body.classList.remove("collapsed");
      header.querySelector(".subject-toggle").textContent = "▼";
    }

    container.appendChild(section);
  });
}

function isPreuGuide(guide) {
  return /preu/i.test(guide.institution || "") || /preu/i.test(guide.sprint || "");
}

function progressChip(guide) {
  const p = allProgress[guide.id];
  if (!p || !p.sections) return '<span class="progress-chip not-started">Sin empezar</span>';
  // Filter only numeric section keys (skip _startedAt, _finishedAt, etc.)
  const sectionEntries = Object.entries(p.sections).filter(([k]) => /^\d+$/.test(k)).map(([, v]) => v);
  const checked = sectionEntries.filter((s) => s && s.checked).length;
  if (checked === 0) return '<span class="progress-chip not-started">Sin empezar</span>';
  if (checked < guide.sectionCount) return `<span class="progress-chip in-progress">${checked}/${guide.sectionCount}</span>`;

  // Completed — calculate auto + review scores
  let autoCorrect = 0, autoTotal = 0;
  let reviewCorrect = 0, reviewTotal = 0;
  let hasReview = false, hasPendingReview = false;

  sectionEntries.forEach((s) => {
    if (!s) return;
    if (s.score && s.score.total > 0) {
      autoCorrect += s.score.correct;
      autoTotal += s.score.total;
    }
    if (s.review && s.review.score) {
      hasReview = true;
      const parts = s.review.score.match(/(\d+)\s*\/\s*(\d+)/);
      if (parts) { reviewCorrect += parseInt(parts[1]); reviewTotal += parseInt(parts[2]); }
    } else if (s.score && s.score.total === 0 && s.checked) {
      // free_text without review yet
      hasPendingReview = true;
    }
  });

  // Find worst form grade from reviews
  const formOrder = ["A", "B", "C", "D", "F"];
  let worstForm = "";
  sectionEntries.forEach((s) => {
    if (!s || !s.review || !s.review.form) return;
    const f = s.review.form;
    if (!worstForm || formOrder.indexOf(f) > formOrder.indexOf(worstForm)) worstForm = f;
  });

  if (autoTotal > 0 || reviewTotal > 0) {
    const totalCorrect = autoCorrect + reviewCorrect;
    const totalItems = autoTotal + reviewTotal;
    const pct = totalItems > 0 ? Math.round((totalCorrect / totalItems) * 100) : 0;
    const cls = pct >= 80 ? "completed" : pct >= 50 ? "in-progress" : "needs-work";
    // Las guías del preu no se califican con nota 1–7: la vara es la PAES,
    // así que el chip muestra correctas/total con el mismo color por porcentaje.
    const nota = isPreuGuide(guide) ? `${totalCorrect}/${totalItems}` : (pct * 7 / 100).toFixed(1);
    const pending = hasPendingReview && !hasReview ? " *" : "";

    let formChip = "";
    if (worstForm) {
      const formCls = (worstForm === "A" || worstForm === "B") ? "form-good" : worstForm === "C" ? "form-ok" : "form-bad";
      formChip = `<span class="form-chip ${formCls}">${worstForm}</span>`;
    } else if (pending) {
      formChip = `<span class="form-chip form-pending">*</span>`;
    }

    return `<span class="progress-chip ${cls}">${nota}</span>${formChip}`;
  }
  return '<span class="progress-chip completed">Completada</span>';
}

function guideHasReviews(guideId) {
  const p = allProgress[guideId];
  if (!p || !p.sections) return false;
  return Object.entries(p.sections).some(([k, v]) => /^\d+$/.test(k) && v && v.review);
}

async function loadReport(id) {
  try {
    const res = await fetch(`${BASE}/api/reports/${id}`);
    if (!res.ok) throw new Error('Report not found');
    const report = await res.json();

    // Reusa el contenedor de guías para mostrar el reporte
    $("#guide-selector").classList.add("hidden");
    $("#guide-container").classList.remove("hidden");
    $("#progress-bar-container").classList.add("hidden");
    $("#section-nav").classList.add("hidden");
    $("#score-summary").classList.add("hidden");
    $("#timer").classList.add("hidden");

    // Header del reporte (mismo formato que las guías)
    const meta = [];
    if (report.sprint) meta.push(report.sprint);
    if (report.generated_at) {
      const d = new Date(report.generated_at);
      meta.push(d.toLocaleDateString());
    }
    $("#guide-header").innerHTML = `
      <div class="guide-header-row">
        <div>
          <h2>${report.title}</h2>
          <h3>${report.subtitle || ""}</h3>
        </div>
        <div class="guide-header-actions">
          <span class="report-badge">Reporte</span>
          ${meta.length ? `<span class="report-meta">${meta.join(" · ")}</span>` : ""}
        </div>
      </div>
    `;

    // Contenido renderizado
    $("#active-section").innerHTML = `
      <div class="report-content">
        ${report.content_html || ""}
      </div>
    `;
    window.scrollTo(0, 0);
  } catch (e) {
    console.error('loadReport failed:', e);
    alert('No se pudo cargar el reporte.');
  }
}

async function loadGuideToSummary(id) {
  const res = await fetch(`${BASE}/api/guides/${id}`);
  currentGuide = await res.json();
  currentGuideId = id;
  await loadProgress(id);

  renderGuideHeader();
  $("#guide-selector").classList.add("hidden");
  $("#guide-container").classList.remove("hidden");
  $("#progress-bar-container").classList.add("hidden");
  $("#section-nav").classList.add("hidden");
  $("#active-section").innerHTML = "";
  $("#timer").classList.add("hidden");
  showFinalSummary();
  window.scrollTo(0, 0);
}

// ── Load Guide ─────────────────────────────────────────────
async function loadGuide(id) {
  const res = await fetch(`${BASE}/api/guides/${id}`);
  currentGuide = await res.json();
  currentGuideId = id;
  examReachedEnd = false;
  await loadProgress(id);

  // Clamp section index
  if (currentSection >= currentGuide.sections.length) currentSection = 0;

  // If exam already corrected, mark as reached end
  if (currentGuide.sections.some((_, i) => progress[i]?.checked)) examReachedEnd = true;

  $("#guide-selector").classList.add("hidden");
  $("#guide-container").classList.remove("hidden");
  $("#score-summary").classList.add("hidden");
  window.scrollTo(0, 0);

  // Exam not yet started → show cover page
  if (currentGuide.mode === 'exam' && !progress._startedAt) {
    renderGuideHeader();
    showExamCover();
    return;
  }

  renderGuideHeader();
  renderProgressBar();
  renderCurrentSection();
  updateNav();
  startTimer();
  $("#progress-bar-container").classList.remove("hidden");

  // Si la guía pide focus mode (campo `focus: true` independiente de mode=exam),
  // disparar el lockdown ahora. Idempotente: si la sonda ya tiene una sesión
  // activa para esta guía, no inicia otra. Stop se maneja vía showSelector.
  if (currentGuide.focus === true) {
    startExamFocus(currentGuide.code || currentGuideId);
  }
}

function showExamCover() {
  const guide = currentGuide;
  const totalQ = guide.sections.reduce((acc, s) => acc + (s.exercises?.length || 0), 0);
  const totalS = guide.sections.length;

  $("#progress-bar-container").classList.add("hidden");
  $("#section-nav").classList.add("hidden");
  $("#timer").classList.add("hidden");
  $("#active-section").innerHTML = `
    <div class="exam-cover">
      <div class="exam-cover-badge">${guide.variant || 'Evaluación'}</div>
      <h2 class="exam-cover-title">${guide.title}</h2>
      <p class="exam-cover-meta">${[guide.subject, guide.code].filter(Boolean).join(' · ')}</p>
      <div class="exam-cover-stats">
        <span>${totalS} sección${totalS !== 1 ? 'es' : ''}</span>
        <span>${totalQ} pregunta${totalQ !== 1 ? 's' : ''}</span>
      </div>
      <p class="exam-cover-warning">Una vez que inicies, el cronómetro comenzará a correr. Completa la evaluación sin salir.</p>
      <button class="btn-begin-exam" id="btn-begin-exam">Iniciar evaluación →</button>
    </div>
  `;
  $("#btn-begin-exam").addEventListener("click", beginExam);
}

async function beginExam() {
  progress._startedAt = new Date().toISOString();
  startTimer();
  await saveProgress();
  startExamFocus(currentGuide.code || currentGuideId);
  $("#progress-bar-container").classList.remove("hidden");
  $("#section-nav").classList.remove("hidden");
  renderProgressBar();
  renderCurrentSection();
  updateNav();
  window.scrollTo(0, 0);
}

function showSelector() {
  stopExamFocus();
  stopTimer();
  $("#guide-container").classList.add("hidden");
  $("#guide-selector").classList.remove("hidden");
  loadGuideList();
}

// ── Timer ──────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  const timerEl = $("#timer");
  if (!timerEl) return;
  if (!currentGuide || currentGuide.mode !== "exam") { timerEl.classList.add("hidden"); return; }

  const allChecked = currentGuide && currentGuide.sections.every((_, i) => progress[i]?.checked);
  if (progress._finishedAt || allChecked) {
    // Guide is done — show final elapsed time or hide timer
    if (progress._startedAt) {
      const end = progress._finishedAt ? new Date(progress._finishedAt) : new Date();
      const elapsed = Math.floor((end - new Date(progress._startedAt)) / 1000);
      timerEl.textContent = formatTimeHuman(elapsed);
      timerEl.className = "stopped";
      timerEl.classList.remove("hidden");
      // Backfill _finishedAt if missing
      if (!progress._finishedAt) {
        progress._finishedAt = new Date().toISOString();
        saveProgress();
      }
    } else {
      timerEl.classList.add("hidden");
    }
    return;
  }

  if (!progress._startedAt) { timerEl.classList.add("hidden"); return; }

  timerEl.classList.remove("hidden");
  timerEl.className = "running";
  const startTime = new Date(progress._startedAt);

  const tick = () => {
    const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
    timerEl.textContent = formatTime(elapsed);
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimeHuman(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0 && m > 0) return `Completada en ${h}h ${m} min`;
  if (h > 0) return `Completada en ${h}h`;
  if (m > 0) return `Completada en ${m} min`;
  return "Completada en menos de 1 min";
}

function markFinished() {
  if (!progress._finishedAt) {
    progress._finishedAt = new Date().toISOString();
    saveProgress();
  }
  stopTimer();
  const timerEl = $("#timer");
  if (timerEl && progress._startedAt) {
    const elapsed = Math.floor((new Date(progress._finishedAt) - new Date(progress._startedAt)) / 1000);
    timerEl.textContent = formatTimeHuman(elapsed);
    timerEl.className = "stopped";
  }
}

// ── Render ──────────────────────────────────────────────────
function renderGuideHeader() {
  const header = $("#guide-header");
  const codeLabel = currentGuide.code ? `<span class="guide-code">${currentGuide.code}</span>` : "";
  header.innerHTML = `
    <div class="guide-header-row">
      <div>
        <h2>${currentGuide.title}</h2>
        <h3>${currentGuide.subtitle}</h3>
      </div>
      <div class="guide-header-actions">
        ${codeLabel}
        <a class="guide-print-btn" href="${BASE}/print/${currentGuideId}" target="_blank" title="Imprimir (con respuestas)">🖨</a>
        <a class="guide-print-btn" href="${BASE}/print/${currentGuideId}?blank=1" target="_blank" title="Imprimir en blanco (para llenar a mano)">📝</a>
      </div>
    </div>
  `;
}

function renderProgressBar() {
  const dots = $("#progress-dots");
  dots.innerHTML = "";
  currentGuide.sections.forEach((_, i) => {
    const dot = document.createElement("div");
    dot.className = "progress-dot";
    if (progress[i]?.checked) dot.classList.add("completed");
    if (i === currentSection) dot.classList.add("current");
    dot.addEventListener("click", () => {
      saveAnswersFromDOM();
      currentSection = i;
      renderCurrentSection();
      renderProgressBar();
      updateNav();
      window.scrollTo(0, 0);
    });
    dots.appendChild(dot);
  });

  const checked = Object.values(progress).filter((s) => s && s.checked).length;
  const total = currentGuide.sections.length;
  $("#progress-label").textContent = `Sección ${currentSection + 1} de ${total} — ${checked} revisadas`;
}

function renderCurrentSection() {
  const container = $("#active-section");
  container.innerHTML = "";
  const section = currentGuide.sections[currentSection];
  if (!section) return;

  const div = document.createElement("div");
  div.className = "section";

  const titleNum = section.id ? section.id.toUpperCase() + ". " : "";
  div.innerHTML = `
    <div class="section-title">${titleNum}${section.title}</div>
    ${section.instructions ? `<div class="section-instructions">${section.instructions}</div>` : ""}
    <div class="section-exercises"></div>
  `;

  const exContainer = div.querySelector(".section-exercises");
  const renderer = renderers[section.type];
  if (renderer) {
    renderer(section, exContainer, currentSection);
  } else {
    exContainer.innerHTML = `<p><em>Tipo no soportado: ${section.type}</em></p>`;
  }

  container.appendChild(div);

  // Restore saved answers if any
  restoreAnswers(currentSection);

  // If already checked, show results and lock
  if (progress[currentSection]?.checked) {
    if (isExamMode()) showExamResults(currentSection);
    else showPracticeResults(currentSection);
    lockSection(div);
  }
}

function isExamMode() {
  return currentGuide.mode === "exam";
}

function updateNav() {
  const nav = $("#section-nav");
  nav.classList.remove("hidden");

  const isFirst = currentSection === 0;
  const isLast = currentSection === currentGuide.sections.length - 1;
  const isChecked = progress[currentSection]?.checked;
  const exam = isExamMode();

  $("#btn-prev").style.visibility = isFirst ? "hidden" : "visible";

  if (exam) {
    // Exam mode: no per-section correction
    const allDone = examAllSectionsAnswered();
    const anyChecked = currentGuide.sections.some((_, i) => progress[i]?.checked);
    if (isLast) examReachedEnd = true;
    const checkBtn = $("#btn-check-section");
    if (anyChecked) {
      checkBtn.style.display = "";
      checkBtn.textContent = "Corregido";
      checkBtn.disabled = true;
      removeExamPending();
    } else if (examReachedEnd) {
      checkBtn.style.display = "";
      checkBtn.textContent = "Corregir examen";
      checkBtn.disabled = false;
      if (!allDone) showExamPending();
      else removeExamPending();
    } else {
      checkBtn.style.display = "none";
      removeExamPending();
    }
  } else {
    // Practice mode: "Revisar" with attempts
    const section = currentGuide.sections[currentSection];
    if (section.type === "reading") {
      $("#btn-check-section").textContent = isChecked ? "Leído ✓" : "Marcar como leído";
      $("#btn-check-section").disabled = isChecked;
    } else if (section.type === "free_text") {
      $("#btn-check-section").textContent = isChecked ? "Guardado ✓" : "Guardar";
      $("#btn-check-section").disabled = false;
    } else if (isChecked) {
      const attempts = progress[currentSection]?.attempts || 0;
      const remaining = MAX_REVIEW_ATTEMPTS - attempts;
      if (remaining > 0) {
        $("#btn-check-section").textContent = `Revisar (${remaining} intento${remaining > 1 ? "s" : ""})`;
        $("#btn-check-section").disabled = false;
      } else {
        $("#btn-check-section").textContent = "Sin intentos";
        $("#btn-check-section").disabled = true;
      }
    } else {
      $("#btn-check-section").textContent = "Revisar";
      $("#btn-check-section").disabled = false;
    }
  }

  if (isLast) {
    const allChecked = currentGuide.sections.every((_, i) => progress[i]?.checked);
    if (exam && !allChecked) {
      // Hide "next" on last section in exam — the action is "Corregir examen"
      $("#btn-next").style.visibility = "hidden";
    } else {
      $("#btn-next").style.visibility = "visible";
      $("#btn-next").textContent = allChecked ? "Ver resultado final" : "Siguiente →";
    }
  } else {
    $("#btn-next").style.visibility = "visible";
    $("#btn-next").textContent = "Siguiente →";
  }
}

function showExamPending(showWarning) {
  removeExamPending();
  const pending = [];
  currentGuide.sections.forEach((section, si) => {
    const saved = progress[si]?.answers;
    if (!saved) { pending.push({ si, title: section.title, missing: section.exercises.length }); return; }
    let missing = 0;
    section.exercises.forEach((ex, ei) => {
      if (progress[si]?.voided?.[ei]) return;
      const answer = saved[ei];
      const type = section.type;
      let isEmpty = false;
      if (type === "highlight") isEmpty = !answer || typeof answer !== "object" || Object.keys(answer).length === 0;
      else if (type === "classify" || type === "true_false" || type === "compare" || type === "multiple_choice") isEmpty = isChoiceEmpty(section, type, answer);
      else if (type === "fill") isEmpty = answer == null || (typeof answer === "string" && answer.trim() === "");
      if (isEmpty) missing++;
    });
    if (missing > 0) pending.push({ si, title: section.title, missing });
  });
  if (pending.length === 0) return;

  const nav = $("#section-nav");
  const div = document.createElement("div");
  div.id = "exam-pending";
  const warningHTML = showWarning
    ? '<div class="exam-pending-warning">Tienes preguntas sin responder. Vuelve a las secciones pendientes y responde o anula cada pregunta antes de corregir.</div>'
    : '';
  div.innerHTML = warningHTML +
    `<div class="exam-pending-title">Pendientes por responder:</div>` +
    pending.map((p) => `<button class="exam-pending-item" data-si="${p.si}">${p.title} (${p.missing})</button>`).join("");
  nav.parentNode.insertBefore(div, nav.nextSibling);

  div.querySelectorAll(".exam-pending-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentSection = parseInt(btn.dataset.si);
      renderCurrentSection();
      renderProgressBar();
      updateNav();
      highlightPendingExercises();
      window.scrollTo(0, 0);
    });
  });
}

function highlightPendingExercises() {
  const section = currentGuide.sections[currentSection];
  if (!section) return;
  const sectionDiv = $("#active-section .section");
  if (!sectionDiv) return;
  // Collect fresh answers from DOM instead of relying on saved progress
  const answers = collectAnswers(section, sectionDiv);
  const exercises = sectionDiv.querySelectorAll(".exercise");
  exercises.forEach((exDiv, ei) => {
    if (progress[currentSection]?.voided?.[ei]) return;
    const answer = answers[ei];
    const type = section.type;
    let isEmpty = false;
    if (type === "highlight") isEmpty = !answer || typeof answer !== "object" || Object.keys(answer).length === 0;
    else if (type === "classify" || type === "true_false" || type === "compare" || type === "multiple_choice") isEmpty = isChoiceEmpty(section, type, answer);
    else if (type === "fill" || type === "free_text") isEmpty = answer == null || (typeof answer === "string" && answer.trim() === "");
    if (isEmpty) exDiv.classList.add("pending-highlight");
  });
}

function removeExamPending() {
  const el = document.getElementById("exam-pending");
  if (el) el.remove();
}

// ── Exercise Renderers ─────────────────────────────────────
const renderers = {
  highlight(section, container, si) {
    const legend = document.createElement("div");
    legend.className = "highlight-legend";
    section.categories.forEach((cat, ci) => {
      const item = document.createElement("span");
      item.className = `legend-item cat-${ci}${ci === 0 ? " active" : ""}`;
      item.textContent = cat;
      item.dataset.catIndex = ci;
      item.addEventListener("click", () => {
        legend.querySelectorAll(".legend-item").forEach((l) => l.classList.remove("active"));
        item.classList.add("active");
        activeCategory = ci;
      });
      legend.appendChild(item);
    });
    container.appendChild(legend);

    section.exercises.forEach((ex, ei) => {
      const div = document.createElement("div");
      div.className = "exercise";
      div.dataset.exerciseIndex = ei;

      const num = document.createElement("span");
      num.className = "exercise-number";
      num.textContent = `${ei + 1}.`;

      const sentence = document.createElement("span");
      sentence.className = "highlight-sentence";

      const tokens = tokenize(ex.text);
      tokens.forEach((token) => {
        if (token.type === "word") {
          const span = document.createElement("span");
          span.className = "highlight-word";
          span.textContent = token.text;
          span.dataset.word = token.clean;
          span.dataset.cat = "-1";
          span.addEventListener("click", () => {
            const current = parseInt(span.dataset.cat);
            if (current === activeCategory) {
              span.dataset.cat = "-1";
              span.className = "highlight-word";
            } else {
              span.dataset.cat = activeCategory;
              span.className = `highlight-word tagged cat-${activeCategory}`;
            }
          });
          sentence.appendChild(span);
        } else {
          sentence.appendChild(document.createTextNode(token.text));
        }
      });

      div.appendChild(num);
      div.appendChild(sentence);
      container.appendChild(div);
    });
  },

  classify(section, container) {
    section.exercises.forEach((ex, ei) => {
      const div = document.createElement("div");
      div.className = "exercise";
      div.dataset.exerciseIndex = ei;

      const inner = document.createElement("div");
      inner.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:0.25rem";

      const num = document.createElement("span");
      num.className = "exercise-number";
      num.textContent = `${ei + 1}.`;

      const text = document.createElement("span");
      text.textContent = ex.text;

      const btns = document.createElement("span");
      btns.className = "classify-options";
      section.options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.className = "classify-btn";
        btn.textContent = opt;
        btn.addEventListener("click", () => {
          btns.querySelectorAll(".classify-btn").forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          div.dataset.answer = opt;
        });
        btns.appendChild(btn);
      });

      inner.appendChild(num);
      inner.appendChild(text);
      inner.appendChild(btns);
      div.appendChild(inner);
      container.appendChild(div);
    });
  },

  fill(section, container) {
    section.exercises.forEach((ex, ei) => {
      const div = document.createElement("div");
      div.className = "exercise";
      div.dataset.exerciseIndex = ei;
      div.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:0.5rem";

      const num = document.createElement("span");
      num.className = "exercise-number";
      num.textContent = `${ei + 1}.`;

      const text = document.createElement("span");
      text.innerHTML = ex.text;

      const input = document.createElement("input");
      input.type = "text";
      input.className = "fill-input";

      div.appendChild(num);
      div.appendChild(text);
      div.appendChild(input);
      container.appendChild(div);
    });
  },

  true_false(section, container) {
    section.exercises.forEach((ex, ei) => {
      const div = document.createElement("div");
      div.className = "exercise";
      div.dataset.exerciseIndex = ei;

      const inner = document.createElement("div");
      inner.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:0.25rem";

      const num = document.createElement("span");
      num.className = "exercise-number";
      num.textContent = `${ei + 1}.`;

      const btns = document.createElement("span");
      btns.className = "tf-btns";
      ["V", "F"].forEach((val) => {
        const btn = document.createElement("button");
        btn.className = "tf-btn";
        btn.textContent = val;
        btn.addEventListener("click", () => {
          btns.querySelectorAll(".tf-btn").forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          div.dataset.answer = val;
        });
        btns.appendChild(btn);
      });

      const text = document.createElement("span");
      text.textContent = " " + ex.text;

      inner.appendChild(num);
      inner.appendChild(btns);
      inner.appendChild(text);
      div.appendChild(inner);
      container.appendChild(div);
    });
  },

  compare(section, container) {
    section.exercises.forEach((ex, ei) => {
      const div = document.createElement("div");
      div.className = "exercise";
      div.dataset.exerciseIndex = ei;

      const inner = document.createElement("div");
      inner.className = "compare-exercise";

      const num = document.createElement("span");
      num.className = "exercise-number";
      num.textContent = `${ei + 1}.`;

      const left = document.createElement("span");
      left.className = "compare-value";
      left.textContent = ex.left;

      const btns = document.createElement("span");
      btns.className = "compare-btns";
      [">", "<"].forEach((op) => {
        const btn = document.createElement("button");
        btn.className = "compare-btn";
        btn.textContent = op;
        btn.addEventListener("click", () => {
          btns.querySelectorAll(".compare-btn").forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          div.dataset.answer = op;
        });
        btns.appendChild(btn);
      });

      const right = document.createElement("span");
      right.className = "compare-value";
      right.textContent = ex.right;

      inner.appendChild(num);
      inner.appendChild(left);
      inner.appendChild(btns);
      inner.appendChild(right);
      div.appendChild(inner);
      container.appendChild(div);
    });
  },

  multiple_choice(section, container) {
    section.exercises.forEach((ex, ei) => {
      const div = document.createElement("div");
      div.className = "exercise";
      div.dataset.exerciseIndex = ei;

      const num = document.createElement("span");
      num.className = "exercise-number";
      num.textContent = `${ei + 1}.`;

      const text = document.createElement("span");
      text.innerHTML = ex.text;

      const header = document.createElement("div");
      header.appendChild(num);
      header.appendChild(text);

      const opts = document.createElement("div");
      opts.className = "mc-options";
      const letters = "ABCDEFGH";
      ex.options.forEach((opt, oi) => {
        const optDiv = document.createElement("div");
        optDiv.className = "mc-option";
        optDiv.innerHTML = `<span class="mc-letter">${letters[oi]}.</span> ${opt}`;
        optDiv.addEventListener("click", () => {
          opts.querySelectorAll(".mc-option").forEach((o) => o.classList.remove("selected"));
          optDiv.classList.add("selected");
          div.dataset.answer = String(oi);
        });
        opts.appendChild(optDiv);
      });

      div.appendChild(header);
      div.appendChild(opts);
      if (confidenceEnabled(section)) div.appendChild(buildConfidenceRow(div));
      container.appendChild(div);
    });
  },

  reading(section, container) {
    section.exercises.forEach((ex, ei) => {
      const div = document.createElement("div");
      div.className = "exercise reading-block";
      div.dataset.exerciseIndex = ei;
      div.innerHTML = ex.text;
      container.appendChild(div);
    });
  },

  free_text(section, container) {
    section.exercises.forEach((ex, ei) => {
      const div = document.createElement("div");
      div.className = "exercise";
      div.dataset.exerciseIndex = ei;

      const num = document.createElement("span");
      num.className = "exercise-number";
      num.textContent = `${ei + 1}.`;

      const text = document.createElement("span");
      text.innerHTML = ex.text;

      const header = document.createElement("div");
      header.style.marginBottom = "0.5rem";
      header.appendChild(num);
      header.appendChild(text);

      const textarea = document.createElement("textarea");
      textarea.className = "free-textarea";
      if (ex.placeholder) textarea.placeholder = ex.placeholder;

      div.appendChild(header);
      div.appendChild(textarea);
      container.appendChild(div);
    });
  },
};

// ── Save/Restore Answers ───────────────────────────────────
function saveAnswersFromDOM() {
  const section = currentGuide.sections[currentSection];
  if (!section) return;
  const sectionDiv = $("#active-section .section");
  if (!sectionDiv) return;

  const answers = collectAnswers(section, sectionDiv);
  if (!progress[currentSection]) progress[currentSection] = {};

  // Defensive: don't overwrite real answers with all-null when the DOM was
  // empty (e.g. user is on the score-summary screen but a stale handler fires).
  // If the DOM yields all-null AND we already have real answers stored, skip.
  const existing = progress[currentSection].answers;
  const isEmpty = (v) => v == null || v === "" ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  const allEmpty = answers.length === 0 || answers.every(isEmpty);
  const hadAnswers = Array.isArray(existing) && existing.some((v) => !isEmpty(v));
  if (allEmpty && hadAnswers) {
    console.warn('saveAnswersFromDOM: skipping — DOM empty but real answers exist for section', currentSection);
    return;
  }

  progress[currentSection].answers = answers;
  saveProgress();
}

function collectAnswers(section, sectionDiv) {
  const exercises = sectionDiv.querySelectorAll(".exercise");
  const answers = [];

  exercises.forEach((exDiv, ei) => {
    const type = section.type;
    let answer = null;

    if (type === "highlight") {
      const wordTags = {};
      exDiv.querySelectorAll(".highlight-word").forEach((w) => {
        const cat = parseInt(w.dataset.cat);
        if (cat >= 0) wordTags[w.dataset.word] = cat;
      });
      answer = wordTags;
    } else if (type === "classify" || type === "true_false" || type === "compare" || type === "multiple_choice") {
      answer = exDiv.dataset.answer || null;
      if (type === "multiple_choice" && confidenceEnabled(section)) {
        const conf = exDiv.dataset.conf || null;
        answer = (answer == null && conf == null) ? null : { choice: answer, conf: conf };
      }
    } else if (type === "fill") {
      const input = exDiv.querySelector(".fill-input");
      answer = input ? input.value : null;
    } else if (type === "free_text") {
      const textarea = exDiv.querySelector(".free-textarea");
      answer = textarea ? textarea.value : null;
    } else if (type === "reading") {
      answer = "read";
    }

    answers.push(answer);
  });

  return answers;
}

function restoreAnswers(si) {
  const saved = progress[si]?.answers;
  if (!saved) return;

  const section = currentGuide.sections[si];
  const sectionDiv = $("#active-section .section");
  if (!sectionDiv) return;

  const exercises = sectionDiv.querySelectorAll(".exercise");
  exercises.forEach((exDiv, ei) => {
    const answer = saved[ei];
    if (answer == null) return;

    const type = section.type;

    if (type === "highlight" && typeof answer === "object") {
      exDiv.querySelectorAll(".highlight-word").forEach((w) => {
        const cat = answer[w.dataset.word];
        if (cat !== undefined) {
          w.dataset.cat = cat;
          w.className = `highlight-word tagged cat-${cat}`;
        }
      });
    } else if (type === "classify") {
      const btns = exDiv.querySelectorAll(".classify-btn");
      btns.forEach((b) => {
        if (b.textContent === answer) {
          b.classList.add("selected");
          exDiv.dataset.answer = answer;
        }
      });
    } else if (type === "true_false") {
      const btns = exDiv.querySelectorAll(".tf-btn");
      btns.forEach((b) => {
        if (b.textContent === answer) {
          b.classList.add("selected");
          exDiv.dataset.answer = answer;
        }
      });
    } else if (type === "compare") {
      const btns = exDiv.querySelectorAll(".compare-btn");
      btns.forEach((b) => {
        if (b.textContent === answer) {
          b.classList.add("selected");
          exDiv.dataset.answer = answer;
        }
      });
    } else if (type === "multiple_choice") {
      // Acepta el formato viejo (índice pelado) y el nuevo {choice, conf}
      const choice = answerChoice(answer);
      const opts = exDiv.querySelectorAll(".mc-option");
      const idx = parseInt(choice);
      if (opts[idx]) {
        opts[idx].classList.add("selected");
        exDiv.dataset.answer = String(choice);
      }
      const conf = answerConf(answer);
      if (conf) {
        exDiv.dataset.conf = conf;
        const btn = exDiv.querySelector(`.conf-btn[data-conf="${conf}"]`);
        if (btn) btn.classList.add("selected");
      }
    } else if (type === "fill") {
      const input = exDiv.querySelector(".fill-input");
      if (input) input.value = answer;
    } else if (type === "free_text") {
      const textarea = exDiv.querySelector(".free-textarea");
      if (textarea) textarea.value = answer;
    }

    // Restore voided state
    const voided = progress[si]?.voided;
    if (voided && voided[ei]) {
      exDiv.classList.add("voided");
      const opt = VOID_OPTIONS.find((o) => o.id === voided[ei]);
      const badge = document.createElement("div");
      badge.className = "void-badge";
      badge.textContent = `Anulada: ${opt ? opt.label : voided[ei]}`;
      exDiv.appendChild(badge);
    }
  });
}

// ── Exam: correct entire exam at once ─────────────────────
function correctEntireExam() {
  // El panel de pendientes queda colgado si el examen se bloqueó una vez y
  // después se completó: showFinalSummary no pasa por updateNav.
  removeExamPending();
  // Correct each section silently (without rendering)
  currentGuide.sections.forEach((section, si) => {
    if (!progress[si]) progress[si] = {};
    progress[si].checked = true;
    progress[si].attempts = 1;

    if (section.type === "free_text" || section.type === "reading") {
      progress[si].score = { correct: 0, total: 0 };
      return;
    }

    // Calculate score using saved answers
    const saved = progress[si]?.answers || [];
    let correct = 0, total = 0;
    section.exercises.forEach((ex, ei) => {
      const isVoided = progress[si]?.voided?.[ei];
      if (isVoided) return;

      total++;
      const answer = saved[ei];
      if (section.type === "multiple_choice") {
        if (String(answerChoice(answer)) === String(ex.answer)) correct++;
      } else if (section.type === "fill") {
        const expected = Array.isArray(ex.answer) ? ex.answer.map(normalize) : [normalize(String(ex.answer))];
        if (expected.includes(normalize(String(answer || "")))) correct++;
      } else if (section.type === "true_false") {
        const expected = ex.answer ? "V" : "F";
        if (answer === expected) correct++;
      } else if (section.type === "compare") {
        if (answer === ex.answer) correct++;
      } else if (section.type === "classify") {
        if (answer === ex.answer) correct++;
      } else if (section.type === "highlight" && typeof answer === "object") {
        const answers = ex.answers || {};
        for (const key in answers) {
          total++; // each word is an item
          const expectedIndex = section.categories.indexOf(answers[key]);
          if (answer[key] !== undefined && parseInt(answer[key]) === expectedIndex) correct++;
        }
        total--; // undo the outer total++ since highlight counts per word
      }
    });
    progress[si].score = { correct, total };
  });

  markFinished();
  saveProgress();

  // Go straight to final summary
  showFinalSummary();
}

// ── Exam: check if all sections have been answered ────────
function examAllSectionsAnswered() {
  if (!currentGuide) return false;
  saveAnswersFromDOM(); // capture current section state
  for (let si = 0; si < currentGuide.sections.length; si++) {
    const section = currentGuide.sections[si];
    if (section.type === "reading") continue; // reading doesn't block
    const saved = progress[si]?.answers;
    if (!saved) return false;
    // Check each exercise has an answer or is voided
    for (let ei = 0; ei < section.exercises.length; ei++) {
      const isVoided = progress[si]?.voided?.[ei];
      if (isVoided) continue;
      const answer = saved[ei];
      const type = section.type;
      let isEmpty = false;
      if (type === "free_text") {
        isEmpty = answer == null || (typeof answer === "string" && answer.trim() === "");
      } else if (type === "highlight") {
        isEmpty = !answer || typeof answer !== "object" || Object.keys(answer).length === 0;
      } else if (type === "classify" || type === "true_false" || type === "compare" || type === "multiple_choice") {
        isEmpty = isChoiceEmpty(section, type, answer);
      } else if (type === "fill") {
        isEmpty = answer == null || (typeof answer === "string" && answer.trim() === "");
      }
      if (isEmpty) return false;
    }
  }
  return true;
}

// ── Check Section ──────────────────────────────────────────
function checkCurrentSection() {
  maybeStartTimer();
  const si = currentSection;
  const section = currentGuide.sections[si];
  const sectionDiv = $("#active-section .section");
  if (!sectionDiv || !section) return;

  const answers = collectAnswers(section, sectionDiv);
  if (!progress[si]) progress[si] = {};
  progress[si].answers = answers;

  // EXAM MODE: correct entire exam at once
  if (isExamMode()) {
    saveAnswersFromDOM();
    if (!examAllSectionsAnswered()) {
      showExamPending(true);
      return;
    }
    correctEntireExam();
    return;
  }

  // Reading: mark as read
  if (section.type === "reading") {
    progress[si].checked = true;
    progress[si].score = { correct: 0, total: 0 };
    showMsg(sectionDiv, "✓ Leído", "success");
    saveProgress();
    renderProgressBar();
    updateNav();
    return;
  }

  // Free text: just save
  if (section.type === "free_text") {
    const hasContent = answers.some((a) => a && a.trim().length > 0);
    progress[si].checked = true;
    progress[si].score = { correct: 0, total: 0 };
    showMsg(sectionDiv, hasContent ? "✓ Respuestas guardadas" : "✓ Sección marcada como vista", "success");
    saveProgress();
    renderProgressBar();
    updateNav();
    return;
  }

  // Check for missing answers (skip voided exercises)
  const allExDivs = sectionDiv.querySelectorAll(".exercise");
  const missing = findMissingAnswers(section, sectionDiv, answers).filter(
    (idx) => !allExDivs[idx]?.classList.contains("voided")
  );
  if (missing.length > 0) {
    clearFeedback(sectionDiv);
    missing.forEach((idx) => {
      const exDiv = allExDivs[idx];
      if (!exDiv) return;
      exDiv.classList.add("missing");
      // Add action buttons if not already there
      if (!exDiv.querySelector(".void-actions")) {
        const actions = document.createElement("div");
        actions.className = "void-actions";

        const dunnoBtn = document.createElement("button");
        dunnoBtn.className = "dunno-btn";
        dunnoBtn.textContent = "No sé qué responder";
        dunnoBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          showVoidOptions(exDiv, idx, si, "dunno");
        });
        actions.appendChild(dunnoBtn);

        const voidBtn = document.createElement("button");
        voidBtn.className = "void-btn";
        voidBtn.textContent = "Anular";
        voidBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          showVoidOptions(exDiv, idx, si);
        });
        actions.appendChild(voidBtn);

        exDiv.appendChild(actions);
      }
    });
    showMsg(sectionDiv, `Te faltan ${missing.length} ejercicio${missing.length > 1 ? "s" : ""} por responder. Debes responder o declarar que no responderás.`, "warning");
    saveProgress();
    return;
  }

  {
    // PRACTICE: review with attempts
    if (!progress[si].attempts) progress[si].attempts = 0;
    progress[si].attempts++;
    progress[si].checked = true;
    const result = showPracticeResults(si);
    progress[si].score = result;

    // If all correct or out of attempts, lock
    if (result.correct === result.total || progress[si].attempts >= MAX_REVIEW_ATTEMPTS) {
      lockSection(sectionDiv);
    }
  }

  // Stop timer when all sections are checked
  const allChecked = currentGuide.sections.every((_, i) => progress[i]?.checked);
  if (allChecked) markFinished();

  saveProgress();
  renderProgressBar();
  updateNav();
}

function showMsg(sectionDiv, text, type) {
  let msg = sectionDiv.querySelector(".section-msg");
  if (!msg) { msg = document.createElement("div"); msg.className = "section-msg"; sectionDiv.appendChild(msg); }
  const styles = {
    success: "background:#d4edda;color:#1e7e34",
    warning: "background:#fff3cd;color:#856404",
    error: "background:#fadbd8;color:#c0392b",
  };
  msg.style.cssText = `margin-top:1rem;padding:0.75rem;border-radius:6px;font-weight:600;text-align:center;${styles[type] || styles.success}`;
  msg.textContent = text;
}

function lockSection(sectionDiv) {
  // Disable all inputs in the section
  sectionDiv.querySelectorAll("input, textarea, button:not(.btn-primary):not(.btn-secondary)").forEach((el) => {
    el.disabled = true;
    el.style.pointerEvents = "none";
  });
  sectionDiv.querySelectorAll(".highlight-word, .classify-btn, .tf-btn, .compare-btn, .mc-option").forEach((el) => {
    el.style.pointerEvents = "none";
    el.style.opacity = "0.8";
  });
}

function showPracticeResults(si) {
  // Practice: shows correct/incorrect but NEVER the answer
  const section = currentGuide.sections[si];
  const sectionDiv = $("#active-section .section");
  const checker = checkers[section.type];
  if (!checker) return { correct: 0, total: 0 };

  clearFeedback(sectionDiv);
  let totalCorrect = 0, totalItems = 0;
  const conf = newConfTally();

  sectionDiv.querySelectorAll(".exercise").forEach((exDiv, ei) => {
    const ex = section.exercises[ei];
    const result = checker(section, exDiv, ex);
    if (result.skip) return;
    totalCorrect += result.correct;
    totalItems += result.total;

    if (result.total > 0) {
      const isCorrect = result.correct === result.total;
      exDiv.classList.add(isCorrect ? "correct" : "incorrect");
      tallyConfidence(section, exDiv, isCorrect, conf);
      if (!isCorrect) {
        const fb = document.createElement("div");
        fb.className = "exercise-feedback incorrect";
        fb.textContent = "Revisa tu respuesta";
        exDiv.appendChild(fb);
      }
    }
  });

  appendConfSummary(section, sectionDiv, conf);
  const attempts = progress[si]?.attempts || 0;
  const remaining = MAX_REVIEW_ATTEMPTS - attempts;
  if (totalCorrect === totalItems) {
    showMsg(sectionDiv, `¡Perfecto! ${totalCorrect} de ${totalItems} correctas`, "success");
  } else if (remaining > 0) {
    showMsg(sectionDiv, `${totalCorrect} de ${totalItems} correctas — puedes corregir e intentar de nuevo (${remaining} intento${remaining > 1 ? "s" : ""})`, "warning");
  } else {
    showMsg(sectionDiv, `${totalCorrect} de ${totalItems} correctas — sin más intentos`, "error");
  }

  return { correct: totalCorrect, total: totalItems };
}

function showExamResults(si) {
  // Exam: shows correct/incorrect, no retries
  // On review (guide already finished), shows the correct answer for incorrect exercises
  const section = currentGuide.sections[si];
  const sectionDiv = $("#active-section .section");
  const checker = checkers[section.type];
  if (!checker) return { correct: 0, total: 0 };
  const isReview = !!progress._finishedAt || currentGuide.sections.every((_, i) => progress[i]?.checked);

  clearFeedback(sectionDiv);
  let totalCorrect = 0, totalItems = 0;
  const conf = newConfTally();

  sectionDiv.querySelectorAll(".exercise").forEach((exDiv, ei) => {
    const ex = section.exercises[ei];
    const result = checker(section, exDiv, ex);
    if (result.skip) return;
    totalCorrect += result.correct;
    totalItems += result.total;

    if (result.total > 0) {
      const isCorrect = result.correct === result.total;
      exDiv.classList.add(isCorrect ? "correct" : "incorrect");
      tallyConfidence(section, exDiv, isCorrect, conf);
      if (!isCorrect && isReview) {
        const expected = getExpectedAnswer(section, ex);
        if (expected) {
          const fb = document.createElement("div");
          fb.className = "exercise-feedback answer-reveal";
          fb.textContent = `Respuesta correcta: ${expected}`;
          exDiv.appendChild(fb);
        }
      }
    }
  });

  appendConfSummary(section, sectionDiv, conf);
  const pct = totalItems > 0 ? Math.round((totalCorrect / totalItems) * 100) : 0;
  const type = pct >= 80 ? "success" : pct >= 50 ? "warning" : "error";
  showMsg(sectionDiv, `${totalCorrect} de ${totalItems} correctas (${pct}%)`, type);

  return { correct: totalCorrect, total: totalItems };
}

function findMissingAnswers(section, sectionDiv, answers) {
  const missing = [];
  const exercises = sectionDiv.querySelectorAll(".exercise");
  exercises.forEach((exDiv, ei) => {
    const answer = answers[ei];
    const type = section.type;

    let isEmpty = false;
    if (type === "highlight") {
      // Highlight: check if at least one word was tagged
      isEmpty = !answer || typeof answer !== "object" || Object.keys(answer).length === 0;
    } else if (type === "classify" || type === "true_false" || type === "compare" || type === "multiple_choice") {
      // En práctica la confianza no bloquea la revisión (requireConf = false);
      // el que la exige es "Corregir examen".
      isEmpty = isChoiceEmpty(section, type, answer, false);
    } else if (type === "fill") {
      isEmpty = answer == null || (typeof answer === "string" && answer.trim() === "");
    }

    if (isEmpty) missing.push(ei);
  });
  return missing;
}

// ── Void (Anular) System ─────────────────────────────────
const VOID_OPTIONS = [
  { id: "scope", label: "Fuera del alcance", icon: "🎯", allows: true },
  { id: "lazy", label: "Me da lata", icon: "😴", allows: true },
  { id: "dunno", label: "No la sé", icon: "🤷", allows: false },
];

const DUNNO_MEMES = [
  "😂 ¡Pero esa es la idea del examen! Se supone que tenías que haber estudiado...",
  "🤣 ¿No la sabes? ¡Eso no es excusa! Para eso se estudia antes...",
  "😆 Jajaja no, así no funciona. ¡Inténtalo! Algo se te tiene que ocurrir...",
  "🫠 ¿'No la sé' es tu respuesta final? Piénsalo un poquito más...",
  "💀 Bonito intento, pero no. ¡Dale, que algo sabes!",
];

function showVoidOptions(exDiv, exIndex, sectionIndex, directMode) {
  // Remove existing void panel
  const existing = exDiv.querySelector(".void-panel");
  if (existing) { existing.remove(); }

  // "No sé qué responder" → go straight to meme
  if (directMode === "dunno") {
    const panel = document.createElement("div");
    panel.className = "void-panel";
    showDunnoMeme(panel);
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "void-option void-cancel";
    cancelBtn.textContent = "✕ Cerrar";
    cancelBtn.addEventListener("click", () => panel.remove());
    panel.appendChild(cancelBtn);
    exDiv.appendChild(panel);
    return;
  }

  const panel = document.createElement("div");
  panel.className = "void-panel";

  const title = document.createElement("div");
  title.className = "void-title";
  title.textContent = "¿Por qué quieres anular esta pregunta?";
  panel.appendChild(title);

  VOID_OPTIONS.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "void-option";
    btn.textContent = `${opt.icon} ${opt.label}`;
    btn.addEventListener("click", () => {
      if (opt.allows) {
        confirmVoid(exDiv, exIndex, sectionIndex, opt);
      } else {
        showDunnoMeme(panel);
      }
    });
    panel.appendChild(btn);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "void-option void-cancel";
  cancelBtn.textContent = "✕ Cancelar";
  cancelBtn.addEventListener("click", () => panel.remove());
  panel.appendChild(cancelBtn);

  exDiv.appendChild(panel);
}

function confirmVoid(exDiv, exIndex, sectionIndex, opt) {
  // Show confirmation
  const panel = exDiv.querySelector(".void-panel");
  panel.innerHTML = "";

  const msg = document.createElement("div");
  msg.className = "void-title";
  const lazyWarning = opt.id === "lazy" ? " Se registrará como incorrecta (0 puntos)." : "";
  msg.textContent = `¿Seguro que quieres anular? Razón: "${opt.label}".${lazyWarning}`;
  panel.appendChild(msg);

  const yesBtn = document.createElement("button");
  yesBtn.className = "void-option void-confirm";
  yesBtn.textContent = "Sí, anular";
  yesBtn.addEventListener("click", () => {
    // Mark as voided
    exDiv.classList.add("voided");
    exDiv.classList.remove("missing");
    panel.remove();
    const voidBtn = exDiv.querySelector(".void-btn");
    if (voidBtn) voidBtn.remove();

    // Add void badge
    const badge = document.createElement("div");
    badge.className = "void-badge";
    badge.textContent = `Anulada: ${opt.label}`;
    exDiv.appendChild(badge);

    // Store void reason in progress
    if (!progress[sectionIndex]) progress[sectionIndex] = {};
    if (!progress[sectionIndex].voided) progress[sectionIndex].voided = {};
    progress[sectionIndex].voided[exIndex] = opt.id;
    saveProgress();
    updateNav(); // re-check if exam is ready to correct
  });
  panel.appendChild(yesBtn);

  const noBtn = document.createElement("button");
  noBtn.className = "void-option void-cancel";
  noBtn.textContent = "No, volver";
  noBtn.addEventListener("click", () => panel.remove());
  panel.appendChild(noBtn);
}

function showDunnoMeme(panel) {
  const existing = panel.querySelector(".void-meme");
  if (existing) existing.remove();

  const meme = document.createElement("div");
  meme.className = "void-meme";
  meme.textContent = DUNNO_MEMES[Math.floor(Math.random() * DUNNO_MEMES.length)];
  panel.appendChild(meme);
}

function clearFeedback(sectionDiv) {
  sectionDiv.querySelectorAll(".exercise").forEach((exDiv) => {
    exDiv.classList.remove("correct", "incorrect", "missing");
    const fb = exDiv.querySelector(".exercise-feedback");
    if (fb) fb.remove();
    const cv = exDiv.querySelector(".conf-verdict");
    if (cv) cv.remove();
  });
  const msg = sectionDiv.querySelector(".section-msg");
  if (msg) msg.remove();
  const cs = sectionDiv.querySelector(".conf-summary");
  if (cs) cs.remove();
}

// ── Navigation ─────────────────────────────────────────────
function navigateSection(delta) {
  maybeStartTimer();
  saveAnswersFromDOM();

  const next = currentSection + delta;
  if (next < 0) return;

  // If going past the last section
  if (next >= currentGuide.sections.length) {
    // In exam mode, only show summary if already corrected
    if (isExamMode() && !currentGuide.sections.every((_, i) => progress[i]?.checked)) {
      return; // stay on last section
    }
    showFinalSummary();
    return;
  }

  currentSection = next;
  renderCurrentSection();
  renderProgressBar();
  updateNav();
  window.scrollTo(0, 0);
  saveProgress();
}

async function showFinalSummary() {
  // Cerrar focus mode primero (await) para que la sonda libere el WebView2.
  // Si falla, mostramos botón de emergencia al final.
  const focusClosed = await stopExamFocus();
  $("#active-section").innerHTML = "";
  $("#section-nav").classList.add("hidden");
  markFinished();

  let autoCorrect = 0, autoTotal = 0;
  let hasFreeText = false, freeTextAnswered = 0, freeTextTotal = 0;
  const rows = [];

  currentGuide.sections.forEach((section, i) => {
    const p = progress[i];
    const score = p?.score;
    const titleNum = section.id ? section.id.toUpperCase() + ". " : "";
    const name = titleNum + section.title;

    if (section.type === "free_text") {
      hasFreeText = true;
      freeTextTotal++;
      const answered = p?.answers?.some((a) => a && a.trim().length > 0);
      if (answered) freeTextAnswered++;
      const review = p?.review;
      if (review) {
        let commentsHTML = "";
        if (review.comments && review.comments.length > 0) {
          const items = review.comments.map((c, ci) => {
            const answer = p.answers && p.answers[ci] ? p.answers[ci] : "";
            const answerPreview = answer && answer.length > 0
              ? `<div style="font-size:0.8rem;color:var(--text-light);margin-bottom:0.2rem;font-style:italic;">"${answer}"</div>`
              : "";
            return `<div style="margin-bottom:0.5rem;">${answerPreview}<div style="font-size:0.8rem;color:var(--error);">${c}</div></div>`;
          }).join("");
          commentsHTML = `<tr><td colspan="2" style="padding:0.5rem 0.5rem 0.75rem;"><div style="background:var(--primary-light);border-radius:6px;padding:0.75rem;font-size:0.85rem;">${items}</div></td></tr>`;
        }
        rows.push(`<tr><td>${name}</td><td style="color:var(--primary);font-weight:600">Revisado: ${review.score}</td></tr>${commentsHTML}`);
      } else {
        rows.push(`<tr><td>${name}</td><td style="color:var(--text-light)">${answered ? "Pendiente de revisión" : "Sin responder"}</td></tr>`);
      }
    } else if (score && score.total > 0) {
      autoCorrect += score.correct;
      autoTotal += score.total;
      const pct = Math.round((score.correct / score.total) * 100);
      rows.push(`<tr><td>${name}</td><td>${score.correct}/${score.total} (${pct}%)</td></tr>`);
    } else {
      rows.push(`<tr><td>${name}</td><td>Sin revisar</td></tr>`);
    }
  });

  const autoPct = autoTotal > 0 ? Math.round((autoCorrect / autoTotal) * 100) : 0;
  const scoreClass = autoPct >= 80 ? "great" : autoPct >= 50 ? "ok" : "needs-work";
  const color = autoPct >= 80 ? "var(--success)" : autoPct >= 50 ? "var(--warning)" : "var(--error)";

  // Time elapsed
  let timeHTML = "";
  if (progress._startedAt && progress._finishedAt) {
    const elapsed = Math.floor((new Date(progress._finishedAt) - new Date(progress._startedAt)) / 1000);
    timeHTML = `<div class="score-label" style="margin-top:0.5rem">${formatTimeHuman(elapsed)}</div>`;
  }

  // Free text note
  let freeTextHTML = "";
  if (hasFreeText) {
    freeTextHTML = `
      <div style="margin-top:1rem;padding:0.75rem;background:var(--primary-light);border-radius:6px;text-align:center;">
        <div style="font-weight:600;color:var(--primary);">Nota de redacción</div>
        <div style="font-size:0.9rem;color:var(--text-light);margin-top:0.25rem;">
          ${freeTextAnswered}/${freeTextTotal} secciones respondidas — Pendiente de revisión del profesor
        </div>
      </div>`;
  }

  // Botón de emergencia si focus mode no se pudo cerrar (sonda no respondió o falló).
  const focusEscapeHTML = !focusClosed
    ? `
      <div style="margin-top:1rem;padding:0.75rem;background:#fff3cd;border:1px solid #ffeaa7;border-radius:6px;text-align:center;">
        <div style="font-weight:600;color:#8a6d3b;">⚠ El modo foco no se cerró automáticamente</div>
        <button onclick="forceStopFocus(this)" style="margin-top:0.5rem;padding:0.5rem 1rem;background:#8a6d3b;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Cerrar modo foco ahora</button>
      </div>`
    : "";

  const summary = $("#score-summary");
  summary.innerHTML = `
    <div class="score-big ${scoreClass}">${autoPct}%</div>
    <div class="score-label">Nota automática: ${autoCorrect} de ${autoTotal} correctas</div>
    ${timeHTML}
    <div class="score-bar">
      <div class="score-fill" style="width:${autoPct}%;background:${color};"></div>
    </div>
    ${freeTextHTML}
    ${focusEscapeHTML}
    <div class="score-details">
      <table>${rows.join("")}</table>
    </div>
    <button class="btn-restart" onclick="restartGuide()">Volver al inicio de la guía</button>
  `;
  summary.classList.remove("hidden");
  summary.scrollIntoView({ behavior: "smooth" });
}

async function forceStopFocus(btn) {
  btn.disabled = true;
  btn.textContent = "Cerrando…";
  const ok = await stopExamFocus();
  btn.textContent = ok ? "✓ Modo foco cerrado" : "⚠ No se pudo cerrar — reinicia la sonda";
  if (ok) btn.style.background = "var(--success, #2a8a3e)";
}

function restartGuide() {
  currentSection = 0;
  renderCurrentSection();
  renderProgressBar();
  updateNav();
  $("#score-summary").classList.add("hidden");
  $("#section-nav").classList.remove("hidden");
  window.scrollTo(0, 0);
}

// ── Checkers ───────────────────────────────────────────────
const checkers = {
  highlight(section, exerciseDiv, ex) {
    const words = exerciseDiv.querySelectorAll(".highlight-word");
    let correct = 0;
    let total = 0;
    const answers = ex.answers || {};
    for (const key in answers) total++;

    words.forEach((w) => {
      const word = w.dataset.word;
      const selectedCat = parseInt(w.dataset.cat);
      const expectedCat = answers[word];

      if (expectedCat !== undefined) {
        const expectedIndex = section.categories.indexOf(expectedCat);
        if (selectedCat === expectedIndex) {
          correct++;
        } else {
          w.title = `Correcto: ${expectedCat}`;
        }
      }
    });

    return { correct, total };
  },

  classify(section, exerciseDiv, ex) {
    const answer = exerciseDiv.dataset.answer;
    return { correct: answer === ex.answer ? 1 : 0, total: 1 };
  },

  fill(section, exerciseDiv, ex) {
    const input = exerciseDiv.querySelector(".fill-input");
    const userAnswer = normalize(input.value);
    const expected = Array.isArray(ex.answer)
      ? ex.answer.map(normalize)
      : [normalize(String(ex.answer))];
    const isCorrect = expected.includes(userAnswer);
    input.classList.toggle("correct", isCorrect);
    input.classList.toggle("incorrect", !isCorrect && userAnswer !== "");
    return { correct: isCorrect ? 1 : 0, total: 1 };
  },

  true_false(section, exerciseDiv, ex) {
    const answer = exerciseDiv.dataset.answer;
    const expected = ex.answer ? "V" : "F";
    return { correct: answer === expected ? 1 : 0, total: 1 };
  },

  compare(section, exerciseDiv, ex) {
    const answer = exerciseDiv.dataset.answer;
    return { correct: answer === ex.answer ? 1 : 0, total: 1 };
  },

  multiple_choice(section, exerciseDiv, ex) {
    const answer = exerciseDiv.dataset.answer;
    return { correct: answer === String(ex.answer) ? 1 : 0, total: 1 };
  },

  free_text() {
    return { correct: 0, total: 0, skip: true };
  },

  reading() {
    return { correct: 0, total: 0, skip: true };
  },
};

// ── Helpers ────────────────────────────────────────────────
function getExpectedAnswer(section, ex) {
  switch (section.type) {
    case "classify": return ex.answer;
    case "fill": return Array.isArray(ex.answer) ? ex.answer[0] : ex.answer;
    case "true_false": return ex.answer ? "Verdadero" : "Falso";
    case "compare": return ex.answer;
    case "multiple_choice": {
      const letters = "ABCDEFGH";
      return `${letters[ex.answer]}. ${ex.options[ex.answer]}`;
    }
    default: return null;
  }
}

function normalize(str) {
  return str.trim().toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?$]/g, "")
    .replace(/\./g, "")
    .replace(/[−–—]/g, "-");  // normalizar guiones tipográficos a guión simple
}

function tokenize(text) {
  const tokens = [];
  const regex = /([a-záéíóúñü]+)|([^a-záéíóúñü\s]+)|(\s+)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) {
      tokens.push({ type: "word", text: match[1], clean: match[1].toLowerCase() });
    } else if (match[2]) {
      tokens.push({ type: "punct", text: match[2] });
    } else {
      tokens.push({ type: "space", text: match[3] });
    }
  }
  return tokens;
}
