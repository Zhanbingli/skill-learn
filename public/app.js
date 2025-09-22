const state = {
  data: null,
  startDate: null,
  progress: {},
  ritual: {},
  logs: {}
};

let statusTimer = null;

document.addEventListener("DOMContentLoaded", bootstrap);

async function bootstrap() {
  setStatus("正在加载路线…", "info");
  try {
    const [roadmapRes, stateRes] = await Promise.all([
      fetch("/api/roadmap"),
      fetch("/api/state")
    ]);

    if (!roadmapRes.ok) {
      throw new Error("无法加载路线数据");
    }
    state.data = await roadmapRes.json();

    if (stateRes.ok) {
      const saved = await stateRes.json();
      assignState(saved);
    } else if (stateRes.status !== 404) {
      throw new Error("无法加载学习进度");
    }

    initControls();
    render();
    setStatus("准备就绪，开始冲刺吧！", "success", 1500);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "初始化失败，请检查服务是否运行", "error");
  }
}

function assignState(payload = {}) {
  state.startDate = payload.startDate || null;
  state.progress = payload.progress || {};
  state.ritual = payload.ritual || {};
  state.logs = payload.logs || {};
}

function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function snapshotState() {
  return {
    startDate: state.startDate,
    progress: deepClone(state.progress) || {},
    ritual: deepClone(state.ritual) || {},
    logs: deepClone(state.logs) || {}
  };
}

async function withOptimisticUpdate(mutator, partialFactory) {
  const snapshot = snapshotState();
  mutator();
  render();
  try {
    const partial = typeof partialFactory === "function" ? partialFactory() : partialFactory;
    await persistState(partial);
    render();
  } catch (error) {
    assignState(snapshot);
    render();
    handleError(error);
  }
}

async function persistState(partial) {
  setStatus("正在保存…", "info");
  const response = await fetch("/api/state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(partial)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "保存失败");
  }

  const payload = await response.json();
  assignState(payload);
  setStatus("保存完成 ✔️", "success", 1200);
}

function handleError(error) {
  console.error(error);
  setStatus(error.message || "操作失败，请稍后再试", "error");
}

function setStatus(message, tone = "info", timeout = 0) {
  const banner = document.getElementById("status-banner");
  if (!banner) return;

  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }

  if (!message) {
    banner.textContent = "";
    banner.classList.remove("visible");
    return;
  }

  banner.textContent = message;
  banner.dataset.tone = tone;
  banner.classList.add("visible");

  if (timeout > 0) {
    statusTimer = setTimeout(() => {
      banner.textContent = "";
      banner.classList.remove("visible");
    }, timeout);
  }
}

function initControls() {
  const startInput = document.getElementById("start-date");
  if (state.startDate) {
    startInput.value = state.startDate;
  }

  document.getElementById("save-start").addEventListener("click", () => {
    const value = startInput.value;
    if (!value) return;
    withOptimisticUpdate(
      () => {
        state.startDate = value;
      },
      () => ({ startDate: value })
    );
  });

  document.getElementById("reset-ritual").addEventListener("click", () => {
    const todayKey = today();
    withOptimisticUpdate(
      () => {
        state.ritual = {
          ...state.ritual,
          [todayKey]: {}
        };
      },
      () => ({ ritual: deepClone(state.ritual) || {} })
    );
  });

  document.getElementById("save-log").addEventListener("click", () => {
    const text = document.getElementById("log-input").value.trim();
    if (!text) return;
    const todayKey = today();
    withOptimisticUpdate(
      () => {
        state.logs = {
          ...state.logs,
          [todayKey]: text
        };
      },
      () => ({ logs: deepClone(state.logs) || {} })
    );
  });

  document.getElementById("export-log").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.logs, null, 2)], {
      type: "application/json"
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "skill-sprint-log.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  document.getElementById("log-template").addEventListener("click", () => {
    const todayKey = today();
    if (state.logs[todayKey]) {
      const input = document.getElementById("log-input");
      input.value = state.logs[todayKey];
      input.focus();
      setStatus("已载入今日日志，可继续补充", "info", 1500);
      return;
    }

    const template = defaultLogTemplate();
    withOptimisticUpdate(
      () => {
        state.logs = {
          ...state.logs,
          [todayKey]: template
        };
      },
      () => ({ logs: deepClone(state.logs) || {} })
    );

    const input = document.getElementById("log-input");
    input.value = template;
    input.focus();
    setStatus("已填充日志模板，补充后可再次保存", "success", 1800);
  });

  document.getElementById("toggle-backlog").addEventListener("click", (event) => {
    const el = document.getElementById("backlog");
    const button = event.currentTarget;
    el.classList.toggle("hidden");
    button.textContent = el.classList.contains("hidden") ? "展开" : "收起";
  });
}

