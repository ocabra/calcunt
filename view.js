// calcunt frontend. No build step: reads the public, read-only Supabase REST
// API directly in the browser. The publishable key is safe to expose because
// RLS allows anon SELECT only; it grants no INSERT, UPDATE, or DELETE access.

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

const REST_PAGE_SIZE = 500;
const APP_TIME_ZONE = "America/Sao_Paulo";
const APP_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const MEAL_ORDER = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };
const MEALS = Object.keys(MEAL_ORDER);
const MEAL_TITLES = {
  breakfast: "Café da manhã",
  lunch: "Almoço",
  dinner: "Jantar",
  snack: "Lanche",
};
// fixed order: also the fixed color-slot order in calcunt.css (--series-1..4)
const METRICS = ["calories", "carbs_g", "protein_g", "fat_g"];
const METRIC_TITLES = {
  calories: "Calorias",
  carbs_g: "Carboidratos",
  protein_g: "Proteína",
  fat_g: "Gordura",
};
const METRIC_UNITS = {
  calories: "kcal",
  carbs_g: "g",
  protein_g: "g",
  fat_g: "g",
};

function log(...args) {
  console.log("[calcunt]", ...args);
}

function mealRank(meal) {
  return MEAL_ORDER.hasOwnProperty(meal) ? MEAL_ORDER[meal] : 99;
}

// Eating timestamps are timezone-free wall-clock values. Extract the calendar
// date from PostgREST's ISO representation without constructing a Date, which
// would incorrectly apply the browser's timezone.
function calendarDate(timestamp) {
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(timestamp)) {
    throw new Error(`invalid eating timestamp: ${timestamp}`);
  }
  return timestamp.slice(0, 10);
}

