(() => {
  "use strict";

  const STORAGE_KEY = "mahami-v1";
  const THEME_KEY = "mahami-theme";
  const BACKUP_KEY = "mahami-v1-backup";
  const CHECK_INTERVAL_MS = 10000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const safeArr = (v) => (Array.isArray(v) ? v : []);

  const todayISO = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const addDaysISO = (iso, days) => {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const timestampFromISOAndTime = (iso, time) => {
    if (!iso || !time) return null;
    const ts = new Date(`${iso}T${time}:00`).getTime();
    return Number.isNaN(ts) ? null : ts;
  };

  const normalizeReminderRecord = (r) => {
    const base = {
      id: String(r.id),
      title: String(r.title || "").slice(0, 120),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    };
    const type = r.type === "daily" ? "daily" : "once";
    if (type === "daily") {
      return {
        ...base,
        type: "daily",
        startDate: r.startDate || "",
        endDate: r.endDate || "",
        time: r.time || "09:00",
        at: null,
      };
    }
    const at = typeof r.at === "number"
      ? r.at
      : timestampFromISOAndTime(r.date, r.time) || Date.now();
    return { ...base, type: "once", at };
  };

  const reminderAtForDay = (reminder, dateISO) => {
    if (reminder.type !== "daily") return null;
    if (!reminder.startDate || !reminder.endDate || !reminder.time) return null;
    if (dateISO < reminder.startDate || dateISO > reminder.endDate) return null;
    return timestampFromISOAndTime(dateISO, reminder.time);
  };

  const dailyReminderFireId = (reminderId, dateISO) => `rem-${reminderId}-${dateISO}`;

  const reminderDisplayMeta = (reminder) => {
    if (reminder.type === "daily") {
      const today = todayISO();
      const active = reminder.startDate && reminder.endDate
        && today >= reminder.startDate && today <= reminder.endDate;
      const upcoming = reminder.startDate && today < reminder.startDate;
      const ended = reminder.endDate && today > reminder.endDate;
      const nextAt = (() => {
        if (ended) return reminderAtForDay(reminder, reminder.endDate) || 0;
        if (upcoming) return reminderAtForDay(reminder, reminder.startDate) || 0;
        const todayAt = reminderAtForDay(reminder, today);
        if (todayAt && todayAt >= Date.now()) return todayAt;
        const tomorrow = addDaysISO(today, 1);
        if (tomorrow <= reminder.endDate) return reminderAtForDay(reminder, tomorrow) || todayAt || 0;
        return reminderAtForDay(reminder, today) || 0;
      })();
      return {
        kind: "daily",
        at: nextAt,
        active,
        upcoming,
        ended,
        label: `يومياً ${reminder.time} · ${formatShort(reminder.startDate)} → ${formatShort(reminder.endDate)}`,
      };
    }
    return {
      kind: "once",
      at: reminder.at,
      active: false,
      upcoming: reminder.at > Date.now(),
      ended: reminder.at < Date.now(),
      label: formatShort(new Date(reminder.at).toISOString().slice(0, 10), `${String(new Date(reminder.at).getHours()).padStart(2, "0")}:${String(new Date(reminder.at).getMinutes()).padStart(2, "0")}`),
    };
  };

  const buildReminderNotificationEvents = () => {
    const now = Date.now();
    const today = todayISO();
    const events = [];

    state.tasks
      .filter((t) => t.reminderAt && !t.done)
      .forEach((t) => {
        events.push({
          id: `task-${t.id}`,
          source: "task",
          sourceId: t.id,
          title: t.title,
          at: t.reminderAt,
          priority: t.priority,
          kind: "once",
        });
      });

    state.reminders.forEach((r) => {
      if (r.type === "daily") {
        const at = reminderAtForDay(r, today);
        if (!at) return;
        events.push({
          id: dailyReminderFireId(r.id, today),
          source: "reminder",
          sourceId: r.id,
          title: r.title,
          at,
          priority: "normal",
          kind: "daily",
        });
        return;
      }
      if (typeof r.at === "number") {
        events.push({
          id: `rem-${r.id}`,
          source: "reminder",
          sourceId: r.id,
          title: r.title,
          at: r.at,
          priority: "normal",
          kind: "once",
        });
      }
    });

    return events
      .filter((e) => e.at)
      .sort((a, b) => a.at - b.at)
      .map((e) => ({ ...e, past: e.at < now }));
  };

  const formatDateAr = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(`${iso}T12:00:00`);
      return d.toLocaleDateString("ar-SA", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    } catch {
      return iso;
    }
  };

  const formatShort = (iso, time) => {
    if (!iso) return "";
    try {
      const d = new Date(`${iso}T${time || "12:00"}:00`);
      if (Number.isNaN(d.getTime())) return iso;
      const datePart = d.toLocaleDateString("ar-SA", { month: "short", day: "numeric" });
      return time ? `${datePart} · ${time}` : datePart;
    } catch {
      return iso;
    }
  };

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const defaultState = () => ({
    tasks: [],
    goals: [],
    plans: [],
    reminders: [],
    firedReminderIds: [],
  });

  function normalizeState(raw) {
    const data = raw && typeof raw === "object" ? raw : {};
    return {
      tasks: safeArr(data.tasks).filter((t) => t && typeof t === "object" && t.id && t.title).map((t) => ({
        id: String(t.id),
        title: String(t.title || "").slice(0, 120),
        desc: String(t.desc || "").slice(0, 400),
        date: t.date || todayISO(),
        time: t.time || "",
        priority: t.priority === "urgent" ? "urgent" : "normal",
        goalId: t.goalId || "",
        steps: safeArr(t.steps).filter((s) => s && s.text).map((s) => ({
          text: String(s.text).slice(0, 150),
          done: !!s.done,
        })),
        reminderAt: typeof t.reminderAt === "number" ? t.reminderAt : null,
        done: !!t.done,
        createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
      })),
      goals: safeArr(data.goals).filter((g) => g && g.id && g.title).map((g) => ({
        id: String(g.id),
        title: String(g.title || "").slice(0, 120),
        desc: String(g.desc || "").slice(0, 400),
        deadline: g.deadline || "",
        createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
      })),
      plans: safeArr(data.plans).filter((p) => p && p.id && p.title).map((p) => ({
        id: String(p.id),
        title: String(p.title || "").slice(0, 120),
        desc: String(p.desc || "").slice(0, 400),
        start: p.start || "",
        end: p.end || "",
        phases: safeArr(p.phases).filter((ph) => ph && ph.text).map((ph) => ({
          text: String(ph.text).slice(0, 150),
          done: !!ph.done,
        })),
        createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
      })),
      reminders: safeArr(data.reminders)
        .filter((r) => r && r.id && r.title)
        .map(normalizeReminderRecord),
      firedReminderIds: safeArr(data.firedReminderIds).map(String).slice(-200),
    };
  }

  let state = load();
  let currentFilter = "all";
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let saveTimer = null;
  let rendering = false;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(BACKUP_KEY);
      if (!raw) return defaultState();
      return normalizeState(JSON.parse(raw));
    } catch {
      try {
        const bak = localStorage.getItem(BACKUP_KEY);
        if (bak) return normalizeState(JSON.parse(bak));
      } catch { /* ignore */ }
      return defaultState();
    }
  }

  function saveNow() {
    try {
      const payload = JSON.stringify(state);
      localStorage.setItem(STORAGE_KEY, payload);
      localStorage.setItem(BACKUP_KEY, payload);
      syncScheduleToServiceWorker();
    } catch (err) {
      console.warn("save failed", err);
      toast("تعذر حفظ البيانات — مساحة التخزين ممتلئة ربما");
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 80);
  }

  function toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /* ---------- Theme ---------- */
  function getTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function applyTheme(theme) {
    const next = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    const btn = $("#btnTheme");
    if (btn) {
      btn.textContent = next === "dark" ? "☀️" : "🌙";
      btn.title = next === "dark" ? "النمط الفاتح" : "النمط الداكن";
      btn.setAttribute("aria-label", btn.title);
    }
    const meta = $("#metaThemeColor") || document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", next === "dark" ? "#0b1220" : "#3b82f6");
  }

  function toggleTheme() {
    applyTheme(getTheme() === "dark" ? "light" : "dark");
    toast(getTheme() === "dark" ? "تم تفعيل النمط الداكن" : "تم تفعيل النمط الفاتح");
  }

  function taskProgress(task) {
    const steps = task.steps || [];
    if (!steps.length) return task.done ? 100 : 0;
    const done = steps.filter((s) => s.done).length;
    return Math.round((done / steps.length) * 100);
  }

  function goalProgress(goal) {
    const related = state.tasks.filter((t) => t.goalId === goal.id);
    if (!related.length) return 0;
    const sum = related.reduce((acc, t) => acc + taskProgress(t), 0);
    return Math.round(sum / related.length);
  }

  function planProgress(plan) {
    const phases = plan.phases || [];
    if (!phases.length) return 0;
    const done = phases.filter((p) => p.done).length;
    return Math.round((done / phases.length) * 100);
  }

  function updateStats() {
    const today = todayISO();
    const todayTasks = state.tasks.filter((t) => t.date === today);
    const done = todayTasks.filter((t) => t.done || taskProgress(t) === 100).length;
    const pending = todayTasks.length - done;
    const urgent = state.tasks.filter((t) => !t.done && t.priority === "urgent").length;
    const pct = todayTasks.length ? Math.round((done / todayTasks.length) * 100) : 0;

    $("#statDone").textContent = String(done);
    $("#statPending").textContent = String(pending);
    $("#statUrgent").textContent = String(urgent);
    $("#dayPercent").textContent = `${pct}%`;
    $("#dayRing").style.setProperty("--p", pct);
    $("#todayLabel").textContent = formatDateAr(today);
  }

  function fillGoalSelect(selected) {
    const sel = $("#taskGoal");
    sel.innerHTML = `<option value="">— بدون —</option>` +
      state.goals.map((g) => `<option value="${g.id}">${escapeHtml(g.title)}</option>`).join("");
    if (selected) sel.value = selected;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- Tabs ---------- */
  function setTab(name) {
    $$(".tab").forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    $$(".panel").forEach((p) => {
      const on = p.id === `panel-${name}`;
      p.classList.toggle("active", on);
      p.hidden = !on;
    });
    const content = $(".content");
    if (content) content.scrollTop = 0;
    render();
  }

  /* ---------- Render ---------- */
  function render() {
    if (rendering) return;
    rendering = true;
    try {
      updateStats();
      renderTasks();
      renderGoals();
      renderPlans();
      renderReminders();
      updateNotifyStatus();
      updateDataStatsHint();
    } catch (err) {
      console.error("render failed", err);
      toast("حدث خطأ أثناء العرض — تمت استعادة البيانات");
      try {
        state = load();
        updateStats();
        renderTasks();
      } catch { /* ignore */ }
    } finally {
      rendering = false;
    }
  }

  function getSortedFilteredTasks() {
    let list = [...state.tasks];
    const today = todayISO();

    switch (currentFilter) {
      case "today":
        list = list.filter((t) => t.date === today);
        break;
      case "urgent":
        list = list.filter((t) => t.priority === "urgent" && !t.done);
        break;
      case "pending":
        list = list.filter((t) => !t.done && taskProgress(t) < 100);
        break;
      case "done":
        list = list.filter((t) => t.done || taskProgress(t) === 100);
        break;
      default:
        break;
    }

    const sort = $("#sortTasks").value;
    list.sort((a, b) => {
      if (sort === "priority") {
        const pa = a.priority === "urgent" ? 0 : 1;
        const pb = b.priority === "urgent" ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return (a.date || "").localeCompare(b.date || "");
      }
      if (sort === "date") return (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || "");
      if (sort === "progress") return taskProgress(b) - taskProgress(a);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    return list;
  }

  function renderTasks() {
    const list = getSortedFilteredTasks();
    const box = $("#tasksList");
    const empty = $("#tasksEmpty");
    empty.hidden = list.length > 0;
    box.innerHTML = list.map((task) => {
      const pct = taskProgress(task);
      const goal = state.goals.find((g) => g.id === task.goalId);
      const stepsHtml = (task.steps || []).length
        ? `<div class="steps-list">${task.steps.map((s, i) => `
            <label class="step-item ${s.done ? "done" : ""}">
              <input type="checkbox" data-action="toggle-step" data-id="${task.id}" data-idx="${i}" ${s.done ? "checked" : ""} />
              <span>${escapeHtml(s.text)}</span>
            </label>`).join("")}</div>`
        : "";

      return `
        <article class="card ${task.priority === "urgent" ? "urgent-card" : ""} ${task.done || pct === 100 ? "done-card" : ""}" data-id="${task.id}">
          <div class="card-top">
            <input class="card-check" type="checkbox" data-action="toggle-task" data-id="${task.id}" ${task.done || pct === 100 ? "checked" : ""} />
            <div class="card-body">
              <h3 class="card-title">${escapeHtml(task.title)}</h3>
              ${task.desc ? `<p class="muted" style="margin:6px 0 0;font-size:0.85rem">${escapeHtml(task.desc)}</p>` : ""}
              <div class="card-meta">
                <span class="badge ${task.priority === "urgent" ? "urgent" : ""}">${task.priority === "urgent" ? "عاجلة 🔥" : "عادية"}</span>
                <span class="badge date">${formatShort(task.date, task.time)}</span>
                ${goal ? `<span class="badge goal">🎯 ${escapeHtml(goal.title)}</span>` : ""}
                ${task.reminderAt ? `<span class="badge">🔔 تذكير</span>` : ""}
              </div>
              <div class="progress-wrap">
                <div class="progress-head"><span>الإنجاز</span><span>${pct}%</span></div>
                <div class="progress-bar"><div class="progress-fill ${task.priority === "urgent" ? "urgent-fill" : ""}" style="width:${pct}%"></div></div>
              </div>
              ${stepsHtml}
              <div class="card-actions">
                <button type="button" class="btn-mini" data-action="edit-task" data-id="${task.id}">✏️ تعديل</button>
                <button type="button" class="btn-mini danger" data-action="delete-task" data-id="${task.id}">🗑️ حذف</button>
              </div>
            </div>
          </div>
        </article>`;
    }).join("");
  }

  function renderGoals() {
    const box = $("#goalsList");
    const empty = $("#goalsEmpty");
    empty.hidden = state.goals.length > 0;
    box.innerHTML = state.goals.map((goal) => {
      const pct = goalProgress(goal);
      const relatedCount = state.tasks.filter((t) => t.goalId === goal.id).length;
      return `
        <article class="card">
          <h3 class="card-title">🎯 ${escapeHtml(goal.title)}</h3>
          ${goal.desc ? `<p class="muted" style="margin:6px 0 0;font-size:0.85rem">${escapeHtml(goal.desc)}</p>` : ""}
          <div class="card-meta">
            ${goal.deadline ? `<span class="badge date">حتى ${formatShort(goal.deadline)}</span>` : ""}
            <span class="badge">${relatedCount} مهمة مرتبطة</span>
          </div>
          <div class="goal-progress-big">
            <div class="goal-ring" style="--p:${pct}"><span>${pct}%</span></div>
            <div style="flex:1">
              <div class="progress-head"><span>تقدم الهدف</span><span>${pct}%</span></div>
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            </div>
          </div>
          <div class="card-actions">
            <button type="button" class="btn-mini" data-action="edit-goal" data-id="${goal.id}">✏️ تعديل</button>
            <button type="button" class="btn-mini danger" data-action="delete-goal" data-id="${goal.id}">🗑️ حذف</button>
          </div>
        </article>`;
    }).join("");
  }

  function renderPlans() {
    const box = $("#plansList");
    const empty = $("#plansEmpty");
    empty.hidden = state.plans.length > 0;
    box.innerHTML = state.plans.map((plan) => {
      const pct = planProgress(plan);
      const phases = (plan.phases || []).map((p, i) => `
        <label class="phase">
          <div class="phase-top">
            <span>${escapeHtml(p.text)}</span>
            <input type="checkbox" data-action="toggle-phase" data-id="${plan.id}" data-idx="${i}" ${p.done ? "checked" : ""} />
          </div>
        </label>`).join("");

      return `
        <article class="card">
          <h3 class="card-title">🗺️ ${escapeHtml(plan.title)}</h3>
          ${plan.desc ? `<p class="muted" style="margin:6px 0 0;font-size:0.85rem">${escapeHtml(plan.desc)}</p>` : ""}
          <div class="card-meta">
            ${plan.start || plan.end ? `<span class="badge date">${formatShort(plan.start) || "…"} → ${formatShort(plan.end) || "…"}</span>` : ""}
            <span class="badge">${pct}% مكتمل</span>
          </div>
          <div class="progress-wrap">
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="plan-phases">${phases}</div>
          <div class="card-actions">
            <button type="button" class="btn-mini" data-action="edit-plan" data-id="${plan.id}">✏️ تعديل</button>
            <button type="button" class="btn-mini danger" data-action="delete-plan" data-id="${plan.id}">🗑️ حذف</button>
          </div>
        </article>`;
    }).join("");
  }

  function getReminderListItems() {
    const now = Date.now();
    const fromTasks = state.tasks
      .filter((t) => t.reminderAt && !t.done)
      .map((t) => ({
        id: `task-${t.id}`,
        source: "task",
        sourceId: t.id,
        title: t.title,
        at: t.reminderAt,
        priority: t.priority,
        kind: "once",
        label: formatShort(
          new Date(t.reminderAt).toISOString().slice(0, 10),
          `${String(new Date(t.reminderAt).getHours()).padStart(2, "0")}:${String(new Date(t.reminderAt).getMinutes()).padStart(2, "0")}`
        ),
        past: t.reminderAt < now,
        status: t.reminderAt < now ? "منتهي" : "قادم",
      }));

    const standalone = state.reminders.map((r) => {
      const meta = reminderDisplayMeta(r);
      let status = "قادم";
      if (r.type === "daily") {
        if (meta.ended) status = "منتهي";
        else if (meta.active) status = "نشط يومياً";
        else if (meta.upcoming) status = "يبدأ قريباً";
      } else {
        status = meta.ended ? "منتهي" : "قادم";
      }
      return {
        id: r.type === "daily" ? `rem-daily-${r.id}` : `rem-${r.id}`,
        source: "reminder",
        sourceId: r.id,
        title: r.title,
        at: meta.at,
        priority: "normal",
        kind: meta.kind,
        label: meta.label,
        past: meta.ended || (meta.kind === "once" && meta.at < now),
        status,
      };
    });

    return [...fromTasks, ...standalone]
      .filter((r) => r.at)
      .sort((a, b) => a.at - b.at);
  }

  function renderReminders() {
    const list = getReminderListItems();
    const box = $("#remindersList");
    const empty = $("#remindersEmpty");
    empty.hidden = list.length > 0;
    box.innerHTML = list.map((r) => {
      const d = new Date(r.at);
      const when = d.toLocaleString("ar-SA", {
        weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      return `
        <article class="card ${r.past ? "done-card" : ""} ${r.priority === "urgent" ? "urgent-card" : ""}">
          <h3 class="card-title">⏰ ${escapeHtml(r.title)}</h3>
          <div class="card-meta">
            <span class="badge date">${escapeHtml(r.label || when)}</span>
            <span class="badge">${r.source === "task" ? "من مهمة" : "تذكير مستقل"}</span>
            ${r.kind === "daily" ? `<span class="badge goal">يومي 🔁</span>` : ""}
            <span class="badge">${r.status || (r.past ? "منتهي" : "قادم")}</span>
          </div>
          ${r.kind === "daily" ? `<p class="muted" style="margin:8px 0 0;font-size:0.82rem">التنبيه القادم: ${when}</p>` : ""}
          ${r.source === "reminder" ? `
            <div class="card-actions">
              <button type="button" class="btn-mini" data-action="edit-reminder" data-id="${r.sourceId}">✏️ تعديل</button>
              <button type="button" class="btn-mini danger" data-action="delete-reminder" data-id="${r.sourceId}">🗑️ حذف</button>
            </div>` : ""}
        </article>`;
    }).join("");
  }

  /* ---------- Modals / Sheets ---------- */
  function openSheet(el) {
    $("#modalBackdrop").hidden = false;
    el.hidden = false;
  }

  function closeAllSheets() {
    $("#modalBackdrop").hidden = true;
    $("#taskModal").hidden = true;
    $("#goalModal").hidden = true;
    $("#planModal").hidden = true;
    $("#reminderModal").hidden = true;
  }

  function handleAddAction(type) {
    closeAllSheets();
    if (type === "task") openTaskModal();
    if (type === "goal") openGoalModal();
    if (type === "plan") openPlanModal();
    if (type === "reminder") openReminderModal();
  }

  /* Steps editor */
  function renderStepsEditor(steps = [{ text: "", done: false }]) {
    const box = $("#stepsEditor");
    if (!steps.length) steps = [{ text: "", done: false }];
    box.innerHTML = steps.map((s, i) => `
      <div class="step-edit">
        <input type="text" data-step-idx="${i}" value="${escapeHtml(s.text)}" placeholder="خطوة ${i + 1}" maxlength="150" />
        <button type="button" class="remove-step" data-remove-step="${i}" aria-label="حذف">×</button>
      </div>`).join("");
  }

  function readStepsEditorLive() {
    const taskId = $("#taskId").value;
    const existingSteps = taskId
      ? (state.tasks.find((t) => t.id === taskId)?.steps || [])
      : [];
    return $$("#stepsEditor input[data-step-idx]").map((inp, i) => ({
      text: inp.value,
      done: existingSteps[i] ? !!existingSteps[i].done : false,
    }));
  }

  function readStepsEditor() {
    return readStepsEditorLive()
      .map((s) => ({ text: s.text.trim(), done: s.done }))
      .filter((s) => s.text);
  }

  function renderPhasesEditor(phases = [{ text: "", done: false }]) {
    const box = $("#planPhasesEditor");
    if (!phases.length) phases = [{ text: "", done: false }];
    box.innerHTML = phases.map((p, i) => `
      <div class="step-edit">
        <input type="text" data-phase-idx="${i}" value="${escapeHtml(p.text)}" placeholder="مرحلة ${i + 1}" maxlength="150" />
        <button type="button" class="remove-step" data-remove-phase="${i}" aria-label="حذف">×</button>
      </div>`).join("");
  }

  function readPhasesEditorLive() {
    const planId = $("#planId").value;
    const existingPhases = planId
      ? (state.plans.find((p) => p.id === planId)?.phases || [])
      : [];
    return $$("#planPhasesEditor input[data-phase-idx]").map((inp, i) => ({
      text: inp.value,
      done: existingPhases[i] ? !!existingPhases[i].done : false,
    }));
  }

  function readPhasesEditor() {
    return readPhasesEditorLive()
      .map((p) => ({ text: p.text.trim(), done: p.done }))
      .filter((p) => p.text);
  }

  function openTaskModal(task) {
    fillGoalSelect(task?.goalId || "");
    $("#taskModalTitle").textContent = task ? "تعديل المهمة" : "مهمة جديدة";
    $("#taskId").value = task?.id || "";
    $("#taskTitle").value = task?.title || "";
    $("#taskDesc").value = task?.desc || "";
    $("#taskDate").value = task?.date || todayISO();
    $("#taskTime").value = task?.time || "";
    $$(`input[name="priority"]`).forEach((r) => {
      r.checked = r.value === (task?.priority || "normal");
    });
    renderStepsEditor(task?.steps?.length ? task.steps : [{ text: "", done: false }, { text: "", done: false }]);
    const hasRem = !!task?.reminderAt;
    $("#taskReminder").checked = hasRem;
    $("#reminderFields").hidden = !hasRem;
    if (hasRem) {
      const d = new Date(task.reminderAt);
      $("#reminderDate").value = d.toISOString().slice(0, 10);
      $("#reminderTime").value = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } else {
      $("#reminderDate").value = task?.date || todayISO();
      $("#reminderTime").value = task?.time || "09:00";
    }
    openSheet($("#taskModal"));
  }

  function openGoalModal(goal) {
    $("#goalModalTitle").textContent = goal ? "تعديل الهدف" : "هدف جديد";
    $("#goalId").value = goal?.id || "";
    $("#goalTitle").value = goal?.title || "";
    $("#goalDesc").value = goal?.desc || "";
    $("#goalDeadline").value = goal?.deadline || "";
    openSheet($("#goalModal"));
  }

  function openPlanModal(plan) {
    $("#planModalTitle").textContent = plan ? "تعديل الخطة" : "خطة جديدة";
    $("#planId").value = plan?.id || "";
    $("#planTitle").value = plan?.title || "";
    $("#planDesc").value = plan?.desc || "";
    $("#planStart").value = plan?.start || todayISO();
    $("#planEnd").value = plan?.end || "";
    renderPhasesEditor(plan?.phases?.length ? plan.phases : [{ text: "", done: false }, { text: "", done: false }, { text: "", done: false }]);
    openSheet($("#planModal"));
  }

  function syncReminderTypeFields() {
    const type = ($("input[name='remType']:checked") || {}).value || "once";
    const once = type === "once";
    $("#remOnceFields").hidden = !once;
    $("#remDailyFields").hidden = once;
    $("#remDate").required = once;
    $("#remTime").required = once;
    $("#remStartDate").required = !once;
    $("#remEndDate").required = !once;
    $("#remDailyTime").required = !once;
  }

  function openReminderModal(reminder) {
    $("#reminderModalTitle").textContent = reminder ? "تعديل التذكير" : "تذكير جديد";
    $("#remId").value = reminder?.id || "";
    $("#remTitle").value = reminder?.title || "";

    const type = reminder?.type === "daily" ? "daily" : "once";
    $$("input[name='remType']").forEach((r) => { r.checked = r.value === type; });

    if (type === "daily") {
      $("#remStartDate").value = reminder.startDate || todayISO();
      $("#remEndDate").value = reminder.endDate || addDaysISO(todayISO(), 7);
      $("#remDailyTime").value = reminder.time || "09:00";
      $("#remDate").value = todayISO();
      $("#remTime").value = "09:00";
    } else {
      if (reminder?.at) {
        const d = new Date(reminder.at);
        $("#remDate").value = d.toISOString().slice(0, 10);
        $("#remTime").value = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      } else {
        $("#remDate").value = todayISO();
        $("#remTime").value = "09:00";
      }
      $("#remStartDate").value = todayISO();
      $("#remEndDate").value = addDaysISO(todayISO(), 7);
      $("#remDailyTime").value = "09:00";
    }

    syncReminderTypeFields();
    openSheet($("#reminderModal"));
  }

  /* ---------- CRUD ---------- */
  function upsertTask(data) {
    if (data.id) {
      const idx = state.tasks.findIndex((t) => t.id === data.id);
      if (idx >= 0) {
        const prev = state.tasks[idx];
        state.tasks[idx] = { ...prev, ...data };
        if (prev.reminderAt !== data.reminderAt) {
          state.firedReminderIds = state.firedReminderIds.filter((id) => id !== `task-${data.id}`);
        }
      }
    } else {
      state.tasks.unshift({
        ...data,
        id: uid(),
        createdAt: Date.now(),
        done: false,
      });
    }
    save();
    render();
  }

  function deleteTask(id) {
    if (!confirm("حذف هذه المهمة؟")) return;
    state.tasks = state.tasks.filter((t) => t.id !== id);
    state.firedReminderIds = state.firedReminderIds.filter((x) => x !== `task-${id}`);
    save();
    render();
    toast("تم حذف المهمة");
  }

  function toggleTask(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.done = !task.done;
    if (task.steps?.length) {
      task.steps.forEach((s) => { s.done = task.done; });
    }
    save();
    render();
  }

  function toggleStep(id, idx) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task?.steps?.[idx]) return;
    task.steps[idx].done = !task.steps[idx].done;
    const pct = taskProgress(task);
    task.done = pct === 100;
    save();
    render();
  }

  function upsertGoal(data) {
    if (data.id) {
      const idx = state.goals.findIndex((g) => g.id === data.id);
      if (idx >= 0) state.goals[idx] = { ...state.goals[idx], ...data };
    } else {
      state.goals.unshift({ ...data, id: uid(), createdAt: Date.now() });
    }
    save();
    render();
  }

  function deleteGoal(id) {
    if (!confirm("حذف هذا الهدف؟ (المهام المرتبطة لن تُحذف)")) return;
    state.goals = state.goals.filter((g) => g.id !== id);
    state.tasks.forEach((t) => { if (t.goalId === id) t.goalId = ""; });
    save();
    render();
    toast("تم حذف الهدف");
  }

  function upsertPlan(data) {
    if (data.id) {
      const idx = state.plans.findIndex((p) => p.id === data.id);
      if (idx >= 0) state.plans[idx] = { ...state.plans[idx], ...data };
    } else {
      state.plans.unshift({ ...data, id: uid(), createdAt: Date.now() });
    }
    save();
    render();
  }

  function deletePlan(id) {
    if (!confirm("حذف هذه الخطة؟")) return;
    state.plans = state.plans.filter((p) => p.id !== id);
    save();
    render();
    toast("تم حذف الخطة");
  }

  function togglePhase(id, idx) {
    const plan = state.plans.find((p) => p.id === id);
    if (!plan?.phases?.[idx]) return;
    plan.phases[idx].done = !plan.phases[idx].done;
    save();
    render();
  }

  function upsertStandaloneReminder(data) {
    if (data.id) {
      const idx = state.reminders.findIndex((r) => r.id === data.id);
      if (idx >= 0) {
        const prev = state.reminders[idx];
        state.reminders[idx] = {
          ...prev,
          ...data,
          id: prev.id,
          createdAt: prev.createdAt || Date.now(),
        };
        // إعادة تفعيل الإشعارات عند تغيير الموعد/النوع
        state.firedReminderIds = state.firedReminderIds.filter(
          (x) => x !== `rem-${data.id}` && !x.startsWith(`rem-${data.id}-`)
        );
      } else {
        state.reminders.unshift({ ...data, id: data.id, createdAt: Date.now() });
      }
    } else {
      state.reminders.unshift({ ...data, id: uid(), createdAt: Date.now() });
    }
    save();
    render();
  }

  function addStandaloneReminder(data) {
    upsertStandaloneReminder(data);
  }

  function deleteReminder(id) {
    if (!confirm("حذف هذا التذكير؟")) return;
    state.reminders = state.reminders.filter((r) => r.id !== id);
    state.firedReminderIds = state.firedReminderIds.filter(
      (x) => x !== `rem-${id}` && !x.startsWith(`rem-${id}-`)
    );
    save();
    render();
    toast("تم حذف التذكير");
  }

  /* ---------- Notifications ---------- */
  let scheduledTimers = [];
  let swRegistration = null;

  function absoluteAsset(path) {
    try { return new URL(path, window.location.href).href; }
    catch { return path; }
  }

  function isStandaloneApp() {
    return window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
  }

  function buildUpcomingScheduleEvents() {
    const now = Date.now();
    const horizon = now + 7 * 24 * 60 * 60 * 1000;
    const events = [];

    state.tasks.forEach((t) => {
      if (!t.reminderAt || t.done) return;
      if (t.reminderAt < now - 10 * 60 * 1000) return;
      if (t.reminderAt > horizon) return;
      events.push({
        id: `task-${t.id}`,
        title: t.title,
        body: "تذكير مهمة من مهامي",
        at: t.reminderAt,
        priority: t.priority,
      });
    });

    state.reminders.forEach((r) => {
      if (r.type === "daily") {
        if (!r.startDate || !r.endDate || !r.time) return;
        let cursor = r.startDate < todayISO() ? todayISO() : r.startDate;
        let guard = 0;
        while (cursor <= r.endDate && guard < 400) {
          const at = reminderAtForDay(r, cursor);
          if (at && at >= now - 10 * 60 * 1000 && at <= horizon) {
            events.push({
              id: dailyReminderFireId(r.id, cursor),
              title: r.title,
              body: `تذكير يومي (${r.time})`,
              at,
              priority: "normal",
            });
          }
          cursor = addDaysISO(cursor, 1);
          guard += 1;
        }
        return;
      }
      if (typeof r.at === "number" && r.at >= now - 10 * 60 * 1000 && r.at <= horizon) {
        events.push({
          id: `rem-${r.id}`,
          title: r.title,
          body: "تذكير من مهامي",
          at: r.at,
          priority: "normal",
        });
      }
    });

    return events.sort((a, b) => a.at - b.at);
  }

  async function syncScheduleToServiceWorker() {
    const events = buildUpcomingScheduleEvents();
    const fired = safeArr(state.firedReminderIds);
    try {
      const reg = swRegistration || (await navigator.serviceWorker?.ready);
      if (reg?.active) {
        reg.active.postMessage({ type: "SYNC_SCHEDULE", events, fired });
      }
    } catch (err) {
      console.warn("schedule sync failed", err);
    }
    scheduleLocalTimers(events);
    return events;
  }

  function clearLocalTimers() {
    scheduledTimers.forEach((id) => clearTimeout(id));
    scheduledTimers = [];
  }

  function scheduleLocalTimers(events) {
    clearLocalTimers();
    const now = Date.now();
    events
      .filter((e) => e.at > now && e.at - now < 24 * 60 * 60 * 1000)
      .slice(0, 20)
      .forEach((event) => {
        const delay = Math.max(500, event.at - Date.now());
        const timerId = setTimeout(async () => {
          if (state.firedReminderIds.includes(event.id)) return;
          const prefix = event.priority === "urgent" ? "🔥 عاجل: " : "⏰ تذكير: ";
          await showLocalNotification(prefix + event.title, event.body || "حان وقت التذكير", event.id);
          if (!state.firedReminderIds.includes(event.id)) {
            state.firedReminderIds.push(event.id);
            saveNow();
            syncScheduleToServiceWorker();
          }
        }, delay);
        scheduledTimers.push(timerId);
      });
  }

  async function ensureNotifyPermission() {
    if (!("Notification" in window)) {
      toast("المتصفح لا يدعم الإشعارات");
      updateNotifyStatus();
      return false;
    }
    if (Notification.permission === "granted") {
      await syncScheduleToServiceWorker();
      updateNotifyStatus();
      return true;
    }
    if (Notification.permission === "denied") {
      toast("الإشعارات مرفوضة — فعّلها من إعدادات الهاتف/المتصفح");
      updateNotifyStatus();
      return false;
    }
    const result = await Notification.requestPermission();
    updateNotifyStatus();
    if (result === "granted") {
      toast("تم تفعيل الإشعارات");
      await syncScheduleToServiceWorker();
      await showLocalNotification("مهامي جاهز ✅", "الإشعارات تعمل. فعّل الظهور على شاشة القفل من إعدادات الهاتف.");
      return true;
    }
    toast("لم يتم منح إذن الإشعارات");
    return false;
  }

  function updateNotifyStatus() {
    const text = $("#notifyStatusText");
    const list = $("#notifyChecklist");
    if (!text) return;

    const permission = ("Notification" in window) ? Notification.permission : "unsupported";
    const swOk = !!(navigator.serviceWorker && (swRegistration || navigator.serviceWorker.controller));
    const installed = isStandaloneApp();
    const secure = window.isSecureContext;

    if (permission === "unsupported") {
      text.textContent = "هذا المتصفح لا يدعم واجهة الإشعارات.";
    } else if (permission === "granted") {
      text.textContent = "الإشعارات مفعّلة ✅. استخدم زر الاختبار للتأكد أنها تظهر في مركز التنبيهات/شاشة القفل.";
    } else if (permission === "denied") {
      text.textContent = "الإشعارات مرفوضة ❌. افتح إعدادات الموقع/التطبيق وفعّلها يدوياً.";
    } else {
      text.textContent = "الإشعارات غير مفعّلة بعد. اضغط «تفعيل الإشعارات» واسمح بها.";
    }

    if (list) {
      const rows = [
        { ok: secure, warn: false, label: secure ? "اتصال آمن (HTTPS) جاهز" : "يحتاج HTTPS أو localhost" },
        { ok: permission === "granted", warn: permission === "default", label: permission === "granted" ? "إذن الإشعارات ممنوح" : permission === "denied" ? "إذن الإشعارات مرفوض" : "إذن الإشعارات لم يُطلب بعد" },
        { ok: swOk, warn: false, label: swOk ? "Service Worker يعمل" : "Service Worker غير مفعّل بعد" },
        { ok: installed, warn: !installed, label: installed ? "التطبيق مثبت على الشاشة الرئيسية" : "يُفضّل تثبيته على الشاشة الرئيسية (مهم للآيفون)" },
      ];
      list.innerHTML = rows.map((r) => {
        const cls = r.ok ? "ok" : r.warn ? "warn" : "bad";
        const mark = r.ok ? "✅" : r.warn ? "⚠️" : "❌";
        return `<li class="${cls}">${mark} ${r.label}</li>`;
      }).join("");
    }
  }

  function updateDataStatsHint() {
    const el = $("#dataStatsHint");
    if (!el) return;
    el.textContent = `الحالي: ${state.tasks.length} مهمة · ${state.goals.length} هدف · ${state.plans.length} خطة · ${state.reminders.length} تذكير`;
  }

  function buildExportPayload() {
    let theme = "light";
    try { theme = localStorage.getItem(THEME_KEY) || getTheme(); } catch { /* ignore */ }
    return {
      app: "mahami",
      version: 1,
      exportedAt: new Date().toISOString(),
      theme,
      data: {
        tasks: state.tasks,
        goals: state.goals,
        plans: state.plans,
        reminders: state.reminders,
        firedReminderIds: state.firedReminderIds,
      },
    };
  }

  function exportData() {
    try {
      saveNow();
      const payload = buildExportPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const filename = `mahami-backup-${stamp}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast("تم تصدير البيانات");
    } catch (err) {
      console.warn(err);
      toast("تعذر تصدير البيانات");
    }
  }

  function extractImportData(parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.data && typeof parsed.data === "object") return parsed;
    if (parsed.tasks || parsed.goals || parsed.plans || parsed.reminders) {
      return { app: "mahami", version: 1, theme: null, data: parsed };
    }
    return null;
  }

  function applyImportedData(wrapper, { merge }) {
    const incoming = normalizeState(wrapper.data);
    if (merge) {
      const byId = (list) => {
        const map = new Map();
        list.forEach((item) => map.set(item.id, item));
        return map;
      };
      const mergeList = (current, next) => {
        const map = byId(current);
        next.forEach((item) => map.set(item.id, item));
        return [...map.values()];
      };
      state = {
        tasks: mergeList(state.tasks, incoming.tasks),
        goals: mergeList(state.goals, incoming.goals),
        plans: mergeList(state.plans, incoming.plans),
        reminders: mergeList(state.reminders, incoming.reminders),
        firedReminderIds: [...new Set([
          ...safeArr(state.firedReminderIds),
          ...safeArr(incoming.firedReminderIds),
        ])].slice(-200),
      };
    } else {
      state = incoming;
    }

    if (wrapper.theme === "dark" || wrapper.theme === "light") {
      applyTheme(wrapper.theme);
    }
    saveNow();
    render();
  }

  async function importDataFromFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const wrapper = extractImportData(parsed);
      if (!wrapper) {
        toast("ملف غير صالح");
        return;
      }
      const counts = normalizeState(wrapper.data);
      const summary = `${counts.tasks.length} مهمة، ${counts.goals.length} هدف، ${counts.plans.length} خطة، ${counts.reminders.length} تذكير`;
      const replace = confirm(
        `استيراد البيانات واستبدال الحالية؟\n\nمحتوى الملف: ${summary}\n\nموافق = استبدال الكل\nإلغاء = اختيار الدمج أو الإلغاء`
      );
      if (replace) {
        applyImportedData(wrapper, { merge: false });
        toast("تم استبدال البيانات بنجاح");
        return;
      }
      const merge = confirm("هل تريد دمج البيانات مع الحالية بدل الاستبدال؟");
      if (!merge) {
        toast("تم إلغاء الاستيراد");
        return;
      }
      applyImportedData(wrapper, { merge: true });
      toast("تم دمج البيانات بنجاح");
    } catch (err) {
      console.warn(err);
      toast("تعذر قراءة ملف الاستيراد");
    }
  }

  function clearAllData() {
    const ok = confirm("هل أنت متأكد من مسح كل البيانات؟ لا يمكن التراجع.");
    if (!ok) return;
    const sure = confirm("تأكيد أخير: مسح المهام والأهداف والخطط والتذكيرات؟");
    if (!sure) return;
    state = defaultState();
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(BACKUP_KEY);
    } catch { /* ignore */ }
    saveNow();
    render();
    toast("تم مسح البيانات");
  }

  async function showLocalNotification(title, body, tag) {
    if (!("Notification" in window) || Notification.permission !== "granted") return false;
    const opts = {
      body: body || "حان وقت التذكير من تطبيق مهامي",
      icon: absoluteAsset("./icons/icon-192.png"),
      badge: absoluteAsset("./icons/icon-192.png"),
      tag: tag || `mahami-${Date.now()}`,
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [220, 100, 220, 100, 320],
      lang: "ar",
      dir: "rtl",
      timestamp: Date.now(),
      data: { url: absoluteAsset("./index.html") },
    };
    try {
      const reg = swRegistration || (await navigator.serviceWorker?.ready);
      if (reg) {
        await reg.showNotification(title, opts);
        return true;
      }
    } catch (err) {
      console.warn("SW notify failed", err);
    }
    try {
      new Notification(title, opts);
      return true;
    } catch (err) {
      console.warn("Notification failed", err);
      return false;
    }
  }

  async function sendTestNotification(delayMs = 0) {
    const ok = await ensureNotifyPermission();
    if (!ok) return;
    if (delayMs > 0) {
      toast(`سيتم إرسال إشعار تجريبي بعد ${Math.round(delayMs / 1000)} ثوانٍ`);
      setTimeout(() => {
        showLocalNotification("اختبار مؤجّل ✅", "إذا ظهر هذا في التنبيهات/شاشة القفل فالإعداد صحيح");
      }, delayMs);
      return;
    }
    const sent = await showLocalNotification(
      "اختبار إشعار مهامي ✅",
      "إذا رأيت هذا في مركز الإشعارات أو شاشة القفل فالإعدادات تعمل"
    );
    toast(sent ? "تم إرسال إشعار تجريبي" : "تعذر إرسال الإشعار");
  }

  async function checkDueReminders() {
    const now = Date.now();
    const items = buildReminderNotificationEvents().filter((r) => !r.past || (now - r.at) < 60000);
    for (const r of items) {
      if (r.at > now) continue;
      if (state.firedReminderIds.includes(r.id)) continue;
      if (now - r.at > 10 * 60 * 1000) {
        state.firedReminderIds.push(r.id);
        continue;
      }
      const prefix = r.priority === "urgent" ? "🔥 عاجل: " : "⏰ تذكير: ";
      await showLocalNotification(prefix + r.title, "حان وقت التذكير من تطبيق مهامي", r.id);
      state.firedReminderIds.push(r.id);
      save();
    }
    if (state.firedReminderIds.length > 300) {
      state.firedReminderIds = state.firedReminderIds.slice(-150);
      save();
    }
    await syncScheduleToServiceWorker();
    try {
      const reg = swRegistration || (await navigator.serviceWorker?.ready);
      reg?.active?.postMessage({ type: "CHECK_DUE" });
    } catch { /* ignore */ }
  }

  async function registerPeriodicSync() {
    try {
      const reg = swRegistration || (await navigator.serviceWorker?.ready);
      if (!reg?.periodicSync) return;
      const tags = await reg.periodicSync.getTags();
      if (!tags.includes("mahami-reminders")) {
        await reg.periodicSync.register("mahami-reminders", { minInterval: 15 * 60 * 1000 });
      }
    } catch { /* unsupported */ }
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

    $$(".chip").forEach((c) => c.addEventListener("click", () => {
      $$(".chip").forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      currentFilter = c.dataset.filter;
      renderTasks();
    }));

    $("#sortTasks").addEventListener("change", renderTasks);

    $("#fabAdd")?.remove?.();
    $("#modalBackdrop").addEventListener("click", closeAllSheets);

    $("#quickActions")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-add]");
      if (!btn) return;
      handleAddAction(btn.dataset.add);
    });

    $("#btnCancelTask").addEventListener("click", closeAllSheets);
    $("#btnCancelGoal").addEventListener("click", closeAllSheets);
    $("#btnCancelPlan").addEventListener("click", closeAllSheets);
    $("#btnCancelRem").addEventListener("click", closeAllSheets);

    $$("input[name='remType']").forEach((r) => {
      r.addEventListener("change", syncReminderTypeFields);
    });

    $("#taskReminder").addEventListener("change", (e) => {
      $("#reminderFields").hidden = !e.target.checked;
    });

    $("#btnAddStep").addEventListener("click", () => {
      const texts = readStepsEditorLive();
      texts.push({ text: "", done: false });
      renderStepsEditor(texts);
    });

    $("#stepsEditor").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-step]");
      if (!btn) return;
      const idx = Number(btn.dataset.removeStep);
      const texts = readStepsEditorLive();
      texts.splice(idx, 1);
      renderStepsEditor(texts.length ? texts : [{ text: "", done: false }]);
    });

    $("#btnAddPhase").addEventListener("click", () => {
      const texts = readPhasesEditorLive();
      texts.push({ text: "", done: false });
      renderPhasesEditor(texts);
    });

    $("#planPhasesEditor").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-phase]");
      if (!btn) return;
      const idx = Number(btn.dataset.removePhase);
      const texts = readPhasesEditorLive();
      texts.splice(idx, 1);
      renderPhasesEditor(texts.length ? texts : [{ text: "", done: false }]);
    });

    $("#taskForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = $("#taskId").value || null;
      const title = $("#taskTitle").value.trim();
      if (!title) return;
      let reminderAt = null;
      if ($("#taskReminder").checked) {
        const rd = $("#reminderDate").value;
        const rt = $("#reminderTime").value || "09:00";
        if (rd) reminderAt = new Date(`${rd}T${rt}:00`).getTime();
        const ok = await ensureNotifyPermission();
        if (!ok) toast("تم الحفظ، لكن الإشعارات غير مفعّلة");
      }
      const steps = readStepsEditor();
      const pct = steps.length
        ? Math.round((steps.filter((s) => s.done).length / steps.length) * 100)
        : 0;
      upsertTask({
        id,
        title,
        desc: $("#taskDesc").value.trim(),
        date: $("#taskDate").value,
        time: $("#taskTime").value,
        priority: ($("input[name='priority']:checked") || {}).value || "normal",
        goalId: $("#taskGoal").value,
        steps,
        reminderAt,
        done: pct === 100,
      });
      closeAllSheets();
      toast(id ? "تم تحديث المهمة" : "تمت إضافة المهمة");
      setTab("tasks");
    });

    $("#goalForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const id = $("#goalId").value || null;
      upsertGoal({
        id,
        title: $("#goalTitle").value.trim(),
        desc: $("#goalDesc").value.trim(),
        deadline: $("#goalDeadline").value,
      });
      closeAllSheets();
      toast(id ? "تم تحديث الهدف" : "تمت إضافة الهدف");
      setTab("goals");
    });

    $("#planForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const id = $("#planId").value || null;
      upsertPlan({
        id,
        title: $("#planTitle").value.trim(),
        desc: $("#planDesc").value.trim(),
        start: $("#planStart").value,
        end: $("#planEnd").value,
        phases: readPhasesEditor(),
      });
      closeAllSheets();
      toast(id ? "تم تحديث الخطة" : "تمت إضافة الخطة");
      setTab("plans");
    });

    $("#reminderForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = $("#remTitle").value.trim();
      if (!title) return;
      const id = $("#remId").value || null;
      const type = ($("input[name='remType']:checked") || {}).value || "once";
      await ensureNotifyPermission();

      if (type === "daily") {
        const startDate = $("#remStartDate").value;
        const endDate = $("#remEndDate").value;
        const time = $("#remDailyTime").value || "09:00";
        if (!startDate || !endDate || !time) {
          toast("أكمل تواريخ ووقت التذكير اليومي");
          return;
        }
        if (endDate < startDate) {
          toast("تاريخ النهاية يجب أن يكون بعد تاريخ البداية");
          return;
        }
        upsertStandaloneReminder({
          id,
          title,
          type: "daily",
          startDate,
          endDate,
          time,
          at: null,
        });
        closeAllSheets();
        toast(id ? "تم تحديث التذكير اليومي" : "تم حفظ التذكير اليومي");
        setTab("reminders");
        return;
      }

      const date = $("#remDate").value;
      const time = $("#remTime").value;
      const at = timestampFromISOAndTime(date, time);
      if (!at) {
        toast("أكمل تاريخ ووقت التذكير");
        return;
      }
      upsertStandaloneReminder({ id, title, type: "once", at });
      closeAllSheets();
      toast(id ? "تم تحديث التذكير" : "تم حفظ التذكير");
      setTab("reminders");
    });

    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (!el) return;
      const { action, id } = el.dataset;
      const idx = el.dataset.idx !== undefined ? Number(el.dataset.idx) : null;

      if (action === "toggle-task") toggleTask(id);
      if (action === "toggle-step") toggleStep(id, idx);
      if (action === "edit-task") {
        const task = state.tasks.find((t) => t.id === id);
        if (task) openTaskModal(task);
      }
      if (action === "delete-task") deleteTask(id);
      if (action === "edit-goal") {
        const goal = state.goals.find((g) => g.id === id);
        if (goal) openGoalModal(goal);
      }
      if (action === "delete-goal") deleteGoal(id);
      if (action === "edit-plan") {
        const plan = state.plans.find((p) => p.id === id);
        if (plan) openPlanModal(plan);
      }
      if (action === "delete-plan") deletePlan(id);
      if (action === "toggle-phase") togglePhase(id, idx);
      if (action === "edit-reminder") {
        const rem = state.reminders.find((r) => r.id === id);
        if (rem) openReminderModal(rem);
      }
      if (action === "delete-reminder") deleteReminder(id);
    });

    $("#btnNotify")?.addEventListener("click", () => ensureNotifyPermission());
    $("#btnEnableNotify")?.addEventListener("click", () => ensureNotifyPermission());
    $("#btnTestNotify")?.addEventListener("click", () => sendTestNotification(0));
    $("#btnTestNotifySoon")?.addEventListener("click", () => sendTestNotification(10000));
    $("#btnTheme")?.addEventListener("click", toggleTheme);

    $("#btnExportData")?.addEventListener("click", exportData);
    $("#btnImportData")?.addEventListener("click", () => $("#importFileInput")?.click());
    $("#importFileInput")?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      await importDataFromFile(file);
    });
    $("#btnClearData")?.addEventListener("click", clearAllData);

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      const installBtn = $("#btnInstall");
      if (installBtn) installBtn.hidden = false;
    });

    $("#btnInstall")?.addEventListener("click", async () => {
      if (!deferredInstallPrompt) {
        toast("للتثبيت: من قائمة المتصفح اختر «إضافة إلى الشاشة الرئيسية»");
        return;
      }
      try {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
      } catch { /* ignore */ }
      deferredInstallPrompt = null;
      const installBtn = $("#btnInstall");
      if (installBtn) installBtn.hidden = true;
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        checkDueReminders();
        render();
      } else {
        saveNow();
      }
    });

    window.addEventListener("pagehide", saveNow);
    window.addEventListener("online", () => toast("عاد الاتصال"));
  }

  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      swRegistration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      await navigator.serviceWorker.ready;
      // تحديث فوري للنسخة الجديدة من SW
      swRegistration.update?.();
      await syncScheduleToServiceWorker();
      await registerPeriodicSync();
      updateNotifyStatus();
    } catch (err) {
      console.warn("SW failed", err);
    }
  }

  function seedIfEmpty() {
    if (state.tasks.length || state.goals.length || state.plans.length) return;
    const goalId = uid();
    state.goals.push({
      id: goalId,
      title: "تنظيم يومي أفضل",
      desc: "هدف تجريبي للبدء",
      deadline: todayISO(),
      createdAt: Date.now(),
    });
    state.tasks.push({
      id: uid(),
      title: "مراجعة مهام اليوم",
      desc: "مهمّة تجريبية متعددة الخطوات",
      date: todayISO(),
      time: "10:00",
      priority: "urgent",
      goalId,
      steps: [
        { text: "فتح قائمة المهام", done: true },
        { text: "تحديد الأولويات", done: false },
        { text: "بدء أول مهمة عاجلة", done: false },
      ],
      reminderAt: null,
      done: false,
      createdAt: Date.now(),
    });
    state.plans.push({
      id: uid(),
      title: "خطة هذا الأسبوع",
      desc: "نموذج لخطة متعددة المراحل",
      start: todayISO(),
      end: "",
      phases: [
        { text: "تحديد الأهداف", done: true },
        { text: "توزيع المهام", done: false },
        { text: "مراجعة التقدم", done: false },
      ],
      createdAt: Date.now(),
    });
    save();
  }

  function lockMobileViewport() {
    const setAppHeight = () => {
      const h = window.visualViewport?.height || window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${Math.round(h)}px`);
    };
    setAppHeight();
    window.addEventListener("resize", setAppHeight, { passive: true });
    window.addEventListener("orientationchange", () => setTimeout(setAppHeight, 120));
    window.visualViewport?.addEventListener("resize", setAppHeight, { passive: true });
    window.visualViewport?.addEventListener("scroll", setAppHeight, { passive: true });

    // منع الزوم بإصبعين على iOS
    document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
    document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
    document.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false });

    let lastTouchEnd = 0;
    document.addEventListener("touchend", (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });

    document.addEventListener("touchmove", (e) => {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    }, { passive: false });
  }

  function init() {
    try {
      applyTheme(localStorage.getItem(THEME_KEY) || getTheme());
    } catch {
      applyTheme(getTheme());
    }
    lockMobileViewport();
    seedIfEmpty();
    bindEvents();
    render();
    updateNotifyStatus();
    registerSW().then(() => {
      checkDueReminders();
      syncScheduleToServiceWorker();
      updateNotifyStatus();
    });
    setInterval(checkDueReminders, CHECK_INTERVAL_MS);

    if ("permissions" in navigator && navigator.permissions?.query) {
      navigator.permissions.query({ name: "notifications" }).then((p) => {
        p.onchange = updateNotifyStatus;
      }).catch(() => {});
    }

    window.addEventListener("focus", () => {
      checkDueReminders();
      updateNotifyStatus();
    });

    window.addEventListener("error", () => {
      try { saveNow(); } catch { /* ignore */ }
    });
  }

  init();
})();