function render() {
  if (!state.data) return;
  renderToday();
  renderOverallProgress();
  renderNudges();
  renderRitual();
  renderWeek();
  renderLog();
  renderBacklog();
}

function renderToday() {
  const container = document.getElementById("today-summary");
  container.innerHTML = "";

  const start = parseStartDate();
  if (!start) {
    container.innerHTML = `
      <p>首次使用？一键设定路线起跑日并生成今日日志模板。</p>
      <div class="quick-start">
        <p>选择今天或下周一开始，后续仍可在右上角的日期中调整。</p>
        <button data-quick-start="today">今天开始</button>
        <button data-quick-start="monday" class="secondary">下周一开始</button>
      </div>
    `;
    container
      .querySelectorAll("button[data-quick-start]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          handleQuickStart(button.dataset.quickStart);
        });
      });
    return;
  }

  const info = locateWeek(start, new Date());
  if (!info) {
    container.innerHTML = "<p>你已完成 16 周计划，恭喜！🎉</p>";
    return;
  }

  container.innerHTML = `
    <p><strong>${formatDate(new Date())}</strong></p>
    <p>当前：${info.phase.title} ｜ 第 ${info.week.number} 周</p>
    <p>主题：${info.week.theme}</p>
  `;
}

function renderOverallProgress() {
  const container = document.getElementById("overall-progress");
  const counts = computeProgressCounts();
  const total = counts.total || 1;
  const percent = Math.round((counts.done / total) * 100);

  container.innerHTML = `
    <p>${counts.done} 已完成 · ${counts.inFlight} 进行中 · ${counts.todo} 待完成</p>
    <div class="progress-bar"><span style="width: ${percent}%"></span></div>
    <small>坚持每日可见产出：小进步会累积成巨大信心。</small>
  `;
}

function renderNudges() {
  const container = document.getElementById("nudges");
  const messages = [];

  const start = parseStartDate();
  if (!start) {
    messages.push("点击“今天开始/下周一开始”，即可生成属于你的路线节奏。");
  }

  const todayKey = today();
  const ritual = state.ritual[todayKey] || {};
  const ritualTargets = ["deep", "artifact", "micro", "review"];
  const ritualDone = ritualTargets.filter((key) => ritual[key]);
  if (ritualDone.length < ritualTargets.length) {
    const remaining = ritualTargets.length - ritualDone.length;
    messages.push(`还有 ${remaining} 个每日仪式待完成。`);
  }

  if (!state.logs[todayKey]) {
    messages.push("写一段 micro log 记录当日亮点。");
  }

  const counts = computeProgressCounts();
  if (counts.todo === 0 && counts.done > 0) {
    messages.push("太棒了，所有任务都完成！写个 retro 奖励一下自己。");
  } else if (counts.done === 0) {
    messages.push("从最小的下一步开始，完成后记得标记完成。");
  }

  container.innerHTML = messages
    .map((msg) => `<p>• ${msg}</p>`)
    .join("") || "<p>状态良好，保持节奏 ✔️</p>";
}

function renderRitual() {
  const list = document.getElementById("ritual-list");
  const metrics = document.getElementById("ritual-metrics");
  const todayKey = today();
  const ritualState = state.ritual[todayKey] || {};

  const items = buildRitualItems();
  list.innerHTML = "";

  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "ritual-item";

    const label = document.createElement("label");
    label.setAttribute("for", item.id);
    label.innerHTML = `${item.label}<span>${item.detail}</span>`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = item.id;
    checkbox.checked = Boolean(ritualState[item.id]);
    checkbox.addEventListener("change", () => {
      withOptimisticUpdate(
        () => {
          const current = state.ritual[todayKey] || {};
          state.ritual = {
            ...state.ritual,
            [todayKey]: {
              ...current,
              [item.id]: checkbox.checked
            }
          };
        },
        () => ({ ritual: deepClone(state.ritual) || {} })
      );
    });

    li.append(label, checkbox);
    list.appendChild(li);
  });

  const complete = items.filter((item) => ritualState[item.id]).length;
  const hints = state.data.daily_ritual.habits.join(" · ");
  metrics.innerHTML = `
    <span>今日仪式完成度：${complete}/${items.length}</span>
    <span>习惯提醒：${hints}</span>
  `;
}