function clockTime(timestamp) {
  const match = timestamp.match(/^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
  if (!match) throw new Error(`invalid eating timestamp: ${timestamp}`);
  return `${match[1]}:${match[2]}`;
}

function clockMinutes(timestamp) {
  const [hours, minutes] = clockTime(timestamp).split(":").map(Number);
  return hours * 60 + minutes;
}

function displayDate(dateStr) {
  const [year, month, day] = dateStr.split("-");
  return `${day}-${month}-${year}`;
}

function appDate(date = new Date()) {
  const parts = Object.fromEntries(
    APP_DATE_FORMAT.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// goals.json is keyed by meal; day-level views (Today, Week, Month, All)
// use the daily total, which is just the sum across the four meals.
function dailyGoal(goals, metric) {
  return MEALS.reduce((sum, meal) => sum + (goals[meal]?.[metric] ?? 0), 0);
}

// -- fetching ---------------------------------------------------------

async function fetchTable(table, query) {
  const rows = [];
  for (let offset = 0; ; offset += REST_PAGE_SIZE) {
    const pageQuery = `${query}&limit=${REST_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${pageQuery}`, {
      cache: "no-store",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`fetch ${table} failed: ${res.status} ${detail}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < REST_PAGE_SIZE) break;
  }
  return rows;
}

async function fetchOptionalTable(table, query) {
  try {
    return await fetchTable(table, query);
  } catch (err) {
    console.warn(`[calcunt] optional table unavailable: ${table}`, err);
    return [];
  }
}

function enrichRows(rows, labels) {
  return rows.map((row) => {
    const label = labels.get(row.food_id);
    const factor = row.quantity_g / label.per_g;
    return {
      date: row.date,
      time: row.time,
      timeMinutes: row.timeMinutes,
      meal: row.meal,
      food_id: row.food_id,
      name: label.name,
      quantity_g: row.quantity_g,
      calories: label.calories * factor,
      carbs_g: label.carbs_g * factor,
      protein_g: label.protein_g * factor,
      fat_g: label.fat_g * factor,
      fiber_g: label.fiber_g * factor,
    };
  });
}

// -- eating-time scatter plot ---------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const TIMES_IGNORED_DATES = new Set(["2026-08-07", "2026-08-08", "2026-08-09"]);
const TIMES_MAX_DAYS = 60;

function svgElement(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function epochDay(date) {
  return Date.parse(`${date}T00:00:00Z`) / 86400000;
}

function renderTimes(enriched) {
  const status = document.getElementById("times-status");
  const card = document.getElementById("times-card");
  const chart = document.getElementById("times-chart");
  const legend = document.getElementById("times-legend");

  // A meal is stored as one row per food, so collapse rows sharing the same
  // day, meal, and wall-clock time into a single plotted event.
  const eventMap = new Map();
  for (const row of enriched) {
    if (TIMES_IGNORED_DATES.has(row.date)) continue;
    const key = `${row.date}|${row.meal}|${row.time}`;
    if (!eventMap.has(key)) eventMap.set(key, row);
  }
  let events = [...eventMap.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.timeMinutes - b.timeMinutes ||
      mealRank(a.meal) - mealRank(b.meal),
  );

  chart.innerHTML = "";
  legend.innerHTML = "";
  if (events.length === 0) {
    status.textContent = "nenhum horário registrado";
    status.hidden = false;
    card.hidden = true;
    return;
  }

  const latestEventDay = epochDay(events[events.length - 1].date);
  const firstVisibleDay = latestEventDay - TIMES_MAX_DAYS + 1;
  events = events.filter((event) => epochDay(event.date) >= firstVisibleDay);

  for (const meal of MEALS) {
    const item = document.createElement("span");
    item.className = "meal-legend-item";
    const dot = document.createElement("span");
    dot.className = `meal-dot meal-${meal}`;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(MEAL_TITLES[meal]));
    legend.appendChild(item);
  }

  const firstDay = epochDay(events[0].date);
  const lastDay = epochDay(events[events.length - 1].date);
  const dayCount = lastDay - firstDay + 1;
  const labelEvery = dayCount <= 14 ? 1 : dayCount <= 60 ? 5 : 7;
  const margin = { top: 18, right: 18, bottom: 32, left: 48 };
  const plotWidth = Math.max(
    560,
    Math.min(760, dayCount * (labelEvery === 1 ? 68 : 28)),
  );
  const plotHeight = 270;
  const width = margin.left + plotWidth + margin.right;
  const height = margin.top + plotHeight + margin.bottom;
  const x = (date) =>
    margin.left + ((epochDay(date) - firstDay + 0.5) / dayCount) * plotWidth;
  // Numeric time increases upward: midnight at the bottom, 24:00 at the top.
  const y = (minutes) =>
    margin.top + plotHeight - (minutes / 1440) * plotHeight;

  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-labelledby": "times-chart-title times-chart-description",
  });
  const title = svgElement("title", { id: "times-chart-title" });
  title.textContent = "Horários por dia e refeição";
  svg.appendChild(title);
  const description = svgElement("desc", { id: "times-chart-description" });
  description.textContent =
    "O dia fica no eixo horizontal e o horário fica no eixo vertical. As cores identificam café da manhã, almoço, jantar e lanche.";
  svg.appendChild(description);

  for (let hour = 0; hour <= 24; hour += 4) {
    const lineY = y(hour * 60);
    svg.appendChild(
      svgElement("line", {
        x1: margin.left,
        x2: margin.left + plotWidth,
        y1: lineY,
        y2: lineY,
        class: "time-grid-line",
      }),
    );
    const label = svgElement("text", {
      x: margin.left - 8,
      y: lineY + 3,
      class: "time-axis-label",
    });
    label.textContent = `${String(hour).padStart(2, "0")}:00`;
    svg.appendChild(label);
  }

  for (let offset = 0; offset < dayCount; offset += labelEvery) {
    const date = dateFromEpochDay(firstDay + offset);
    const label = svgElement("text", {
      x: x(date),
      y: margin.top + plotHeight + 20,
      class: "time-day-label",
    });
    label.textContent = dateShort(date);
    svg.appendChild(label);
  }
  if ((dayCount - 1) % labelEvery !== 0) {
    const label = svgElement("text", {
      x: x(events[events.length - 1].date),
      y: margin.top + plotHeight + 20,
      class: "time-day-label",
    });
    label.textContent = dateShort(events[events.length - 1].date);
    svg.appendChild(label);
  }

  for (const event of events) {
    const point = svgElement("circle", {
      cx: x(event.date),
      cy: y(event.timeMinutes),
      r: 5,
      class: `time-point meal-${event.meal}`,
    });
    const tip = svgElement("title");
    tip.textContent = `${displayDate(event.date)} · ${event.time} · ${MEAL_TITLES[event.meal]}`;
    point.appendChild(tip);
    svg.appendChild(point);
  }

  chart.appendChild(svg);
  status.hidden = true;
  card.hidden = false;
  log(
    `rendered eating-time scatter plot: ${events.length} meal events across ${dayCount} days`,
  );
}

// -- tabular view ---------------------------------------------------------

function renderTabular(enriched) {
  const body = document.getElementById("tabular-body");
  const card = document.getElementById("tabular-card");
  const status = document.getElementById("tabular-status");
  body.innerHTML = "";

  const dates = [...new Set(enriched.map((r) => r.date))].sort().reverse();
  log(`rendering tabular view: ${dates.length} days`);

  for (const date of dates) {
    const dayRows = enriched
      .filter((r) => r.date === date)
      .sort((a, b) => mealRank(a.meal) - mealRank(b.meal));

    const totals = {
      calories: 0,
      carbs_g: 0,
      protein_g: 0,
      fat_g: 0,
      fiber_g: 0,
    };

    for (const r of dayRows) {
      const tr = document.createElement("tr");
      const cells = [
        [displayDate(r.date), false],
        [r.meal, false],
        [r.name, false],
        [r.quantity_g, true],
        [r.calories.toFixed(0), true],
        [r.carbs_g.toFixed(1), true],
        [r.protein_g.toFixed(1), true],
        [r.fat_g.toFixed(1), true],
        [r.fiber_g.toFixed(1), true],
      ];
      for (const [val, isNum] of cells) {
        const td = document.createElement("td");
        if (isNum) td.className = "num";
        td.textContent = val;
        tr.appendChild(td);
      }
      body.appendChild(tr);

      for (const m of Object.keys(totals)) totals[m] += r[m];
    }

    const totalTr = document.createElement("tr");
    totalTr.className = "day-total";
    const totalCells = [
      [displayDate(date), false],
      ["total", false],
      ["", false],
      ["", true],
      [totals.calories.toFixed(0), true],
      [totals.carbs_g.toFixed(1), true],
      [totals.protein_g.toFixed(1), true],
      [totals.fat_g.toFixed(1), true],
      [totals.fiber_g.toFixed(1), true],
    ];
    for (const [val, isNum] of totalCells) {
      const td = document.createElement("td");
      if (isNum) td.className = "num";
      td.textContent = val;
      totalTr.appendChild(td);
    }
    body.appendChild(totalTr);
  }

  status.hidden = true;
  card.hidden = false;
}

// -- week / month bar charts ----------------------------------------------

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateFromEpochDay(day) {
  return fmtDate(new Date(day * 86400000));
}

function trailingDates(n) {
  const days = [];
  const today = epochDay(appDate());
  for (let i = n - 1; i >= 0; i--) {
    days.push(dateFromEpochDay(today - i));
  }
  return days;
}

function computeSeries(enriched, days) {
  const series = {};
  for (const metric of METRICS) series[metric] = days.map(() => 0);

  for (const r of enriched) {
    const idx = days.indexOf(r.date);
    if (idx === -1) continue;
    for (const metric of METRICS) series[metric][idx] += r[metric];
  }

  log(`computed totals for ${days[0]} .. ${days[days.length - 1]}`, series);
  return { days, series };
}

function trailingPeriods(periodDays, count) {
  const today = epochDay(appDate());
  const periods = [];
  for (let i = count - 1; i >= 0; i--) {
    const startDay = today - (i + 1) * periodDays + 1;
    const endDay = startDay + periodDays - 1;
    const start = dateFromEpochDay(startDay);
    const end = dateFromEpochDay(endDay);
    periods.push({
      days: trailingDatesForRange(startDay, endDay),
      label: dateShort(start),
      tooltip: `${dateShort(start)}-${dateShort(end)}`,
      goalDays: periodDays,
    });
  }
  return periods;
}

function trailingDatesForRange(startDay, endDay) {
  const days = [];
  for (let day = startDay; day <= endDay; day++) {
    days.push(dateFromEpochDay(day));
  }
  return days;
}

function computePeriodSeries(enriched, periods) {
  const series = {};
  for (const metric of METRICS) series[metric] = periods.map(() => 0);

  const periodByDate = new Map();
  periods.forEach((period, periodIndex) => {
    for (const day of period.days) periodByDate.set(day, periodIndex);
  });

  for (const row of enriched) {
    const idx = periodByDate.get(row.date);
    if (idx === undefined) continue;
    for (const metric of METRICS) series[metric][idx] += row[metric];
  }

  return { periods, series };
}

function metricStats(values) {
  const nonZero = values.slice(0, -1).filter((value) => value > 0);
  if (nonZero.length === 0) return { mean: 0, stddev: 0 };

  const mean = nonZero.reduce((sum, value) => sum + value, 0) / nonZero.length;
  const variance =
    nonZero.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) /
    nonZero.length;
  return { mean, stddev: Math.sqrt(variance) };
}

function movingAverageSeries(values, windowSize) {
  return values.map((_, index) => {
    if (index < windowSize - 1) return null;
    const window = values
      .slice(index - windowSize + 1, index + 1)
      .filter((value) => value > 0);
    if (window.length < windowSize) return null;
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

function latestValue(values) {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null && values[i] !== undefined) return values[i];
  }
  return null;
}

// path for a bar with rounded top corners, square baseline (dataviz mark spec)
function roundedTopBarPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return (
    `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} ` +
    `L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
  );
}

function weekdayShort(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" });
}

function weekdayName(dateStr) {
  const names = [
    "Domingo",
    "Segunda",
    "Terça",
    "Quarta",
    "Quinta",
    "Sexta",
    "Sábado",
  ];
  return names[new Date(dateStr + "T00:00:00Z").getUTCDay()];
}

function dateShort(dateStr) {
  const [, month, day] = dateStr.split("-");
  return `${day}/${month}`;
}

function renderBarChart(metric, values, days, goal, opts = {}) {
  const labelEvery = opts.labelEvery ?? 1;
  const labelFormat = opts.labelFormat ?? "weekday";
  const labels = opts.labels ?? days;
  const tooltipLabels = opts.tooltipLabels ?? days.map(displayDate);
  const currentLabel = opts.currentLabel ?? "Hoje";
  const movingAverageWindow = opts.movingAverageWindow ?? null;
  const movingAverages = movingAverageWindow
    ? movingAverageSeries(values, movingAverageWindow)
    : [];
  const latestMovingAverage = latestValue(movingAverages);
  const movingAverageLabel = movingAverageWindow
    ? `mm${movingAverageWindow} - meta`
    : null;
  const unit = METRIC_UNITS[metric];
  const width = 300;
  const height = 150;
  const chartW = 292;
  const chartH = 96;
  const marginLeft = 4;
  const marginTop = 6;
  const slotWidth = chartW / values.length;
  const barWidth = Math.min(24, slotWidth * 0.55);
  const todayIndex = values.length - 1;
  const maxVal =
    Math.max(
      goal,
      latestMovingAverage ?? 0,
      ...movingAverages.filter((value) => value !== null),
      ...values,
      1,
    ) * 1.15;
  const y = (v) => chartH - (v / maxVal) * chartH;
  const clampedY = (v) => Math.max(0, Math.min(chartH, y(v)));
  const stats = metricStats(values);

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const plot = document.createElementNS(svgNS, "g");
  plot.setAttribute("transform", `translate(${marginLeft},${marginTop})`);
  svg.appendChild(plot);

  const statsLayer = document.createElementNS(svgNS, "g");
  statsLayer.setAttribute("class", "stats-layer");
  statsLayer.setAttribute("display", "none");
  if (stats.mean > 0) {
    const bandTop = clampedY(stats.mean + stats.stddev);
    const bandBottom = clampedY(Math.max(0, stats.mean - stats.stddev));
    const band = document.createElementNS(svgNS, "rect");
    band.setAttribute("x", 0);
    band.setAttribute("y", Math.min(bandTop, bandBottom));
    band.setAttribute("width", chartW);
    band.setAttribute("height", Math.abs(bandBottom - bandTop));
    band.setAttribute("class", "stats-band");
    statsLayer.appendChild(band);

    const meanLine = document.createElementNS(svgNS, "line");
    meanLine.setAttribute("x1", 0);
    meanLine.setAttribute("x2", chartW);
    meanLine.setAttribute("y1", clampedY(stats.mean));
    meanLine.setAttribute("y2", clampedY(stats.mean));
    meanLine.setAttribute("class", "stats-mean-line");
    statsLayer.appendChild(meanLine);
  }
  plot.appendChild(statsLayer);

  values.forEach((val, i) => {
    const isToday = i === todayIndex;
    const x = i * slotWidth + (slotWidth - barWidth) / 2;
    const barY = y(val);
    const barH = Math.max(chartH - barY, 0);

    if (barH > 0) {
      const bar = document.createElementNS(svgNS, "path");
      bar.setAttribute("d", roundedTopBarPath(x, barY, barWidth, barH, 4));
      bar.setAttribute("class", `bar-${metric}${isToday ? "" : " bar-muted"}`);
      bar.dataset.barTooltip = `${tooltipLabels[i]} · ${Math.round(val)} ${unit}`;
      plot.appendChild(bar);
    }

    // label selectively: today always, others every `labelEvery` bars
    // counting back from today, to avoid overlap on dense charts (month view)
    if (isToday || (todayIndex - i) % labelEvery === 0) {
      const dayLabel = document.createElementNS(svgNS, "text");
      dayLabel.setAttribute("x", x + barWidth / 2);
      dayLabel.setAttribute("y", chartH + 14);
      dayLabel.setAttribute("class", `day-label${isToday ? " today" : ""}`);
      dayLabel.textContent = isToday
        ? currentLabel
        : labelFormat === "date"
          ? dateShort(days[i])
          : labelFormat === "label"
            ? labels[i]
            : weekdayShort(days[i]);
      plot.appendChild(dayLabel);
    }
  });

  const movingAverageLayer = document.createElementNS(svgNS, "g");
  movingAverageLayer.setAttribute("class", "moving-average-layer");
  movingAverageLayer.setAttribute("display", "none");
  if (latestMovingAverage !== null) {
    let segmentPoints = [];
    function appendSegment() {
      if (segmentPoints.length < 2) {
        segmentPoints = [];
        return;
      }
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute(
        "d",
        segmentPoints
          .map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"} ${point.x} ${point.y}`)
          .join(" "),
      );
      path.setAttribute("class", "moving-average-line");
      movingAverageLayer.appendChild(path);
      segmentPoints = [];
    }

    movingAverages.forEach((value, index) => {
      if (value === null) {
        appendSegment();
        return;
      }
      const pointX = index * slotWidth + slotWidth / 2;
      const pointY = clampedY(value);
      segmentPoints.push({ x: pointX, y: pointY });

      const point = document.createElementNS(svgNS, "circle");
      point.setAttribute("cx", pointX);
      point.setAttribute("cy", pointY);
      point.setAttribute("r", 2.3);
      point.setAttribute("class", "moving-average-point");
      movingAverageLayer.appendChild(point);
    });
    appendSegment();
  }
  plot.appendChild(movingAverageLayer);

  const goalY = y(goal);
  const goalLine = document.createElementNS(svgNS, "line");
  goalLine.setAttribute("x1", 0);
  goalLine.setAttribute("x2", chartW);
  goalLine.setAttribute("y1", goalY);
  goalLine.setAttribute("y2", goalY);
  goalLine.setAttribute("class", "goal-line");
  plot.appendChild(goalLine);

  const goalLabel = document.createElementNS(svgNS, "text");
  goalLabel.setAttribute("x", 0);
  goalLabel.setAttribute("y", goalY - 4);
  goalLabel.setAttribute("class", "goal-label");
  goalLabel.textContent = `meta ${goal}`;
  plot.appendChild(goalLabel);

  const card = document.createElement("div");
  card.className = "card chart-card";

  const header = document.createElement("div");
  header.className = "chart-header";
  const titleRow = document.createElement("div");
  titleRow.className = "chart-title-row";
  const dot = document.createElement("span");
  dot.className = `chart-dot chart-dot-${metric}`;
  titleRow.appendChild(dot);
  titleRow.appendChild(document.createTextNode(METRIC_TITLES[metric]));
  header.appendChild(titleRow);
  const actions = document.createElement("div");
  actions.className = "chart-actions";
  const statsButton = document.createElement("button");
  statsButton.className = "chart-stats";
  statsButton.type = "button";
  statsButton.setAttribute("aria-pressed", "false");
  statsButton.disabled = stats.mean === 0;
  statsButton.textContent = `μ ${Math.round(stats.mean)} ± σ ${Math.round(stats.stddev)}`;
  statsButton.addEventListener("click", () => {
    const isOn = statsButton.getAttribute("aria-pressed") === "true";
    const next = !isOn;
    statsButton.setAttribute("aria-pressed", String(next));
    if (next) {
      statsLayer.removeAttribute("display");
    } else {
      statsLayer.setAttribute("display", "none");
    }
  });
  actions.appendChild(statsButton);
  if (movingAverageLabel) {
    const deltaButton = document.createElement("button");
    deltaButton.className = "chart-stats";
    deltaButton.type = "button";
    deltaButton.setAttribute("aria-pressed", "false");
    deltaButton.disabled = latestMovingAverage === null;
    deltaButton.textContent = movingAverageLabel;
    if (latestMovingAverage !== null) {
      const delta = latestMovingAverage - goal;
      deltaButton.title = `${delta >= 0 ? "+" : ""}${Math.round(delta)} ${unit}`;
    }
    deltaButton.addEventListener("click", () => {
      const isOn = deltaButton.getAttribute("aria-pressed") === "true";
      const next = !isOn;
      deltaButton.setAttribute("aria-pressed", String(next));
      if (next) {
        movingAverageLayer.removeAttribute("display");
      } else {
        movingAverageLayer.setAttribute("display", "none");
      }
    });
    actions.appendChild(deltaButton);
  }
  header.appendChild(actions);
  card.appendChild(header);

  card.appendChild(svg);
  return card;
}

function initBarTooltip() {
  const tooltip = document.getElementById("bar-tooltip");
  if (!tooltip) return;

  function show(event) {
    const target = event.target.closest?.("[data-bar-tooltip]");
    if (!target) return;
    tooltip.textContent = target.dataset.barTooltip;
    tooltip.hidden = false;
    move(event);
  }

  function move(event) {
    if (tooltip.hidden) return;
    const offset = 12;
    tooltip.style.left = `${event.clientX + offset}px`;
    tooltip.style.top = `${event.clientY + offset}px`;
  }

  function hide() {
    tooltip.hidden = true;
  }

  document.addEventListener("pointerover", show);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerout", (event) => {
    if (event.target.closest?.("[data-bar-tooltip]")) hide();
  });
}

// renders the Week and Month tabs: same rounded-bar-plus-goal-line chart,
// just a different trailing window and label density. In "aggregate"
// granularity it's the usual 4 cards (one per metric, summed across meals).
// In "meal" granularity it's 4 groups of 4 cards, one group per meal, each
// scoped to that meal's own entries and that meal's own goal.
function renderMetricGrid(
  containerId,
  statusId,
  enriched,
  days,
  goals,
  opts,
  granularity,
) {
  const container = document.getElementById(containerId);
  const status = document.getElementById(statusId);
  container.innerHTML = "";

  if (granularity === "meal") {
    container.classList.add("stacked-groups");
    for (const meal of MEALS) {
      const mealRows = enriched.filter((r) => r.meal === meal);
      const mealSeries = computeSeries(
        mealRows,
        days,
      ).series;

      const heading = document.createElement("h2");
      heading.className = "meal-group-heading";
      heading.textContent = MEAL_TITLES[meal];
      container.appendChild(heading);

      const group = document.createElement("div");
      group.className = "metric-grid";
      for (const metric of METRICS) {
        const goal = goals[meal]?.[metric] ?? 0;
        const chartOpts = { ...opts };
        group.appendChild(
          renderBarChart(metric, mealSeries[metric], days, goal, chartOpts),
        );
      }
      container.appendChild(group);
    }
  } else {
    container.classList.remove("stacked-groups");
    const { series } = computeSeries(enriched, days);
    for (const metric of METRICS) {
      const chartOpts = { ...opts };
      container.appendChild(
        renderBarChart(
          metric,
          series[metric],
          days,
          dailyGoal(goals, metric),
          chartOpts,
        ),
      );
    }
  }

  log(`rendered ${containerId} (${granularity})`);
  status.hidden = true;
  container.hidden = false;
}

function renderYearGrid(
  containerId,
  statusId,
  enriched,
  periods,
  goals,
  granularity,
) {
  const container = document.getElementById(containerId);
  const status = document.getElementById(statusId);
  container.innerHTML = "";

  const opts = {
    labelEvery: 4,
    labelFormat: "label",
    labels: periods.map((period) => period.label),
    tooltipLabels: periods.map((period) => period.tooltip),
    currentLabel: "Atual",
  };

  if (granularity === "meal") {
    container.classList.add("stacked-groups");
    for (const meal of MEALS) {
      const mealSeries = computePeriodSeries(
        enriched.filter((r) => r.meal === meal),
        periods,
      ).series;

      const heading = document.createElement("h2");
      heading.className = "meal-group-heading";
      heading.textContent = MEAL_TITLES[meal];
      container.appendChild(heading);

      const group = document.createElement("div");
      group.className = "metric-grid";
      for (const metric of METRICS) {
        const goal = (goals[meal]?.[metric] ?? 0) * periods[0].goalDays;
        group.appendChild(
          renderBarChart(
            metric,
            mealSeries[metric],
            periods.map((p) => p.days[0]),
            goal,
            opts,
          ),
        );
      }
      container.appendChild(group);
    }
  } else {
    container.classList.remove("stacked-groups");
    const { series } = computePeriodSeries(enriched, periods);
    for (const metric of METRICS) {
      const goal = dailyGoal(goals, metric) * periods[0].goalDays;
      container.appendChild(
        renderBarChart(
          metric,
          series[metric],
          periods.map((p) => p.days[0]),
          goal,
          opts,
        ),
      );
    }
  }

  log(`rendered ${containerId} (${granularity})`);
  status.hidden = true;
  container.hidden = false;
}

// -- today: today's totals vs goal, as activity rings ----------------------

// fixed order, matches --series-1..4 in calcunt.css
const METRIC_SERIES_VAR = {
  calories: "--series-1",
  carbs_g: "--series-2",
  protein_g: "--series-3",
  fat_g: "--series-4",
};
const RING_ANIMATION_MS = 800;

function metricColorHex(metric) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(METRIC_SERIES_VAR[metric])
    .trim();
}

