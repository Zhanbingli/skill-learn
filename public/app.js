const PERSIST_KEYS = {
  backlog: "skill-sprint/backlogExpanded",
  focusMode: "skill-sprint/focusMode",
  taskFilter: "skill-sprint/taskFilter"
};

const TASK_FILTERS = new Set(["all", "todo", "done", "snoozed"]);

const state = {
  data: null,
  startDate: null,
  progress: {},
  progressHistory: [],
  ritual: {},
  logs: {},
  portfolio: {
    username: "",
    lastSync: null,
    items: [],
    summary: { totalItems: 0, totalStars: 0, topLanguages: [] }
  },
  insights: null,
  agentPlan: null,
  currentWeek: null
};

let statusTimer = null;
const ui = {
  backlogExpanded: false,
  focusMode: false,
  taskFilter: "all",
  agentBusy: false
};

initializeUiState();

document.addEventListener("DOMContentLoaded", bootstrap);

function initializeUiState() {
  try {
    const storedBacklog = localStorage.getItem(PERSIST_KEYS.backlog);
    if (storedBacklog != null) {
      ui.backlogExpanded = storedBacklog === "true";
    }
    const storedFocus = localStorage.getItem(PERSIST_KEYS.focusMode);
    if (storedFocus != null) {
      ui.focusMode = storedFocus === "true";
    }
    const storedFilter = localStorage.getItem(PERSIST_KEYS.taskFilter);
    if (storedFilter && TASK_FILTERS.has(storedFilter)) {
      ui.taskFilter = storedFilter;
    }
  } catch (error) {
    console.warn("ui state init fallback", error);
  }
}

async function bootstrap() {
  setStatus("正在加载路线…", "info");
  applyFocusMode();
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

    await Promise.all([refreshInsights(), refreshPortfolio()]);

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
  state.progressHistory = Array.isArray(payload.progressHistory)
    ? payload.progressHistory
    : [];
  state.ritual = payload.ritual || {};
  state.logs = payload.logs || {};
  if (payload.portfolio) {
    assignPortfolio(payload.portfolio);
  }
}

function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function snapshotState() {
  return {
    startDate: state.startDate,
    progress: deepClone(state.progress) || {},
    ritual: deepClone(state.ritual) || {},
    logs: deepClone(state.logs) || {},
    portfolio: deepClone(state.portfolio) || {}
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
  await refreshInsights();
  setStatus("保存完成 ✔️", "success", 1200);
}

async function refreshInsights(showToast = false) {
  try {
    const response = await fetch("/api/insights");
    if (!response.ok) {
      throw new Error("洞察数据获取失败");
    }
    const data = await response.json();
    state.insights = data;

    if (data?.portfolio) {
      const incoming = data.portfolio;
      state.portfolio.summary = incoming.summary || computePortfolioSummary(state.portfolio.items);
      if (incoming.items && incoming.items.length) {
        state.portfolio.items = incoming.items;
      }
      if (incoming.username) {
        state.portfolio.username = incoming.username;
      }
      if (incoming.lastSync) {
        state.portfolio.lastSync = incoming.lastSync;
      }
    }

    renderWeek();

    if (showToast) {
      setStatus("洞察已刷新", "success", 1200);
    }
  } catch (error) {
    console.error(error);
    if (showToast) {
      setStatus(error.message || "洞察刷新失败", "error", 2000);
    }
  }
}

async function refreshPortfolio() {
  try {
    const response = await fetch("/api/portfolio");
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    assignPortfolio(data);
  } catch (error) {
    console.warn("portfolio fetch skipped", error);
  }
}

async function syncPortfolio(username) {
  try {
    setStatus("正在同步作品集…", "info");
    const response = await fetch("/api/portfolio/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ provider: "github", username, limit: 12 })
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "作品集同步失败");
    }

    const payload = await response.json();
    assignPortfolio(payload);
    await refreshInsights();
    renderPortfolio();
    renderInsights();
    setStatus("作品集已同步 ✔️", "success", 1600);
  } catch (error) {
    handleError(error);
  }
}

function assignPortfolio(payload = {}) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  state.portfolio = {
    username: payload.username || state.portfolio.username || "",
    lastSync: payload.lastSync || null,
    items,
    summary: payload.summary || computePortfolioSummary(items)
  };
}