function buildRitualItems() {
  const ritual = state.data.daily_ritual;
  return [
    {
      id: "review",
      label: `开场复盘 · ${ritual.review_minutes}′`,
      detail: "回顾昨日 commit，锁定今日唯一产出"
    },
    {
      id: "deep",
      label: `深工制造 · ${ritual.deep_work_minutes}′`,
      detail: "关闭干扰，用计时器守住 70 分钟"
    },
    {
      id: "artifact",
      label: `可见产出 · ${ritual.artifact_minutes}′`,
      detail: "提交代码、图表或 README，留下痕迹"
    },
    {
      id: "micro",
      label: `英文 micro post · ${ritual.micro_post_minutes}′`,
      detail: "记录坑点与修复，方便复盘"
    }
  ];
}

function renderWeek() {
  const start = parseStartDate();
  const phaseLabel = document.getElementById("phase-label");
  const weekLabel = document.getElementById("week-label");
  const theme = document.getElementById("week-theme");
  const milestoneList = document.getElementById("milestone-list");
  const taskList = document.getElementById("task-list");

  if (!start) {
    phaseLabel.textContent = "";
    weekLabel.textContent = "";
    theme.textContent = "";
    milestoneList.innerHTML = "";
    taskList.innerHTML = "";
    return;
  }

  const info = locateWeek(start, new Date());
  if (!info) {
    phaseLabel.textContent = "路线完成";
    weekLabel.textContent = "🎉";
    theme.textContent = "恭喜完成所有阶段，准备写总结吧。";
    milestoneList.innerHTML = "";
    taskList.innerHTML = "";
    return;
  }

  phaseLabel.textContent = info.phase.title;
  weekLabel.textContent = `第 ${info.week.number} 周`;
  theme.textContent = info.week.theme;

  milestoneList.innerHTML = info.week.milestones
    .map((item) => `<li>${item}</li>`)
    .join("");

  taskList.innerHTML = "";
  info.week.tasks.forEach((task) => {
    const card = document.createElement("article");
    card.className = "task-card";
    const status = state.progress[task.id];
    if (status === "done") {
      card.classList.add("done");
    }

    const header = document.createElement("header");
    const title = document.createElement("h4");
    title.textContent = task.title;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = kindLabel(task.kind);
    header.append(title, badge);

    const details = document.createElement("p");
    details.className = "task-details";
    details.textContent = task.details || "";

    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.innerHTML = `状态：${statusLabel(status)}${deadlineHint(task.id, start)}`;

    const actions = document.createElement("div");
    actions.className = "task-actions";
    const doneBtn = document.createElement("button");
    doneBtn.textContent = status === "done" ? "已完成" : "标记完成";
    doneBtn.disabled = status === "done";
    doneBtn.addEventListener("click", () => {
      if (status === "done") return;
      updateTaskStatus(task.id, "done");
    });

    const snoozeBtn = document.createElement("button");
    snoozeBtn.className = "secondary";
    snoozeBtn.textContent = status === "snoozed" ? "已延后" : "推迟到下周";
    snoozeBtn.addEventListener("click", () => {
      const next = status === "snoozed" ? null : "snoozed";
      updateTaskStatus(task.id, next);
    });

    actions.append(doneBtn, snoozeBtn);
    card.append(header, details, meta, actions);

    if (task.resources && task.resources.length) {
      const res = document.createElement("div");
      res.className = "resource-links";
      task.resources.forEach((link) => {
        const a = document.createElement("a");
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = link.label;
        res.appendChild(a);
      });
      card.appendChild(res);
    }

    taskList.appendChild(card);
  });
}

function renderLog() {
  const todayKey = today();
  const input = document.getElementById("log-input");
  input.value = state.logs[todayKey] || "";

  const saved = document.getElementById("saved-log");
  const entries = Object.entries(state.logs)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, 6)
    .map(([date, text]) => `【${date}】\n${text}`);
  saved.textContent = entries.join("\n\n");
}

function renderBacklog() {
  const container = document.getElementById("backlog");
  container.innerHTML = "";

  state.data.phases.forEach((phase) => {
    const phaseEl = document.createElement("div");
    phaseEl.className = "backlog-phase";
    const title = document.createElement("h3");
    title.textContent = phase.title;
    const summary = document.createElement("p");
    summary.textContent = phase.summary;
    phaseEl.append(title, summary);

    phase.weeks.forEach((week) => {
      const weekEl = document.createElement("div");
      weekEl.className = "backlog-week";
      const head = document.createElement("strong");
      head.textContent = `Week ${week.number} · ${week.theme}`;
      weekEl.appendChild(head);

      const mile = document.createElement("p");
      mile.textContent = `Milestones: ${week.milestones.join(" · ")}`;
      weekEl.appendChild(mile);

      const innerList = document.createElement("ul");
      innerList.style.margin = "0";
      innerList.style.paddingLeft = "18px";
      week.tasks.forEach((task) => {
        const li = document.createElement("li");
        const status = state.progress[task.id];
        li.textContent = `${task.title} (${statusLabel(status)})`;
        innerList.appendChild(li);
      });
      weekEl.appendChild(innerList);
      phaseEl.appendChild(weekEl);
    });

    container.appendChild(phaseEl);
  });
}