function drawRingProgress(svg, metric, value, goal) {
  const unit = METRIC_UNITS[metric];
  const rawProgress = goal > 0 ? value / goal : 0;
  svg.innerHTML = "";

  const titleEl = document.createElementNS(SVG_NS, "title");
  titleEl.textContent = `${Math.round(value)} / ${goal} ${unit} (${Math.round(rawProgress * 100)}%)`;
  svg.appendChild(titleEl);

  // activity-ring.js: ported from the activity-rings reference project —
  // draws the ring itself (arc, gradient sheen, and the shadowed rounded
  // tip that keeps spinning past 100% instead of stopping flat)
  drawActivityRing(svg, {
    value: rawProgress,
    color: metricColorHex(metric),
    cx: 50,
    cy: 50,
    radius: 44,
    width: 10,
  });

  const percentLabel = document.createElementNS(SVG_NS, "text");
  percentLabel.setAttribute("x", 50);
  percentLabel.setAttribute("y", 50);
  percentLabel.setAttribute("dominant-baseline", "central");
  percentLabel.setAttribute("class", "ring-percent");
  percentLabel.textContent = `${Math.round(rawProgress * 100)}%`;
  svg.appendChild(percentLabel);
}

function updateRingCaption(valueSpan, suffixNode, value, goal, metric) {
  const unit = METRIC_UNITS[metric];
  const deviationPct = goal > 0 ? (Math.abs(value - goal) / goal) * 100 : 0;
  valueSpan.className = `value dev-text-${deviationBucket(deviationPct)}`;
  valueSpan.textContent = Math.round(value);
  suffixNode.textContent = ` / ${goal} ${unit}`;
}