function computePortfolioSummary(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { totalItems: 0, totalStars: 0, topLanguages: [] };
  }

  const totalStars = items.reduce((acc, item) => acc + (item.stars || 0), 0);
  const languageMap = new Map();
  items.forEach((item) => {
    if (!item || typeof item !== "object") return;
    if (item.language) {
      const key = item.language;
      languageMap.set(key, (languageMap.get(key) || 0) + 1);
    }
    if (Array.isArray(item.topics)) {
      item.topics.forEach((topic) => {
        if (!topic) return;
        const key = `#${topic}`;
        languageMap.set(key, (languageMap.get(key) || 0) + 0.2);
      });
    }
  });

  const topLanguages = Array.from(languageMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([language, count]) => ({ language, count: Math.round(count) }));

  return {
    totalItems: items.length,
    totalStars,
    topLanguages
  };
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

  const focusToggle = document.getElementById("toggle-focus-mode");
  if (focusToggle) {
    focusToggle.addEventListener("click", () => {
      ui.focusMode = !ui.focusMode;
      persistUiState();
      applyFocusMode();
    });
  }

  const jumpToLogButton = document.getElementById("jump-to-log");
  if (jumpToLogButton) {
    jumpToLogButton.addEventListener("click", () => {
      const logSection = document.getElementById("log-section");
      if (logSection) {
        logSection.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  const refreshButton = document.getElementById("refresh-insights");
  if (refreshButton) {
    refreshButton.addEventListener("click", async () => {
      await refreshInsights(true);
      renderInsights();
    });
  }

  const usernameInput = document.getElementById("portfolio-username");
  if (usernameInput && state.portfolio.username) {
    usernameInput.value = state.portfolio.username;
  }

  const syncButton = document.getElementById("sync-portfolio");
  if (syncButton) {
    const triggerSync = async () => {
      const value = usernameInput ? usernameInput.value.trim() : "";
      if (!value) {
        setStatus("请输入 GitHub 用户名", "error", 2000);
        if (usernameInput) usernameInput.focus();
        return;
      }
      await syncPortfolio(value);
    };

    syncButton.addEventListener("click", triggerSync);
    if (usernameInput) {
      usernameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          triggerSync();
        }
      });
    }
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
    ui.backlogExpanded = !ui.backlogExpanded;
    persistUiState();
    applyBacklogVisibility(event.currentTarget);
  });

  applyBacklogVisibility(document.getElementById("toggle-backlog"));

  const filterContainer = document.getElementById("task-filter");
  if (filterContainer) {
    filterContainer.querySelectorAll("button[data-filter]").forEach((button) => {
      const { filter } = button.dataset;
      button.addEventListener("click", () => {
        if (!filter || !TASK_FILTERS.has(filter) || filter === ui.taskFilter) return;
        ui.taskFilter = filter;
        persistUiState();
        updateTaskFilterButtons();
        renderWeek();
      });
    });
  }

  applyFocusMode();
  updateTaskFilterButtons();

  const agentGoalInput = document.getElementById("agent-goal");
  const agentRunButton = document.getElementById("agent-run");
  const agentDurationInput = document.getElementById("agent-duration");
  const agentFocusSelect = document.getElementById("agent-focus");
  const includeProgressInput = document.getElementById("agent-include-progress");
  const includeBacklogInput = document.getElementById("agent-include-backlog");
  const includeLogsInput = document.getElementById("agent-include-logs");

  const handleAgentTrigger = async () => {
    if (ui.agentBusy) return;
    const goal = agentGoalInput ? agentGoalInput.value.trim() : "";
    if (!goal) {
      setStatus("请先描述想启动的项目或问题", "error", 2200);
      if (agentGoalInput) {
        agentGoalInput.focus();
      }
      return;
    }
    const duration = agentDurationInput ? Number.parseInt(agentDurationInput.value, 10) : 5;
    const payload = {
      goal,
      duration: Number.isFinite(duration) ? Math.min(Math.max(duration, 1), 30) : 5,
      focus: agentFocusSelect ? agentFocusSelect.value : "build",
      includeProgress: includeProgressInput ? includeProgressInput.checked : true,
      includeBacklog: includeBacklogInput ? includeBacklogInput.checked : true,
      includeLogs: includeLogsInput ? includeLogsInput.checked : false
    };
    await runAgentPlan(payload);
  };

  if (agentRunButton) {
    agentRunButton.addEventListener("click", handleAgentTrigger);
  }

  if (agentGoalInput) {
    agentGoalInput.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        handleAgentTrigger();
      }
    });
  }

  const agentFillWeekButton = document.getElementById("agent-fill-week");
  if (agentFillWeekButton && agentGoalInput) {
    agentFillWeekButton.addEventListener("click", () => {
      const template = buildAgentWeekTemplate();
      if (!template) {
        setStatus("请先设置起始日，或等待路线加载完成", "error", 2200);
        return;
      }
      agentGoalInput.value = template;
      agentGoalInput.focus();
    });
  }
}