function updateTaskStatus(taskId, status) {
  withOptimisticUpdate(
    () => {
      if (!status) {
        const next = deepClone(state.progress) || {};
        delete next[taskId];
        state.progress = next;
      } else {
        state.progress = {
          ...state.progress,
          [taskId]: status
        };
      }
    },
    () => ({ progress: deepClone(state.progress) || {} })
  );
}

function parseStartDate() {
  if (!state.startDate) return null;
  const parsed = new Date(state.startDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function locateWeek(startDate, currentDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((toMidnight(currentDate) - toMidnight(startDate)) / msPerDay);
  if (diffDays < 0) {
    return {
      phase: state.data.phases[0],
      week: state.data.phases[0].weeks[0]
    };
  }

  const weekIndex = Math.floor(diffDays / 7);
  let tracker = 0;
  for (const phase of state.data.phases) {
    for (const week of phase.weeks) {
      if (tracker === weekIndex) {
        return { phase, week, offset: tracker };
      }
      tracker += 1;
    }
  }
  return null;
}

function computeProgressCounts() {
  let total = 0;
  let done = 0;
  let snoozed = 0;
  state.data.phases.forEach((phase) => {
    phase.weeks.forEach((week) => {
      week.tasks.forEach((task) => {
        total += 1;
        if (state.progress[task.id] === "done") done += 1;
        if (state.progress[task.id] === "snoozed") snoozed += 1;
      });
    });
  });
  return {
    total,
    done,
    inFlight: snoozed,
    todo: total - done - snoozed
  };
}

function kindLabel(kind) {
  switch (kind) {
    case "project":
      return "作品";
    case "practice":
      return "练习";
    case "output":
      return "输出";
    case "habit":
      return "习惯";
    case "deliverable":
      return "交付物";
    default:
      return "任务";
  }
}

function statusLabel(status) {
  if (status === "done") return "✅ 已完成";
  if (status === "snoozed") return "⏭ 已延后";
  return "⚪ 待完成";
}

function deadlineHint(taskId, start) {
  const info = locateTask(taskId);
  if (!info) return "";
  const weekStart = addDays(start, (info.offset ?? 0) * 7);
  const weekEnd = addDays(weekStart, 6);
  return ` ｜ 推荐区间：${formatDate(weekStart)} - ${formatDate(weekEnd)}`;
}

function locateTask(targetId) {
  let offset = 0;
  for (const phase of state.data.phases) {
    for (const week of phase.weeks) {
      for (const task of week.tasks) {
        if (task.id === targetId) {
          return { phase, week, offset };
        }
      }
      offset += 1;
    }
  }
  return null;
}

function today() {
  return formatDate(new Date());
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function addDays(date, offset) {
  const result = new Date(date);
  result.setDate(result.getDate() + offset);
  return result;
}

function handleQuickStart(mode) {
  const base = new Date();
  const chosen = mode === "monday" ? upcomingMonday(base) : base;
  const dateString = formatDate(chosen);
  const todayKey = today();
  const shouldSeedLog = !state.logs[todayKey];

  withOptimisticUpdate(
    () => {
      state.startDate = dateString;
      if (shouldSeedLog) {
        state.logs = {
          ...state.logs,
          [todayKey]: defaultLogTemplate()
        };
      }
    },
    () => {
      const payload = { startDate: dateString };
      if (shouldSeedLog) {
        payload.logs = deepClone(state.logs) || {};
      }
      return payload;
    }
  );
}

function upcomingMonday(date) {
  const clone = new Date(date);
  const day = clone.getDay();
  const offset = (8 - day) % 7;
  if (offset > 0) {
    clone.setDate(clone.getDate() + offset);
  }
  if (clone.getDay() === 0) {
    clone.setDate(clone.getDate() + 1);
  }
  return clone;
}

function defaultLogTemplate() {
  return [
    "## 今日亮点",
    "- ",
    "",
    "## 阻碍 / 待解决",
    "- ",
    "",
    "## 下一步",
    "- "
  ].join("\n");
}