function animateRingCard(parts, metric, finalValue, goal) {
  const startTime = performance.now();

  function frame(now) {
    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / RING_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = finalValue * eased;
    drawRingProgress(parts.svg, metric, value, goal);
    updateRingCaption(parts.valueSpan, parts.suffixNode, value, goal, metric);
    if (t < 1) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function renderRingCard(metric, value, goal, opts = {}) {
  const initialValue = opts.animate ? 0 : value;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  drawRingProgress(svg, metric, initialValue, goal);

  const card = document.createElement("div");
  card.className = "card chart-card ring-card";

  const header = document.createElement("div");
  header.className = "chart-header";
  const dot = document.createElement("span");
  dot.className = `chart-dot chart-dot-${metric}`;
  header.appendChild(dot);
  header.appendChild(document.createTextNode(METRIC_TITLES[metric]));
  card.appendChild(header);

  card.appendChild(svg);

  const caption = document.createElement("div");
  caption.className = "ring-caption";
  const valueSpan = document.createElement("span");
  const suffixNode = document.createTextNode("");
  updateRingCaption(valueSpan, suffixNode, initialValue, goal, metric);
  caption.appendChild(valueSpan);
  caption.appendChild(suffixNode);
  card.appendChild(caption);

  if (opts.animate) {
    animateRingCard({ svg, valueSpan, suffixNode }, metric, value, goal);
  }

  return card;
}

function renderToday(enriched, goals, granularity, opts = {}) {
  const container = document.getElementById("today-content");
  const status = document.getElementById("today-status");
  container.innerHTML = "";

  const today = appDate();
  const todaysRows = enriched.filter((r) => r.date === today);
  log(`today: ${todaysRows.length} entries today (${today}, ${granularity})`);

  if (granularity === "meal") {
    container.classList.add("stacked-groups");
    for (const meal of MEALS) {
      const mealRows = todaysRows.filter((r) => r.meal === meal);

      const heading = document.createElement("h2");
      heading.className = "meal-group-heading";
      heading.textContent = MEAL_TITLES[meal];
      container.appendChild(heading);

      const group = document.createElement("div");
      group.className = "metric-grid";
      for (const metric of METRICS) {
        const value = mealRows.reduce((sum, r) => sum + r[metric], 0);
        const goal = goals[meal]?.[metric] ?? 0;
        group.appendChild(renderRingCard(metric, value, goal, opts));
      }
      container.appendChild(group);
    }
  } else {
    container.classList.remove("stacked-groups");
    for (const metric of METRICS) {
      const value = todaysRows.reduce((sum, r) => sum + r[metric], 0);
      const card = renderRingCard(
        metric,
        value,
        dailyGoal(goals, metric),
        opts,
      );
      container.appendChild(card);
    }
  }

  log("rendered today rings");
  status.hidden = true;
  container.hidden = false;
}

function renderEmptyToday() {
  const emptyGoals = Object.fromEntries(
    MEALS.map((meal) => [
      meal,
      Object.fromEntries(METRICS.map((metric) => [metric, 0])),
    ]),
  );
  renderToday([], emptyGoals, "aggregate");
}

// -- all: github-style heatmap, colored by deviation from goal ------------
//
// Anchored the same way github does it: the rightmost column is the
// current week (Sunday .. today, no cells past today), and columns extend
// backward in full Sunday-Saturday weeks from there. That means the
// leftmost day is always a Sunday, so there are never leading blank
// cells to pad out — no off-by-one gap at either edge.
//
// The number of weeks shown is however many full columns fit the card's
// rendered width, so it has to be measured after the card is actually in
// the (visible) DOM — see renderAll's lazy call from initTabs.

// keep in sync with .heatmap-grid / .heatmap-cell in calcunt.css
const HEATMAP_CELL = 12;
const HEATMAP_GAP = 3;

// thresholds and names must match --dev-* in calcunt.css exactly — that's
// the single place colors are defined; this is just where the boundaries
// (percentage points of |actual - goal| / goal) live.
function deviationBucket(pct) {
  if (pct <= 10) return "good";
  if (pct <= 20) return "ok";
  if (pct <= 30) return "bad";
  return "terrible";
}

function createHeatmapCardShell(metric) {
  const card = document.createElement("div");
  card.className = "card chart-card";

  const header = document.createElement("div");
  header.className = "chart-header";
  const titleRow = document.createElement("div");
  titleRow.className = "chart-title-row";
  const dot = document.createElement("span");
  dot.className = `chart-dot chart-dot-${metric}`;
  titleRow.appendChild(dot);
  titleRow.appendChild(document.createTextNode(METRIC_TITLES[metric]));
  header.appendChild(titleRow);
  card.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "heatmap-grid";
  card.appendChild(grid);

  return { card, grid };
}

// grid is an empty block-level grid container, so its clientWidth is the
// card's real available content width regardless of how many cells it
// ends up holding — must be called after `grid` is attached to a visible
// (non-`hidden`) part of the DOM, or this reads 0.
function weeksThatFit(grid) {
  const width = grid.clientWidth;
  return Math.max(
    1,
    Math.floor((width + HEATMAP_GAP) / (HEATMAP_CELL + HEATMAP_GAP)),
  );
}

function populateHeatmapGrid(grid, metric, days, enriched, goal) {
  const unit = METRIC_UNITS[metric];
  const todayStr = appDate();
  grid.innerHTML = "";

  for (const date of days) {
    const dayRows = enriched.filter((r) => r.date === date);
    const cell = document.createElement("div");
    cell.className = "heatmap-cell";

    if (dayRows.length === 0) {
      cell.classList.add("dev-none");
      cell.title = `${displayDate(date)}: sem dados`;
    } else {
      const actual = dayRows.reduce((sum, r) => sum + r[metric], 0);
      const pct = goal > 0 ? (Math.abs(actual - goal) / goal) * 100 : 0;
      cell.classList.add(`dev-${deviationBucket(pct)}`);
      cell.title = `${displayDate(date)}: ${Math.round(actual)} / ${goal} ${unit} (${pct.toFixed(0)}% fora da meta)`;
    }

    if (date === todayStr) cell.classList.add("today");
    grid.appendChild(cell);
  }
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildDailySummaries(enriched, goals, days) {
  const metricGoals = Object.fromEntries(
    METRICS.map((metric) => [metric, dailyGoal(goals, metric)]),
  );

  return days.map((date) => {
    const rows = enriched.filter((row) => row.date === date);
    const totals = Object.fromEntries(METRICS.map((metric) => [metric, 0]));
    const mealKeys = new Set();
    for (const row of rows) {
      for (const metric of METRICS) totals[metric] += row[metric];
      mealKeys.add(`${row.date}|${row.meal}|${row.time}`);
    }

    const deviations = METRICS.map((metric) => {
      const goal = metricGoals[metric];
      if (goal <= 0) return null;
      return (Math.abs(totals[metric] - goal) / goal) * 100;
    }).filter((value) => value !== null);
    const adherence =
      deviations.length === 0
        ? 0
        : average(deviations.map((pct) => Math.max(0, 100 - pct)));

    return {
      date,
      rows,
      mealCount: mealKeys.size,
      totals,
      logged: rows.length > 0,
      adherence,
      withinTarget: rows.length > 0 && deviations.every((pct) => pct <= 10),
      proteinTarget:
        rows.length > 0 && totals.protein_g >= metricGoals.protein_g,
      calorieDelta: totals.calories - metricGoals.calories,
    };
  });
}

function createInsightCard(title, featured, rows = [], opts = {}) {
  const card = document.createElement("div");
  card.className = "card chart-card insight-card";

  const header = document.createElement("div");
  header.className = "chart-header";
  const titleRow = document.createElement("div");
  titleRow.className = "chart-title-row";
  titleRow.textContent = title;
  header.appendChild(titleRow);
  if (opts.periodLabel) {
    const period = document.createElement("span");
    period.className = "insight-period";
    period.textContent = opts.periodLabel;
    header.appendChild(period);
  }
  card.appendChild(header);

  const value = document.createElement("div");
  value.className = "insight-value";
  if (opts.valueClass) value.classList.add(opts.valueClass);
  value.textContent = featured;
  card.appendChild(value);

  const list = document.createElement("div");
  list.className = "insight-list";
  for (const [label, itemValue] of rows) {
    const row = document.createElement("div");
    row.className = "insight-row";

    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    const valueEl = document.createElement("strong");
    valueEl.textContent = itemValue;

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    list.appendChild(row);
  }
  card.appendChild(list);

  return card;
}

function chartRange(values, fallbackMin, fallbackMax, opts = {}) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (nums.length === 0) return { min: fallbackMin, max: fallbackMax };

  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    const pad = Math.max(Math.abs(max) * 0.05, 1);
    min -= pad;
    max += pad;
  }

  const pad = (max - min) * 0.12;
  min = opts.floorZero ? Math.max(0, min - pad) : min - pad;
  max += pad;
  return { min, max };
}

function rollingAverageFromPreviousLoggedDays(values, windowSize) {
  const lastIndex = values.length - 1;
  return values.map((_, index) => {
    const previousLogged = values
      .slice(0, index)
      .filter((value) => value > 0);
    if (previousLogged.length < windowSize && index !== lastIndex) return null;
    const window = previousLogged.slice(-windowSize);
    if (window.length === 0) return null;
    return average(window);
  });
}

function metricAdherence(day, goals, metric) {
  const goal = dailyGoal(goals, metric);
  if (!day.logged || goal <= 0) return null;
  const pct = (Math.abs(day.totals[metric] - goal) / goal) * 100;
  return Math.max(0, 100 - pct);
}

function periodMetricAdherence(days, goals, metric) {
  const values = days
    .map((day) => metricAdherence(day, goals, metric))
    .filter((value) => value !== null);
  return Math.round(average(values));
}

function createPeriodSummaryCard(periodLabel, periodDays, goals) {
  const loggedDays = periodDays.filter((day) => day.logged);
  const bestDay = loggedDays.reduce(
    (best, day) => (!best || day.adherence > best.adherence ? day : best),
    null,
  );
  const worstDay = loggedDays.reduce(
    (worst, day) => (!worst || day.adherence < worst.adherence ? day : worst),
    null,
  );
  const overallAdherence = Math.round(
    average(loggedDays.map((day) => day.adherence)),
  );
  const dayLabel = (day) => {
    const adherence = `${Math.round(day.adherence)}%`;
    if (periodLabel === "semana") {
      return `${weekdayName(day.date)} · ${adherence}`;
    }
    return `${displayDate(day.date)} · ${weekdayName(day.date)} · ${adherence}`;
  };

  return createInsightCard(
    "Aderência",
    `${overallAdherence}%`,
    [
      ["CAL", `${periodMetricAdherence(periodDays, goals, "calories")}%`],
      ["CARB", `${periodMetricAdherence(periodDays, goals, "carbs_g")}%`],
      ["PROT", `${periodMetricAdherence(periodDays, goals, "protein_g")}%`],
      ["GORD", `${periodMetricAdherence(periodDays, goals, "fat_g")}%`],
      [
        "melhor dia",
        bestDay ? dayLabel(bestDay) : "0",
      ],
      [
        "pior dia",
        worstDay ? dayLabel(worstDay) : "0",
      ],
    ],
    { periodLabel, valueClass: `dev-text-${deviationBucket(100 - overallAdherence)}` },
  );
}

function polylinePoints(points) {
  return points
    .filter((point) => point.value !== null && point.value !== undefined)
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
}

function createWeightCaloriesChartCard(completeDays, weights) {
  const chartDays = completeDays.slice(-30);
  const calories = chartDays.map((day) =>
    day.logged ? day.totals.calories : null,
  );
  const calorieMm7 = rollingAverageFromPreviousLoggedDays(calories, 7);
  const weightByDate = new Map(weights.map((entry) => [entry.date, entry]));
  const weightPoints = chartDays
    .map((day, index) => ({
      index,
      date: day.date,
      value: weightByDate.get(day.date)?.weight_kg ?? null,
    }))
    .filter((point) => point.value !== null);
  const hasWeights = weightPoints.length > 0;

  const card = document.createElement("div");
  card.className = "card chart-card weight-calories-card";

  const header = document.createElement("div");
  header.className = "chart-header";

  const legend = document.createElement("div");
  legend.className = "trend-chart-legend";
  for (const [label, className] of [
    ["mm7 kcal", "trend-dot-calories"],
    ["peso", "trend-dot-weight"],
  ]) {
    const item = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = `trend-dot ${className}`;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  }
  header.appendChild(legend);
  card.appendChild(header);

  const width = 640;
  const height = 240;
  const margin = { top: 18, right: 46, bottom: 30, left: 46 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const x = (index) =>
    margin.left +
    (chartDays.length <= 1 ? 0.5 : index / (chartDays.length - 1)) * plotW;
  const calorieRange = chartRange(calorieMm7, 0, 1, { floorZero: true });
  const weightRange = chartRange(
    weightPoints.map((point) => point.value),
    0,
    1,
  );
  const yCalories = (value) =>
    margin.top +
    plotH -
    ((value - calorieRange.min) / (calorieRange.max - calorieRange.min)) *
      plotH;
  const yWeight = (value) =>
    margin.top +
    plotH -
    ((value - weightRange.min) / (weightRange.max - weightRange.min)) * plotH;

  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "weight-calories-chart",
    role: "img",
    "aria-labelledby": "weight-calories-title weight-calories-description",
  });
  const title = svgElement("title", { id: "weight-calories-title" });
  title.textContent = "Peso x calorias";
  svg.appendChild(title);
  const description = svgElement("desc", {
    id: "weight-calories-description",
  });
  description.textContent =
    "Linha de média móvel de calorias e linha de peso corporal por dia.";
  svg.appendChild(description);

  for (let tick = 0; tick <= 2; tick++) {
    const ratio = tick / 2;
    const y = margin.top + plotH - ratio * plotH;
    svg.appendChild(
      svgElement("line", {
        x1: margin.left,
        x2: width - margin.right,
        y1: y,
        y2: y,
        class: "trend-grid-line",
      }),
    );

    const calorieLabel = svgElement("text", {
      x: margin.left - 8,
      y: y + 3,
      class: "trend-axis-label trend-axis-left",
    });
    calorieLabel.textContent = Math.round(
      calorieRange.min + ratio * (calorieRange.max - calorieRange.min),
    );
    svg.appendChild(calorieLabel);

    if (hasWeights) {
      const weightLabel = svgElement("text", {
        x: width - margin.right + 8,
        y: y + 3,
        class: "trend-axis-label trend-axis-right",
      });
      weightLabel.textContent = (
        weightRange.min +
        ratio * (weightRange.max - weightRange.min)
      ).toFixed(1);
      svg.appendChild(weightLabel);
    }
  }

  const caloriePoints = calorieMm7.map((value, index) => ({
    index,
    value,
    x: x(index),
    y: value === null ? null : yCalories(value),
  }));
  const calorieLine = svgElement("polyline", {
    points: polylinePoints(caloriePoints),
    class: "trend-calorie-line",
  });
  svg.appendChild(calorieLine);
  for (const point of caloriePoints.filter((p) => p.value !== null)) {
    const circle = svgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 3.2,
      class: "trend-calorie-point",
    });
    const tip = svgElement("title");
    tip.textContent = `${displayDate(chartDays[point.index].date)} · ${Math.round(point.value)} kcal`;
    circle.appendChild(tip);
    svg.appendChild(circle);
  }

  const plottedWeightPoints = weightPoints.map((point) => ({
    ...point,
    x: x(point.index),
    y: yWeight(point.value),
  }));
  if (plottedWeightPoints.length >= 2) {
    svg.appendChild(
      svgElement("polyline", {
        points: polylinePoints(plottedWeightPoints),
        class: "trend-weight-line",
      }),
    );
  }
  for (const point of plottedWeightPoints) {
    const circle = svgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 3.2,
      class: "trend-weight-point",
    });
    const tip = svgElement("title");
    tip.textContent = `${displayDate(point.date)} · ${point.value.toFixed(1)} kg`;
    circle.appendChild(tip);
    svg.appendChild(circle);
  }

  for (const index of new Set([
    0,
    Math.floor((chartDays.length - 1) / 2),
    chartDays.length - 1,
  ])) {
    const day = chartDays[index];
    if (!day) continue;
    const label = svgElement("text", {
      x: x(index),
      y: height - 8,
      class: "trend-day-label",
    });
    label.textContent = dateShort(day.date);
    svg.appendChild(label);
  }

  card.appendChild(svg);
  return card;
}