function render() {
  if (!state.data) return;
  renderToday();
  renderOverallProgress();
  renderNudges();
  renderRitual();
  renderWeek();
  renderLog();
  renderInsights();
  renderPortfolio();
  renderBacklog();
  renderAgentOutput();
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
  if (!container) return;

  let counts = computeProgressCounts();
  if (state.insights?.summary) {
    const summary = state.insights.summary;
    counts = {
      total: summary.totalTasks,
      done: summary.done,
      inFlight: summary.snoozed,
      todo: summary.todo
    };
  }

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

  const ritualStreak = state.insights?.streaks?.ritual?.current || 0;
  if (ritualStreak >= 3) {
    messages.push(`已连续 ${ritualStreak} 天完成每日仪式，保持势头！`);
  }

  const portfolioCount = state.portfolio.items?.length || 0;
  if (portfolioCount > 0) {
    messages.push(`作品集已有 ${portfolioCount} 项，如果有新成果，请记得点击同步更新。`);
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
  state.currentWeek = null;
  const info = start ? locateWeek(start, new Date()) : null;

  renderCommandBar(info);
  updateTaskFilterButtons();

  if (!start) {
    phaseLabel.textContent = "";
    weekLabel.textContent = "";
    theme.textContent = "";
    milestoneList.innerHTML = "";
    taskList.innerHTML = "";
    updateTaskStats({ total: 0, done: 0, snoozed: 0, todo: 0 });
    return;
  }

  if (!info) {
    phaseLabel.textContent = "路线完成";
    weekLabel.textContent = "🎉";
    theme.textContent = "恭喜完成所有阶段，准备写总结吧。";
    milestoneList.innerHTML = "";
    taskList.innerHTML = '<p class="empty-state">可以回顾 backlog 或沉淀复盘心得。</p>';
    updateTaskStats({ total: 0, done: 0, snoozed: 0, todo: 0 });
    return;
  }

  state.currentWeek = info;
  phaseLabel.textContent = info.phase.title;
  weekLabel.textContent = `第 ${info.week.number} 周`;
  theme.textContent = info.week.theme;

  milestoneList.innerHTML = info.week.milestones
    .map((item) => `<li>${item}</li>`)
    .join("");

  const counts = computeWeekTaskCounts(info.week);
  updateTaskStats(counts);

  const filter = ui.taskFilter;
  const filteredTasks = info.week.tasks.filter((task) => matchesTaskFilter(state.progress[task.id], filter));

  if (!filteredTasks.length) {
    taskList.innerHTML = '<p class="empty-state">当前筛选暂无任务，切换到“全部”查看完整清单。</p>';
    return;
  }

  taskList.innerHTML = "";
  filteredTasks.forEach((task) => {
    const card = document.createElement("article");
    card.className = "task-card";
    const status = state.progress[task.id];
    if (status === "done") {
      card.classList.add("done");
    } else if (status === "snoozed") {
      card.classList.add("snoozed");
    } else {
      card.classList.add("todo");
    }
    card.dataset.status = status || "todo";

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

function renderInsights() {
  const summaryEl = document.getElementById("insight-summary");
  const weeklyEl = document.getElementById("insight-weekly");
  const streakEl = document.getElementById("insight-streaks");
  const rangeEl = document.getElementById("insight-progress-range");
  if (!summaryEl || !weeklyEl || !streakEl) return;

  const insights = state.insights;
  if (!insights) {
    summaryEl.textContent = "暂无洞察数据，先完成一个任务或同步作品集试试。";
    weeklyEl.innerHTML = '<p class="muted">等待更多进度记录…</p>';
    streakEl.innerHTML = '<p class="muted">暂无连续统计</p>';
    if (rangeEl) rangeEl.textContent = "";
    drawLineChart("progress-chart", []);
    drawBarChart("ritual-chart", []);
    return;
  }

  const summary = insights.summary;
  summaryEl.innerHTML = `
    <strong>${summary.completionRate}%</strong> 完成率 ·
    ${summary.done}/${summary.totalTasks} 任务已完成 ·
    ${summary.todo} 待完成
  `;

  const weeklyCandidates = (insights.weekly || [])
    .slice()
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);

  weeklyEl.innerHTML = weeklyCandidates.length
    ? weeklyCandidates
        .map((week) => {
          const tag = escapeHtml(`第 ${week.week} 周`);
          return `<span class="weekly-pill">${tag} · ${week.percent}%</span>`;
        })
        .join("")
    : '<span class="weekly-pill">所有周已完成 🎉</span>';

  const progressSeries = (insights.charts?.progress || []).map((item) => ({
    label: item.date,
    value: item.done
  }));

  drawLineChart("progress-chart", progressSeries, {
    max: summary.totalTasks,
    stroke: "#2563eb"
  });

  if (rangeEl) {
    if (progressSeries.length > 1) {
      rangeEl.textContent = `${progressSeries[0].label} ~ ${progressSeries[progressSeries.length - 1].label}`;
    } else {
      rangeEl.textContent = progressSeries[0]?.label || "";
    }
  }

  const ritualSeries = (insights.charts?.ritual || []).map((item) => ({
    label: item.date,
    value: item.total > 0 ? Math.round((item.completed / item.total) * 100) : 0
  }));
  drawBarChart("ritual-chart", ritualSeries, {
    max: 100,
    fill: "rgba(37, 99, 235, 0.2)",
    stroke: "#2563eb"
  });

  const ritualStreak = insights.streaks?.ritual || { current: 0, longest: 0 };
  const logStreak = insights.streaks?.log || { current: 0, longest: 0 };

  streakEl.innerHTML = `
    <div class="streak-card">
      <strong>${ritualStreak.current}</strong>
      <span>每日仪式连续天</span>
    </div>
    <div class="streak-card">
      <strong>${logStreak.current}</strong>
      <span>日志连续天</span>
    </div>
    <small>历史最佳：仪式 ${ritualStreak.longest} 天 · 日志 ${logStreak.longest} 天</small>
  `;
}

function renderPortfolio() {
  const grid = document.getElementById("portfolio-grid");
  const meta = document.getElementById("portfolio-meta");
  if (!grid || !meta) return;

  const items = state.portfolio.items || [];
  const summary = state.portfolio.summary || computePortfolioSummary(items);
  const username = state.portfolio.username;
  const lastSyncText = state.portfolio.lastSync
    ? `上次同步：${formatRelativeDate(state.portfolio.lastSync)}`
    : "尚未同步";

  const languageHighlights = (summary.topLanguages || [])
    .filter((entry) => entry.language && !entry.language.startsWith("#"))
    .slice(0, 3)
    .map((entry) => entry.language)
    .join(" · ");

  const metaPieces = [lastSyncText, `${summary.totalItems} 个仓库`, `⭐️ ${summary.totalStars}`];
  if (languageHighlights) {
    metaPieces.push(`主力栈：${languageHighlights}`);
  }

  meta.textContent = items.length
    ? metaPieces.join(" ｜ ")
    : `尚未同步 GitHub 作品集，输入用户名后点击同步。`;

  if (!items.length) {
    grid.innerHTML = '<p class="muted">同步后将自动生成作品集列表。</p>';
    return;
  }

  grid.innerHTML = items
    .map((item) => {
      const title = escapeHtml(item.title || item.repo || "未命名仓库");
      const description = escapeHtml(item.description || "暂未填写描述");
      const url = typeof item.url === "string" && item.url.startsWith("http") ? item.url : "#";
      const language = escapeHtml(item.language || "");
      const updated = item.updatedAt ? formatRelativeDate(item.updatedAt) : "";
      const topics = Array.isArray(item.topics)
        ? item.topics
            .slice(0, 4)
            .map((topic) => `<span class="topic-tag">${escapeHtml(topic)}</span>`)
            .join("")
        : "";
      const topicsMarkup = topics ? `<div class="topic-row">${topics}</div>` : "";

      return `
        <article class="portfolio-card">
          <header>
            <a href="${url}" target="_blank" rel="noopener">${title}</a>
            <span class="stars">⭐️ ${item.stars || 0}</span>
          </header>
          <p>${description}</p>
          <footer>
            <span>${language || "多语言"}</span>
            <span>${updated}</span>
          </footer>
          ${topicsMarkup}
        </article>
      `;
    })
    .join("");

  if (username) {
    const usernameInput = document.getElementById("portfolio-username");
    if (usernameInput && !usernameInput.value) {
      usernameInput.value = username;
    }
  }
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

  applyBacklogVisibility(document.getElementById("toggle-backlog"));
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

function prepareCanvas(target) {
  const canvas = typeof target === "string" ? document.getElementById(target) : target;
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx, width, height };
}

function drawLineChart(canvasId, series, options = {}) {
  const prepared = prepareCanvas(canvasId);
  if (!prepared) return;
  const { ctx, width, height } = prepared;

  if (!Array.isArray(series) || series.length === 0) {
    drawEmptyChartPrepared(prepared, options.emptyMessage || "暂无数据");
    return;
  }

  const padding = options.padding ?? 16;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  const values = series.map((point) => point.value ?? 0);
  const maxValue = options.max ?? Math.max(...values, 1);
  const minValue = options.min ?? Math.min(...values, 0);
  const range = maxValue - minValue || 1;

  ctx.strokeStyle = options.stroke || "#2563eb";
  ctx.lineWidth = 2;
  ctx.beginPath();

  series.forEach((point, index) => {
    const ratio = series.length > 1 ? index / (series.length - 1) : 0;
    const x = padding + ratio * innerWidth;
    const value = (point.value ?? 0) - minValue;
    const y = height - padding - (value / range) * innerHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  ctx.fillStyle = options.pointColor || ctx.strokeStyle;
  series.forEach((point, index) => {
    const ratio = series.length > 1 ? index / (series.length - 1) : 0;
    const x = padding + ratio * innerWidth;
    const value = (point.value ?? 0) - minValue;
    const y = height - padding - (value / range) * innerHeight;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawBarChart(canvasId, series, options = {}) {
  const prepared = prepareCanvas(canvasId);
  if (!prepared) return;
  const { ctx, width, height } = prepared;

  if (!Array.isArray(series) || series.length === 0) {
    drawEmptyChartPrepared(prepared, options.emptyMessage || "暂无记录");
    return;
  }

  const padding = options.padding ?? 16;
  const gap = options.barGap ?? 6;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const values = series.map((point) => point.value ?? 0);
  const maxValue = options.max ?? Math.max(...values, 1);
  const barWidth = Math.max(6, (innerWidth - gap * (series.length - 1)) / series.length);

  ctx.fillStyle = options.fill || "rgba(37, 99, 235, 0.25)";
  ctx.strokeStyle = options.stroke || "#2563eb";
  ctx.lineWidth = 1;

  series.forEach((point, index) => {
    const value = Math.max(0, Math.min(maxValue, point.value ?? 0));
    const heightRatio = value / (maxValue || 1);
    const barHeight = innerHeight * heightRatio;
    const x = padding + index * (barWidth + gap);
    const y = height - padding - barHeight;
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.strokeRect(x, y, barWidth, barHeight);
  });
}

function drawEmptyChartPrepared(prepared, message) {
  if (!prepared) return;
  const { ctx, width, height } = prepared;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "12px 'Inter', 'Helvetica Neue', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(message, 16, height / 2);
}

function formatRelativeDate(value) {
  if (!value) return "";
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return String(value);
  }

  const now = new Date();
  const diffMs = now - date;
  const absMs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (absMs < minute) return "刚刚";
  if (absMs < hour) {
    const mins = Math.round(absMs / minute);
    return `${mins} 分钟前`;
  }
  if (absMs < day) {
    const hours = Math.round(absMs / hour);
    return `${hours} 小时前`;
  }
  const days = Math.round(absMs / day);
  if (days < 30) {
    return `${days} 天前`;
  }
  return formatDate(date);
}

function escapeHtml(input) {
  if (input == null) return "";
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };
  return String(input).replace(/[&<>"']/g, (char) => map[char]);
}

function persistUiState() {
  try {
    localStorage.setItem(PERSIST_KEYS.backlog, String(ui.backlogExpanded));
    localStorage.setItem(PERSIST_KEYS.focusMode, String(ui.focusMode));
    localStorage.setItem(PERSIST_KEYS.taskFilter, ui.taskFilter);
  } catch (error) {
    console.warn("ui state persist skipped", error);
  }
}

function applyFocusMode() {
  const focusClass = "focus-mode";
  if (document.body) {
    document.body.classList.toggle(focusClass, ui.focusMode);
  }
  const toggle = document.getElementById("toggle-focus-mode");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(ui.focusMode));
    toggle.classList.toggle("active", ui.focusMode);
    const label = toggle.querySelector(".label");
    if (label) {
      label.textContent = ui.focusMode ? "关闭专注模式" : "开启专注模式";
    }
  }
}

function updateTaskFilterButtons() {
  const container = document.getElementById("task-filter");
  if (!container) return;
  container.querySelectorAll("button[data-filter]").forEach((button) => {
    const value = button.dataset.filter;
    const isActive = value === ui.taskFilter;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
}

function updateTaskStats(counts = {}) {
  const statsEl = document.getElementById("task-stats");
  if (!statsEl) return;
  const total = counts.total ?? 0;
  const done = counts.done ?? 0;
  const snoozed = counts.snoozed ?? 0;
  const todo = counts.todo ?? Math.max(total - done - snoozed, 0);
  const segments = [
    `本周任务 ${total}`,
    `✔️ 已完成 ${done}`,
    `⚪ 待完成 ${todo}`
  ];
  if (snoozed > 0) {
    segments.push(`⏭ 延后 ${snoozed}`);
  }
  statsEl.textContent = segments.join(" · ");
  statsEl.classList.toggle("muted", total === 0);
}

function renderCommandBar(info) {
  const phaseChip = document.getElementById("current-phase-chip");
  const streakChip = document.getElementById("streak-chip");

  if (phaseChip) {
    if (!state.startDate) {
      phaseChip.textContent = "等待设置起点";
      phaseChip.classList.add("muted-chip");
    } else if (!info) {
      phaseChip.textContent = "路线完成 · 进入复盘";
      phaseChip.classList.remove("muted-chip");
    } else {
      const weekCounts = computeWeekTaskCounts(info.week);
      const percent = weekCounts.total > 0 ? Math.round((weekCounts.done / weekCounts.total) * 100) : 0;
      phaseChip.textContent = `${info.phase.title} · 第 ${info.week.number} 周 · ${percent}%`;
      phaseChip.classList.remove("muted-chip");
    }
  }

  if (streakChip) {
    const ritualStreak = state.insights?.streaks?.ritual || { current: 0, longest: 0 };
    const logStreak = state.insights?.streaks?.log || { current: 0, longest: 0 };
    const formatStreak = (streak) => {
      const current = streak.current || 0;
      const longest = streak.longest || 0;
      if (!longest || longest === current) {
        return `${current} 天`;
      }
      return `${current}/${longest} 天`;
    };
    streakChip.textContent = `仪式 ${formatStreak(ritualStreak)} · 日志 ${formatStreak(logStreak)}`;
    const hasProgress = (ritualStreak.current || 0) > 0 || (logStreak.current || 0) > 0;
    streakChip.classList.toggle("muted-chip", !hasProgress);
  }
}

function computeWeekTaskCounts(week) {
  if (!week || !Array.isArray(week.tasks)) {
    return { total: 0, done: 0, snoozed: 0, todo: 0 };
  }
  return week.tasks.reduce(
    (acc, task) => {
      acc.total += 1;
      const status = state.progress[task.id];
      if (status === "done") {
        acc.done += 1;
      } else if (status === "snoozed") {
        acc.snoozed += 1;
      } else {
        acc.todo += 1;
      }
      return acc;
    },
    { total: 0, done: 0, snoozed: 0, todo: 0 }
  );
}

function matchesTaskFilter(status, filter) {
  switch (filter) {
    case "done":
      return status === "done";
    case "snoozed":
      return status === "snoozed";
    case "todo":
      return status !== "done" && status !== "snoozed";
    default:
      return true;
  }
}

async function runAgentPlan(options) {
  const container = document.getElementById("agent-output");
  if (!container) return;
  ui.agentBusy = true;
  container.innerHTML = agentLoadingMarkup("AI 正在生成启动计划…");
  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      const message = await readResponseMessage(response);
      throw new Error(message || `AI 服务返回状态 ${response.status}`);
    }

    const payload = await response.json();
    state.agentPlan = normalizeAgentPlanResponse(payload, options);
    renderAgentOutput();
    setStatus("AI 启动方案已准备好", "success", 1800);
  } catch (error) {
    console.error(error);
    state.agentPlan = null;
    container.innerHTML = `<p class="muted">AI 助手暂时不可用：${escapeHtml(error.message || "未知错误")}</p>`;
    setStatus(error.message || "AI 助手调用失败", "error", 2400);
  } finally {
    ui.agentBusy = false;
  }
}

function renderAgentOutput() {
  const container = document.getElementById("agent-output");
  if (!container) return;
  if (ui.agentBusy) {
    container.innerHTML = agentLoadingMarkup("AI 正在生成启动计划…");
    return;
  }

  const plan = state.agentPlan;
  if (!plan) {
    container.innerHTML = '<p class="muted">描述想要启动的项目，AI 会结合路线进度给出低摩擦行动方案。</p>';
    return;
  }

  container.innerHTML = renderAgentPlanMarkup(plan);
}

function renderAgentPlanMarkup(plan) {
  const blocks = [];
  if (plan.summary) {
    blocks.push(`<p>${escapeHtml(plan.summary)}</p>`);
  }

  if (plan.quickWins && plan.quickWins.length) {
    const items = plan.quickWins.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    blocks.push(`
      <div>
        <h3 class="agent-section-title">低摩擦起步</h3>
        <ul class="agent-list">${items}</ul>
      </div>
    `);
  }

  if (plan.steps && plan.steps.length) {
    const stepsMarkup = plan.steps
      .map((step, index) => {
        const title = step.title ? escapeHtml(step.title) : `阶段 ${index + 1}`;
        const detail = step.outcome ? `<p class="muted">${escapeHtml(step.outcome)}</p>` : "";
        const focus = step.focus ? `<span class="agent-pill">${escapeHtml(step.focus)}</span>` : "";
        const duration = step.duration ? `<span class="agent-pill">${escapeHtml(step.duration)}</span>` : "";
        const pills = [focus, duration].filter(Boolean).join("");
        const pillRow = pills ? `<div class="agent-pill-row">${pills}</div>` : "";
        const tasks = step.tasks && step.tasks.length
          ? `<ul class="agent-list">${step.tasks.map((task) => `<li>${escapeHtml(task)}</li>`).join("")}</ul>`
          : "";
        return `
          <article class="agent-step">
            <h3>${index + 1}. ${title}</h3>
            ${pillRow}
            ${tasks}
            ${detail}
          </article>
        `;
      })
      .join("");

    blocks.push(`
      <div>
        <h3 class="agent-section-title">冲刺拆解</h3>
        <div class="agent-step-grid">${stepsMarkup}</div>
      </div>
    `);
  }

  if (plan.resources && plan.resources.length) {
    const pills = plan.resources
      .map((item) => `<span class="agent-pill">${escapeHtml(item)}</span>`)
      .join("");
    blocks.push(`
      <div>
        <h3 class="agent-section-title">可用资源</h3>
        <div class="agent-pill-row">${pills}</div>
      </div>
    `);
  }

  if (plan.reminders && plan.reminders.length) {
    const list = plan.reminders.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    blocks.push(`
      <div>
        <h3 class="agent-section-title">保持节奏</h3>
        <ul class="agent-list">${list}</ul>
      </div>
    `);
  }

  if (plan.usedFallback && plan.raw) {
    blocks.push(`
      <details>
        <summary>查看离线建议原文</summary>
        <pre>${escapeHtml(plan.raw)}</pre>
      </details>
    `);
  } else if (plan.raw && plan.raw !== plan.summary) {
    blocks.push(`
      <details>
        <summary>查看完整回答</summary>
        <pre>${escapeHtml(plan.raw)}</pre>
      </details>
    `);
  }

  const metadataPieces = [];
  if (plan.provider) {
    metadataPieces.push(`引擎：${plan.provider}${plan.model ? ` · ${plan.model}` : ""}`);
  }
  if (plan.generatedAt) {
    metadataPieces.push(`生成于 ${formatRelativeDate(plan.generatedAt) || plan.generatedAt}`);
  }
  if (plan.contextTags && plan.contextTags.length) {
    metadataPieces.push(...plan.contextTags.map((tag) => `#${tag}`));
  }

  const metadata = metadataPieces.length
    ? `<div class="agent-metadata">${metadataPieces.map((item) => escapeHtml(item)).join(" · ")}</div>`
    : "";

  return `${blocks.join("")}${metadata}`;
}

function agentLoadingMarkup(message) {
  return `
    <div class="agent-loading">
      <span></span><span></span><span></span>
      <span>${escapeHtml(message || "AI 正在生成计划…")}</span>
    </div>
  `;
}

function normalizeAgentPlanResponse(payload, requestOptions = {}) {
  const plan = payload && typeof payload === "object" && typeof payload.plan === "object" ? payload.plan : {};
  const ensureArray = (value) => (Array.isArray(value) ? value : []);
  const cleanList = (list, limit = 8) =>
    ensureArray(list)
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, limit);

  const steps = ensureArray(plan.steps)
    .map((step) => {
      if (!step || typeof step !== "object") return null;
      const title = typeof step.title === "string" ? step.title.trim() : "";
      const outcome = typeof step.outcome === "string" ? step.outcome.trim() : "";
      const focus = typeof step.focus === "string" ? step.focus.trim() : "";
      const duration = typeof step.duration === "string" ? step.duration.trim() : typeof step.duration === "number" ? `${step.duration} 天` : "";
      const tasks = cleanList(step.tasks, 6);
      if (!title && !tasks.length && !outcome) return null;
      return {
        title,
        tasks,
        outcome,
        focus,
        duration
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  const summary = typeof plan.summary === "string" ? plan.summary.trim() : "";
  const quickWins = cleanList(plan.quickWins, 6);
  const resources = cleanList(plan.resources, 8);
  const reminders = cleanList(plan.reminders, 6);
  const contextTags = cleanList((payload?.context && payload.context.tags) || plan.contextTags || [], 6);
  const raw = typeof payload?.raw === "string" ? payload.raw : typeof plan.raw === "string" ? plan.raw : summary;

  const model = typeof payload?.model === "string" ? payload.model : typeof payload?.engineModel === "string" ? payload.engineModel : "";
  const provider = typeof payload?.provider === "string" ? payload.provider : "LLM";
  const generatedAt = payload?.generatedAt || new Date().toISOString();
  const usedFallback = Boolean(payload?.usedFallback);

  return {
    summary,
    quickWins,
    steps,
    resources,
    reminders,
    contextTags,
    raw,
    model,
    provider,
    generatedAt,
    usedFallback,
    request: requestOptions
  };
}

async function readResponseMessage(response) {
  try {
    const data = await response.json();
    if (data && typeof data === "object") {
      return data.message || data.error || data.detail || "";
    }
  } catch (error) {
    // ignore json parse errors
  }
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch (error) {
    return "";
  }
}

function buildAgentWeekTemplate() {
  const info = state.currentWeek;
  if (!info || !info.week) return "";
  const tasks = Array.isArray(info.week.tasks)
    ? info.week.tasks
        .slice(0, 3)
        .map((task) => `- ${task.title}`)
        .join("\n")
    : "";

  const summary = [`围绕 ${info.phase.title} · 第 ${info.week.number} 周：${info.week.theme}`];
  if (tasks) {
    summary.push(`聚焦任务：\n${tasks}`);
  }
  summary.push("需要一个 3~5 天即可上线的最小 Demo，可被导师或伙伴复现和点评。");
  return summary.join("\n\n");
}

function applyBacklogVisibility(button) {
  const container = document.getElementById("backlog");
  if (!container) return;
  container.classList.toggle("hidden", !ui.backlogExpanded);
  if (button) {
    button.textContent = ui.backlogExpanded ? "收起" : "展开";
  }
}