function renderTrendInsights(container, enriched, goals, days, weights = []) {
  container.innerHTML = "";
  const today = appDate();
  const completeDays = buildDailySummaries(enriched, goals, days).filter(
    (day) => day.date < today,
  );
  container.appendChild(
    createPeriodSummaryCard("semana", completeDays.slice(-7), goals),
  );
  container.appendChild(
    createPeriodSummaryCard("mês", completeDays.slice(-30), goals),
  );
  container.appendChild(createWeightCaloriesChartCard(completeDays, weights));

  container.hidden = false;
}

// worst -> best, with the bucket's threshold for a hover tooltip (a fast
// custom one — see .dev-legend-swatch::after — not the native `title`
// attribute, which has a browser-imposed ~1s+ delay with no way to tune it)
const DEVIATION_LEGEND = [
  { bucket: "terrible", label: "Terrível (>30% fora da meta)" },
  { bucket: "bad", label: "Ruim (20-30% fora da meta)" },
  { bucket: "ok", label: "Ok (10-20% fora da meta)" },
  { bucket: "good", label: "Bom (≤10% fora da meta)" },
];

function renderDeviationLegend(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  const worstLabel = document.createElement("span");
  worstLabel.className = "dev-legend-label";
  worstLabel.textContent = "Pior";
  container.appendChild(worstLabel);

  for (const { bucket, label } of DEVIATION_LEGEND) {
    const swatch = document.createElement("span");
    swatch.className = `dev-legend-swatch dev-${bucket}`;
    swatch.setAttribute("data-tooltip", label);
    container.appendChild(swatch);
  }

  const bestLabel = document.createElement("span");
  bestLabel.className = "dev-legend-label";
  bestLabel.textContent = "Melhor";
  container.appendChild(bestLabel);

  container.hidden = false;
}

function renderAll(enriched, goals, weights = []) {
  const container = document.getElementById("all-content");
  const status = document.getElementById("all-status");
  container.innerHTML = "";
  status.hidden = true;
  container.hidden = false;
  // renderDeviationLegend("all-legend");
  document.getElementById("all-legend").hidden = true;

  const shells = METRICS.map((metric) => ({
    metric,
    ...createHeatmapCardShell(metric),
  }));
  for (const { card } of shells) container.appendChild(card);

  const weeks = weeksThatFit(shells[0].grid);
  const today = appDate();
  const todayWeekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const totalDays = (weeks - 1) * 7 + (todayWeekday + 1); // anchor to Sunday..today
  const days = trailingDates(totalDays);

  for (const { metric, grid } of shells) {
    populateHeatmapGrid(grid, metric, days, enriched, dailyGoal(goals, metric));
  }
  renderTrendInsights(
    document.getElementById("trend-insights"),
    enriched,
    goals,
    days,
    weights,
  );

  log(
    `rendered all-view heatmaps: ${weeks} weeks (${days[0]} .. ${days[days.length - 1]})`,
  );
}

// -- tabs -------------------------------------------------------------

// the "All" heatmap needs its real rendered width to pick how many weeks
// fit, which only exists once its panel is actually visible — so it's
// (re)rendered on every visit to that tab instead of once at load time,
// via onShowAll.
const GRANULARITY_TABS = ["today", "week", "month", "year"];

function initTabs(onShowTimes, onShowTrends) {
  const buttons = document.querySelectorAll("#main-tabs .tab-btn");
  const mealToggle = document.getElementById("meal-toggle");

  function activate(btn) {
    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== `tab-${target}`;
    });
    buttons.forEach((b) => b.classList.toggle("active", b === btn));
    const showToggle = GRANULARITY_TABS.includes(target);
    mealToggle.classList.toggle("meal-toggle-inactive", !showToggle);
    mealToggle.tabIndex = showToggle ? 0 : -1;
    if (target === "times") onShowTimes();
    if (target === "trends") onShowTrends();
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      log(`switching to tab: ${btn.dataset.tab}`);
      activate(btn);
    });
  });
  activate(buttons[0]);
}

// "meals" on/off toggle, only meaningful on Week/Month (see initTabs).
// off = aggregate (default), on = broken out per meal.
function initGranularityTabs(onChange) {
  const btn = document.getElementById("meal-toggle");
  btn.addEventListener("click", () => {
    const isOn = btn.getAttribute("aria-pressed") === "true";
    const granularity = isOn ? "aggregate" : "meal";
    log(`switching granularity: ${granularity}`);
    btn.setAttribute("aria-pressed", String(!isOn));
    onChange(granularity);
  });
}

// -- init ---------------------------------------------------------------

async function init() {
  log("init: loading entries, foods, and goals from Supabase");
  const state = {
    enriched: null,
    goals: null,
    weights: [],
    granularity: "aggregate",
  };
  renderEmptyToday();
  initBarTooltip();

  function renderPeriodViews() {
    if (!state.enriched) return;
    renderMetricGrid(
      "week-charts",
      "week-status",
      state.enriched,
      trailingDates(7),
      state.goals,
      { labelEvery: 1, labelFormat: "weekday", movingAverageWindow: 3 },
      state.granularity,
    );
    renderMetricGrid(
      "month-charts",
      "month-status",
      state.enriched,
      trailingDates(30),
      state.goals,
      { labelEvery: 5, labelFormat: "date", movingAverageWindow: 7 },
      state.granularity,
    );
    renderYearGrid(
      "year-charts",
      "year-status",
      state.enriched,
      trailingPeriods(14, 26),
      state.goals,
      state.granularity,
    );
  }

  function renderTrends() {
    if (!state.enriched) return;
    renderAll(state.enriched, state.goals, state.weights);
  }

  function renderTimesView() {
    if (!state.enriched) return;
    renderTimes(state.enriched);
  }

  initTabs(renderTimesView, renderTrends);
  initGranularityTabs((granularity) => {
    state.granularity = granularity;
    if (state.enriched)
      renderToday(state.enriched, state.goals, state.granularity);
    renderPeriodViews();
  });
  let rows, labels, goals, weights;
  try {
    const [entryRows, foodRows, goalRows, weightRows] = await Promise.all([
      fetchTable(
        "food_entries",
        "select=eaten_on,meal,food_id,quantity_g&order=eaten_on.desc,meal.asc,id.asc",
      ),
      fetchTable(
        "foods",
        "select=id,name,per_g,calories,carbs_g,protein_g,fat_g,fiber_g&order=id.asc",
      ),
      fetchTable(
        "meal_goals",
        "select=meal,calories,carbs_g,protein_g,fat_g&order=meal.asc",
      ),
      fetchOptionalTable(
        "body_weight_entries",
        "select=weighed_on,weight_kg&order=weighed_on.asc",
      ),
    ]);
    rows = entryRows.map((row) => ({
      date: calendarDate(row.eaten_on),
      time: clockTime(row.eaten_on),
      timeMinutes: clockMinutes(row.eaten_on),
      meal: row.meal,
      food_id: row.food_id,
      quantity_g: Number(row.quantity_g),
    }));
    labels = new Map(foodRows.map((label) => [label.id, label]));
    goals = Object.fromEntries(
      goalRows.map(({ meal, ...goal }) => [meal, goal]),
    );
    weights = weightRows.map((row) => ({
      date: row.weighed_on,
      weight_kg: Number(row.weight_kg),
    }));
  } catch (err) {
    console.error("[calcunt] failed to load data:", err);
    const message = "falha ao carregar dados: " + err.message;
    for (const id of [
      "today-status",
      "week-status",
      "month-status",
      "year-status",
      "all-status",
      "times-status",
    ]) {
      const status = document.getElementById(id);
      status.textContent = message;
      status.hidden = false;
    }
    return;
  }

  const enriched = enrichRows(rows, labels);
  log(`enriched ${enriched.length} rows with nutrition data`);
  state.enriched = enriched;
  state.goals = goals;
  state.weights = weights;

  renderToday(enriched, goals, state.granularity, { animate: true });
  renderPeriodViews();
  if (!document.getElementById("tab-times").hidden) renderTimesView();
  if (!document.getElementById("tab-trends").hidden) renderTrends();

  log("init complete");
}

document.addEventListener("DOMContentLoaded", init);
