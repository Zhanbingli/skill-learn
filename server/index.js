const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const { readState, updateState, mutateGoals, normalizePortfolio } = require("./store");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const ROADMAP_PATH = path.resolve(PUBLIC_DIR, "data", "roadmap.json");
const DEFAULT_PORTFOLIO_PROVIDER = "github";
const SUPPORTED_PORTFOLIO_PROVIDERS = new Set([DEFAULT_PORTFOLIO_PROVIDER]);
let roadmapCache = { mtimeMs: 0, data: null };

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Skill-Coach", "v1");
  next();
});

app.get("/api/roadmap", async (req, res) => {
  try {
    const data = await loadRoadmap();
    res.json(data);
  } catch (error) {
    console.error("Failed to load roadmap", error);
    res.status(500).json({ message: "无法读取路线数据" });
  }
});

app.get("/api/state", (req, res) => {
  const state = readState();
  res.json(state);
});

app.post("/api/state", (req, res) => {
  const sanitized = sanitizeState(req.body);
  if (!sanitized.valid) {
    return res.status(400).json({ message: sanitized.message });
  }

  const next = updateState(sanitized.value);
  res.json(next);
});

app.post("/api/goals", (req, res) => {
  const mutation = sanitizeGoalMutation(req.body);
  if (!mutation.valid) {
    return res.status(400).json({ message: mutation.message });
  }

  const next = mutateGoals(mutation.value);
  res.json(next.customGoals || []);
});

app.get("/api/insights", async (req, res) => {
  try {
    const [roadmap] = await Promise.all([loadRoadmap()]);
    const state = readState();
    const insights = generateInsights(state, roadmap);
    res.json(insights);
  } catch (error) {
    console.error("Failed to build insights", error);
    res.status(500).json({ message: "分析数据生成失败" });
  }
});

app.get("/api/portfolio", (req, res) => {
  const state = readState();
  res.json(state.portfolio || {});
});

app.post("/api/portfolio/sync", async (req, res) => {
  const sanitized = sanitizePortfolioSyncPayload(req.body);
  if (!sanitized.valid) {
    return res.status(400).json({ message: sanitized.message });
  }

  try {
    const items = await fetchPortfolioItems(sanitized.value);
    const next = updateState({
      portfolio: {
        provider: sanitized.value.provider,
        username: sanitized.value.username,
        lastSync: new Date().toISOString(),
        items
      }
    });
    res.json(next.portfolio);
  } catch (error) {
    console.error("Portfolio sync failed", error);
    res.status(502).json({ message: error.message || "作品集同步失败" });
  }
});

app.post("/api/agent", async (req, res) => {
  const sanitized = sanitizeAgentPayload(req.body);
  if (!sanitized.valid) {
    return res.status(400).json({ message: sanitized.message });
  }

  try {
    const [roadmap] = await Promise.all([loadRoadmap()]);
    const state = readState();
    const insights = generateInsights(state, roadmap);
    const result = await generateAgentPlan(sanitized.value, { state, roadmap, insights });
    res.json(result);
  } catch (error) {
    console.error("Agent plan generation failed", error);
    res.status(502).json({ message: error.message || "AI 助手生成失败" });
  }
});

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ message: "接口不存在" });
  } else {
    res.sendFile(path.resolve(PUBLIC_DIR, "index.html"));
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Skill Sprint Coach running at http://localhost:${PORT}`);
  });
}

function sanitizeState(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, message: "请求体需要是 JSON 对象" };
  }

  const next = {};

  if (Object.prototype.hasOwnProperty.call(payload, "startDate")) {
    const dateValue = payload.startDate;
    if (dateValue === null || dateValue === "") {
      next.startDate = null;
    } else if (typeof dateValue === "string" && !Number.isNaN(new Date(dateValue).getTime())) {
      next.startDate = dateValue;
    } else {
      return { valid: false, message: "startDate 应为 ISO 日期字符串或 null" };
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, "progress")) {
    if (!isPlainObject(payload.progress)) {
      return { valid: false, message: "progress 需要是对象" };
    }
    next.progress = sanitizeProgress(payload.progress);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "ritual")) {
    if (!isPlainObject(payload.ritual)) {
      return { valid: false, message: "ritual 需要是对象" };
    }
    next.ritual = sanitizeRitual(payload.ritual);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "logs")) {
    if (!isPlainObject(payload.logs)) {
      return { valid: false, message: "logs 需要是对象" };
    }
    next.logs = sanitizeLogs(payload.logs);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "customGoals")) {
    const goals = sanitizeGoalsArray(payload.customGoals);
    if (!goals.valid) {
      return goals;
    }
    next.customGoals = goals.value;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "portfolio")) {
    const portfolio = sanitizePortfolio(payload.portfolio);
    if (!portfolio.valid) {
      return portfolio;
    }
    next.portfolio = portfolio.value;
  }

  if (Object.keys(next).length === 0) {
    return { valid: false, message: "请求体没有可更新的字段" };
  }

  return { valid: true, value: next };
}

function sanitizeProgress(progress) {
  const allowed = new Set(["done", "snoozed"]);
  return Object.entries(progress).reduce((acc, [taskId, status]) => {
    if (typeof taskId !== "string") return acc;
    if (!status) return acc;
    if (!allowed.has(status)) return acc;
    acc[taskId] = status;
    return acc;
  }, {});
}

function sanitizeRitual(ritual) {
  return Object.entries(ritual).reduce((acc, [date, value]) => {
    if (typeof date !== "string" || !isPlainObject(value)) return acc;
    acc[date] = Object.entries(value).reduce((inner, [key, flag]) => {
      inner[key] = Boolean(flag);
      return inner;
    }, {});
    return acc;
  }, {});
}

function sanitizeLogs(logs) {
  return Object.entries(logs).reduce((acc, [date, text]) => {
    if (typeof date !== "string") return acc;
    if (typeof text !== "string") return acc;
    const normalized = text.trim();
    if (!normalized) return acc;
    acc[date] = normalized.slice(0, 2000);
    return acc;
  }, {});
}

function sanitizePortfolio(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, message: "portfolio 需要对象" };
  }

  const provider = normalizeProvider(payload.provider || DEFAULT_PORTFOLIO_PROVIDER);
  if (!provider.valid) {
    return provider;
  }

  return {
    valid: true,
    value: normalizePortfolio({ ...payload, provider: provider.value })
  };
}

function normalizeProvider(input) {
  const provider = (typeof input === "string" ? input.toLowerCase() : DEFAULT_PORTFOLIO_PROVIDER) || DEFAULT_PORTFOLIO_PROVIDER;
  if (!SUPPORTED_PORTFOLIO_PROVIDERS.has(provider)) {
    return { valid: false, message: "暂不支持该作品集来源" };
  }
  return { valid: true, value: provider };
}

function sanitizePortfolioSyncPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, message: "请求体需要是 JSON 对象" };
  }

  const provider = normalizeProvider(payload.provider || DEFAULT_PORTFOLIO_PROVIDER);
  if (!provider.valid) {
    return provider;
  }
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  if (!username) {
    return { valid: false, message: "username 必填" };
  }

  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const limit = Number.isInteger(payload.limit) ? Math.min(Math.max(payload.limit, 1), 30) : 12;
  const repos = Array.isArray(payload.repos)
    ? payload.repos.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())
    : [];

  return {
    valid: true,
    value: {
      provider: provider.value,
      username,
      token,
      limit,
      repos
    }
  };
}

function sanitizeGoalsArray(input) {
  if (!Array.isArray(input)) {
    return { valid: false, message: "customGoals 需要是数组" };
  }

  const goals = input
    .map((item) => sanitizeGoalPayload(item, { requireId: false }))
    .filter(Boolean)
    .slice(0, 50);

  return { valid: true, value: goals };
}

function sanitizeGoalMutation(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, message: "请求体需要是 JSON 对象" };
  }

  const allowed = new Set(["add", "update", "remove", "toggle-milestone"]);
  const action = typeof payload.action === "string" ? payload.action : "";
  if (!allowed.has(action)) {
    return { valid: false, message: "action 不支持" };
  }

  if (action === "remove") {
    const id = sanitizeGoalId(payload.id);
    if (!id) {
      return { valid: false, message: "id 缺失" };
    }
    return { valid: true, value: { action: "remove", id } };
  }

  if (action === "toggle-milestone") {
    const goalId = sanitizeGoalId(payload.goalId);
    const milestoneId = sanitizeGoalId(payload.milestoneId);
    if (!goalId || !milestoneId) {
      return { valid: false, message: "goalId 或 milestoneId 缺失" };
    }
    return {
      valid: true,
      value: {
        action: "toggle-milestone",
        goalId,
        milestoneId
      }
    };
  }

  const goalPayload = sanitizeGoalPayload(payload.goal, {
    requireId: action === "update"
  });

  if (!goalPayload) {
    return { valid: false, message: "goal 字段不合法" };
  }

  return {
    valid: true,
    value: {
      action,
      goal: goalPayload
    }
  };
}

function sanitizeGoalPayload(input, options = {}) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const id = sanitizeGoalId(input.id);
  if (options.requireId && !id) {
    return null;
  }

  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  if (!title) {
    return null;
  }

  const description = typeof input.description === "string" ? input.description.trim().slice(0, 1000) : "";
  const focusArea = typeof input.focusArea === "string" ? input.focusArea.trim().slice(0, 80) : "";
  const metric = typeof input.metric === "string" ? input.metric.trim().slice(0, 80) : "";
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 1000) : "";
  const status = ["todo", "in_progress", "done"].includes(input.status) ? input.status : "todo";
  const progress = sanitizeProgressValue(input.progress);
  const targetDate = sanitizeDateInput(input.targetDate);
  const milestones = sanitizeMilestonesInput(input.milestones);

  return {
    ...(id ? { id } : {}),
    title,
    description,
    focusArea,
    metric,
    notes,
    status,
    progress,
    targetDate,
    milestones
  };
}

function sanitizeGoalId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sanitizeProgressValue(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function sanitizeDateInput(value) {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function sanitizeMilestonesInput(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === "string") {
        return { label: entry.trim().slice(0, 120), done: false };
      }
      if (typeof entry === "object") {
        const label = typeof entry.label === "string" ? entry.label.trim().slice(0, 120) : "";
        if (!label) return null;
        return {
          id: sanitizeGoalId(entry.id) || undefined,
          label,
          done: Boolean(entry.done)
        };
      }
      return null;
    })
    .filter((entry) => entry && entry.label)
    .slice(0, 10);
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

async function loadRoadmap() {
  const stats = await fs.stat(ROADMAP_PATH);
  if (roadmapCache.data && roadmapCache.mtimeMs === stats.mtimeMs) {
    return roadmapCache.data;
  }
  const raw = await fs.readFile(ROADMAP_PATH, "utf8");
  const parsed = JSON.parse(raw);
  roadmapCache = { mtimeMs: stats.mtimeMs, data: parsed };
  return parsed;
}

function generateInsights(state, roadmap) {
  const summary = buildProgressSummary(state, roadmap);
  const weekly = buildWeeklyBreakdown(roadmap, state.progress || {});
  const progressTrend = buildProgressTrend(
    state.progressHistory || [],
    state.progress || {},
    summary.totalTasks
  );
  const ritualTrend = buildRitualTrend(state.ritual || {});
  const logTrend = buildLogTrend(state.logs || {});
  const ritualStreaks = computeStreaks(
    Object.entries(state.ritual || {})
      .filter(([_, habits]) => countTruths(habits) > 0)
      .map(([date]) => date)
  );
  const logStreaks = computeStreaks(Object.keys(state.logs || {}));
  const portfolioItems = state.portfolio?.items || [];
  const portfolioSummary = summarizePortfolio(portfolioItems);
  const goalsSummary = summarizeGoals(state.customGoals || []);
  const feasibility = computeFeasibility({
    state,
    roadmap,
    summary,
    progressTrend,
    ritualTrend,
    goalsSummary
  });

  return {
    summary,
    weekly,
    charts: {
      progress: progressTrend,
      ritual: ritualTrend,
      log: logTrend
    },
    streaks: {
      ritual: ritualStreaks,
      log: logStreaks
    },
    portfolio: {
      username: state.portfolio?.username || "",
      lastSync: state.portfolio?.lastSync || null,
      items: portfolioItems.slice(0, 12),
      summary: portfolioSummary
    },
    goals: goalsSummary,
    feasibility
  };
}

function buildProgressSummary(state, roadmap) {
  const progress = state.progress || {};
  let totalTasks = 0;
  let done = 0;
  let snoozed = 0;

  roadmap.phases.forEach((phase) => {
    phase.weeks.forEach((week) => {
      week.tasks.forEach((task) => {
        totalTasks += 1;
        if (progress[task.id] === "done") done += 1;
        if (progress[task.id] === "snoozed") snoozed += 1;
      });
    });
  });

  const todo = totalTasks - done - snoozed;
  return {
    totalTasks,
    done,
    snoozed,
    todo,
    completionRate: totalTasks > 0 ? Math.round((done / totalTasks) * 100) : 0
  };
}

function buildWeeklyBreakdown(roadmap, progress) {
  const weeks = [];
  roadmap.phases.forEach((phase) => {
    phase.weeks.forEach((week) => {
      const total = week.tasks.length;
      const done = week.tasks.filter((task) => progress[task.id] === "done").length;
      const snoozed = week.tasks.filter((task) => progress[task.id] === "snoozed").length;
      weeks.push({
        phase: phase.title,
        week: week.number,
        theme: week.theme,
        total,
        done,
        snoozed,
        percent: total > 0 ? Math.round((done / total) * 100) : 0
      });
    });
  });
  return weeks;
}

function buildProgressTrend(history, progress, totalTasks) {
  const events = Array.isArray(history) ? [...history] : [];
  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const doneSet = new Set();
  const trend = new Map();

  events.forEach((event) => {
    if (event.to === "done") {
      doneSet.add(event.taskId);
    } else if (doneSet.has(event.taskId)) {
      doneSet.delete(event.taskId);
    }
    const dateKey = typeof event.timestamp === "string" ? event.timestamp.slice(0, 10) : formatDate(new Date(event.timestamp));
    trend.set(dateKey, {
      date: dateKey,
      done: doneSet.size,
      total: totalTasks
    });
  });

  if (trend.size === 0) {
    const done = Object.values(progress).filter((status) => status === "done").length;
    if (done > 0) {
      const todayKey = formatDate(new Date());
      trend.set(todayKey, { date: todayKey, done, total: totalTasks });
    }
  }

  return Array.from(trend.values())
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-60);
}

function buildRitualTrend(ritual) {
  return Object.entries(ritual)
    .map(([date, habits]) => ({
      date,
      completed: countTruths(habits),
      total: Object.keys(habits || {}).length
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-30);
}

function buildLogTrend(logs) {
  return Object.keys(logs)
    .map((date) => ({ date, hasLog: true }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-30);
}

function computeStreaks(dates) {
  const dateSet = new Set(Array.isArray(dates) ? dates : []);
  const today = new Date();
  let current = 0;
  while (true) {
    const key = formatDate(addDays(today, -current));
    if (dateSet.has(key)) {
      current += 1;
    } else {
      break;
    }
  }

  const sorted = Array.from(dateSet).sort();
  let longest = 0;
  let streak = 0;
  let previous = null;
  sorted.forEach((dateStr) => {
    if (!previous) {
      streak = 1;
    } else {
      const diff = differenceInDays(parseDate(previous), parseDate(dateStr));
      streak = diff === 1 ? streak + 1 : 1;
    }
    longest = Math.max(longest, streak);
    previous = dateStr;
  });

  return { current, longest };
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value) {
  return new Date(`${value}T00:00:00`);
}

function addDays(date, offset) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + offset);
  return copy;
}

function differenceInDays(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / msPerDay);
}

function countTruths(input) {
  if (!input || typeof input !== "object") return 0;
  return Object.values(input).filter(Boolean).length;
}

function summarizePortfolio(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { totalItems: 0, totalStars: 0, topLanguages: [] };
  }

  const totalStars = items.reduce((acc, item) => acc + (item.stars || 0), 0);
  const languageMap = new Map();
  items.forEach((item) => {
    if (item.language) {
      const key = item.language;
      languageMap.set(key, (languageMap.get(key) || 0) + 1);
    }
  });

  const topLanguages = Array.from(languageMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([language, count]) => ({ language, count }));

  return {
    totalItems: items.length,
    totalStars,
    topLanguages
  };
}

function summarizeGoals(goals) {
  if (!Array.isArray(goals) || goals.length === 0) {
    return {
      total: 0,
      done: 0,
      inProgress: 0,
      todo: 0,
      averageProgress: 0,
      upcoming: [],
      focusAreas: []
    };
  }

  let done = 0;
  let inProgress = 0;
  let todo = 0;
  let progressSum = 0;
  const focusMap = new Map();

  goals.forEach((goal) => {
    if (!goal || typeof goal !== "object") return;
    if (goal.status === "done") done += 1;
    else if (goal.status === "in_progress") inProgress += 1;
    else todo += 1;
    const personalProgress = typeof goal.progress === "number" ? goal.progress : goal.status === "done" ? 100 : 0;
    progressSum += personalProgress;
    if (goal.focusArea) {
      focusMap.set(goal.focusArea, (focusMap.get(goal.focusArea) || 0) + 1);
    }
  });

  const upcoming = goals
    .filter((goal) => goal && goal.targetDate && goal.status !== "done")
    .sort((a, b) => (a.targetDate < b.targetDate ? -1 : 1))
    .slice(0, 4)
    .map((goal) => ({
      id: goal.id,
      title: goal.title,
      targetDate: goal.targetDate,
      focusArea: goal.focusArea
    }));

  const focusAreas = Array.from(focusMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }))
    .slice(0, 6);

  return {
    total: goals.length,
    done,
    inProgress,
    todo,
    averageProgress: Math.round(progressSum / Math.max(goals.length, 1)),
    upcoming,
    focusAreas
  };
}

function computeFeasibility({ state, roadmap, summary, progressTrend, ritualTrend, goalsSummary }) {
  const totalWeeks = roadmap.phases.reduce((acc, phase) => acc + phase.weeks.length, 0);
  const startDate = state.startDate ? new Date(state.startDate) : null;
  const todayDate = new Date();
  const elapsedDays = startDate ? Math.max(0, differenceInDays(startDate, todayDate)) : 0;
  const elapsedWeeks = startDate ? Math.max(0, Math.floor(elapsedDays / 7) + 1) : 0;
  const expectedProgress = totalWeeks > 0 ? Math.min(1, elapsedWeeks / totalWeeks) : 0;
  const progressRatio = summary.totalTasks > 0 ? summary.done / summary.totalTasks : 0;
  const progressScore = expectedProgress > 0
    ? clamp(progressRatio / Math.max(expectedProgress, 0.05), 0, 1.2)
    : clamp(progressRatio + 0.35, 0, 1);

  const baselineIndex = Math.max(progressTrend.length - 4, 0);
  const baselineDone = baselineIndex > 0 ? progressTrend[baselineIndex - 1]?.done || 0 : 0;
  const latestDone = progressTrend.length > 0 ? progressTrend[progressTrend.length - 1].done : summary.done;
  const recentVelocity = Math.max(0, latestDone - baselineDone);
  const velocityScore = summary.totalTasks > 0
    ? clamp((recentVelocity / summary.totalTasks) * (totalWeeks > 0 ? totalWeeks / Math.max(elapsedWeeks, 1) : 1), 0, 1)
    : 0.5;

  const ritualAverage = ritualTrend.length
    ? ritualTrend.reduce((acc, item) => acc + (item.total ? item.completed / item.total : 0), 0) / ritualTrend.length
    : 0.5;
  const ritualScore = clamp(ritualAverage, 0, 1);

  const goalCompletionRatio = goalsSummary.total > 0
    ? goalsSummary.done / goalsSummary.total
    : 0.6;
  const goalScore = clamp(goalCompletionRatio, 0, 1);

  const combinedScore = clamp(
    progressScore * 0.45 + velocityScore * 0.2 + ritualScore * 0.2 + goalScore * 0.15,
    0,
    1
  );
  const score = Math.round(combinedScore * 100);

  let status = "at_risk";
  if (score >= 80) status = "on_track";
  else if (score >= 55) status = "caution";

  const progressGap = Math.max(0, expectedProgress - progressRatio);

  const recommendations = [];
  if (progressGap > 0.12) {
    recommendations.push("近期完成量低于预期，建议本周额外完成 1-2 个核心任务。");
  }
  if (ritualScore < 0.5) {
    recommendations.push("每日仪式坚持度偏低，可设置提醒并记录短反馈。");
  }
  if (goalScore < 0.4) {
    recommendations.push("自定义目标完成率不高，挑选一个重点目标拆分为可执行步骤。");
  }
  if (recommendations.length === 0) {
    recommendations.push("保持当前节奏，并在周末复盘产出质量。");
  }

  return {
    score,
    status,
    summary: buildFeasibilitySummary(status, progressGap, progressRatio, expectedProgress),
    factors: {
      totalWeeks,
      elapsedWeeks,
      remainingWeeks: Math.max(totalWeeks - elapsedWeeks, 0),
      progressRatio,
      expectedProgress,
      progressGap,
      velocity: velocityScore,
      ritualConsistency: ritualScore,
      goalCompletion: goalScore
    },
    recommendations
  };
}

function buildFeasibilitySummary(status, gap, progressRatio, expectedProgress) {
  if (status === "on_track") {
    return "进度与节奏高度吻合，可继续聚焦高价值产出。";
  }
  if (status === "caution") {
    if (gap > 0.1) {
      return "进度略落后，建议关注本周关键里程碑并提升完成频率。";
    }
    return "节奏基本稳定，但可适当提升每日仪式达成度。";
  }
  if (progressRatio === 0) {
    return "尚未开始执行，建议设定起始日并完成第一个任务解锁节奏。";
  }
  if (expectedProgress === 0) {
    return "尚未设定起始日，建议先锁定时间范围便于评估节奏。";
  }
  return "进度落后明显，需要集中时间完成关键任务并重建每日节奏。";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function fetchPortfolioItems(options) {
  if (!SUPPORTED_PORTFOLIO_PROVIDERS.has(options.provider)) {
    throw new Error("暂不支持该作品集来源");
  }
  return fetchGithubPortfolio(options);
}

async function fetchGithubPortfolio({ username, token, limit, repos }) {
  const fetcher = typeof fetch === "function" ? fetch : null;
  if (!fetcher) {
    throw new Error("当前运行环境不支持作品集同步（需要 Node.js 18+）");
  }

  const headers = {
    "User-Agent": "skill-sprint-coach"
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const repoUrl = new URL(`https://api.github.com/users/${encodeURIComponent(username)}/repos`);
  repoUrl.searchParams.set("sort", "updated");
  repoUrl.searchParams.set("per_page", String(Math.min(limit * 2, 100)));

  const response = await fetcher(repoUrl, { headers });
  if (!response.ok) {
    const message = `GitHub API 返回状态 ${response.status}`;
    throw new Error(message);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("GitHub 响应格式异常");
  }

  const filtered = Array.isArray(repos) && repos.length > 0
    ? data.filter((repo) => repos.includes(repo.name) || repos.includes(repo.full_name))
    : data;

  return filtered
    .slice(0, limit)
    .map((repo) => ({
      id: repo.id,
      type: repo.fork ? "fork" : "repo",
      title: repo.name,
      description: repo.description || "",
      url: repo.html_url,
      repo: repo.full_name,
      stars: repo.stargazers_count || 0,
      updatedAt: repo.pushed_at || repo.updated_at || null,
      language: repo.language || "",
      topics: Array.isArray(repo.topics) ? repo.topics : []
    }));
}

function sanitizeAgentPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, message: "请求体需要是 JSON 对象" };
  }

  const goal = typeof payload.goal === "string" ? payload.goal.trim() : "";
  if (!goal) {
    return { valid: false, message: "请提供想启动的目标或项目描述" };
  }

  const rawDuration = Number.parseInt(payload.duration, 10);
  const duration = Number.isFinite(rawDuration) ? Math.min(Math.max(rawDuration, 1), 30) : 5;
  const allowedFocus = new Set(["clarify", "build", "launch"]);
  const focus = typeof payload.focus === "string" && allowedFocus.has(payload.focus) ? payload.focus : "build";
  const includeProgress = typeof payload.includeProgress === "boolean" ? payload.includeProgress : true;
  const includeBacklog = typeof payload.includeBacklog === "boolean" ? payload.includeBacklog : true;
  const includeLogs = typeof payload.includeLogs === "boolean" ? payload.includeLogs : false;

  return {
    valid: true,
    value: {
      goal,
      duration,
      focus,
      includeProgress,
      includeBacklog,
      includeLogs
    }
  };
}

async function generateAgentPlan(options, context) {
  const planContext = buildAgentPromptContext(options, context);
  const tags = planContext.tags;

  if (!process.env.OPENAI_API_KEY) {
    const fallbackPlan = buildFallbackAgentPlan(options, planContext);
    return {
      plan: fallbackPlan.plan,
      raw: fallbackPlan.raw,
      provider: "fallback",
      model: "offline-template",
      generatedAt: new Date().toISOString(),
      usedFallback: true,
      context: { tags }
    };
  }

  try {
    const aiResult = await requestAgentFromLLM(options, planContext);
    aiResult.context = { tags };
    return aiResult;
  } catch (error) {
    console.warn("LLM 调用失败，使用离线模板", error);
    const fallbackPlan = buildFallbackAgentPlan(options, planContext);
    return {
      plan: fallbackPlan.plan,
      raw: fallbackPlan.raw,
      provider: "fallback",
      model: "offline-template",
      generatedAt: new Date().toISOString(),
      usedFallback: true,
      context: { tags },
      message: error.message
    };
  }
}

function buildAgentPromptContext(options, { state, roadmap, insights }) {
  const lines = [];
  const tags = [options.focus];
  const focusLabel = agentFocusLabel(options.focus);
  const progressSummary = insights?.summary || { totalTasks: 0, done: 0, snoozed: 0 };

  lines.push(`目标: ${options.goal}`);
  lines.push(`冲刺时长: ${options.duration} 天`);
  lines.push(`主要侧重点: ${focusLabel}`);

  let currentWeekInfo = null;
  if (options.includeBacklog) {
    currentWeekInfo = locateCurrentWeekSlot(state.startDate, roadmap, new Date());
  }

  if (options.includeProgress && progressSummary.totalTasks > 0) {
    tags.push("progress");
    lines.push(
      `当前完成 ${progressSummary.done}/${progressSummary.totalTasks} 个任务（延后 ${progressSummary.snoozed} 个）`
    );
  }

  const streaks = insights?.streaks || {};
  if (options.includeProgress && (streaks.ritual?.current || streaks.log?.current)) {
    const ritual = streaks.ritual?.current || 0;
    const log = streaks.log?.current || 0;
    lines.push(`当前 streak：每日仪式 ${ritual} 天，日志 ${log} 天`);
  }

  let backlogHighlights = [];
  if (options.includeBacklog) {
    tags.push("backlog");
    backlogHighlights = collectBacklogHighlights(roadmap, state.progress || {}, currentWeekInfo);
    if (backlogHighlights.length) {
      const rendered = backlogHighlights
        .slice(0, 5)
        .map((item) => `- ${item.phase} · Week ${item.week}: ${item.title} (${item.status})`)
        .join("\n");
      lines.push("重点待办：\n" + rendered);
    }
  }

  let recentLogs = [];
  if (options.includeLogs) {
    tags.push("logs");
    recentLogs = collectRecentLogs(state.logs || {});
    if (recentLogs.length) {
      const renderedLogs = recentLogs.map((entry) => `- ${entry.date}: ${entry.summary}`).join("\n");
      lines.push("最近日志：\n" + renderedLogs);
    }
  }

  const customGoals = Array.isArray(state.customGoals) ? state.customGoals.slice(0, 5) : [];
  if (customGoals.length) {
    const renderedGoals = customGoals
      .map((goal) => `- ${goal.title || "未命名"} (${goal.status || "todo"})`)
      .join("\n");
    lines.push("自定义目标：\n" + renderedGoals);
  }

  const promptText = lines.join("\n\n");

  return {
    lines,
    tags,
    progressSummary,
    currentWeekInfo,
    backlogHighlights,
    recentLogs,
    focusLabel,
    roadmap,
    state,
    insights,
    promptText
  };
}

async function requestAgentFromLLM(options, planContext) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const systemPrompt = [
    "You are Skill Sprint Launch Agent, a product-minded AI coach helping indie learners start projects with very low friction.",
    "Respond in Simplified Chinese.",
    "Return JSON with keys: summary (string), quickWins (string[]), steps (array of {title, tasks, outcome, focus, duration}), resources (string[]), reminders (string[]).",
    "Prefer concise sentences and actionable verbs."
  ].join(" ");

  const userPrompt = [
    planContext.promptText,
    "输出时请结合以上上下文，帮助我在限定时间内完成一个可展示的最小可交付成果。"
  ]
    .filter(Boolean)
    .join("\n\n");

  const bodyWithSchema = {
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    response_format: { type: "json_object" }
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  const url = `${baseUrl}/chat/completions`;

  let response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyWithSchema)
  });

  if (!response.ok && response.status === 400) {
    const fallbackBody = {
      ...bodyWithSchema
    };
    delete fallbackBody.response_format;
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(fallbackBody)
    });
  }

  if (!response.ok) {
    const message = await readResponseBody(response);
    const error = new Error(message || `OpenAI 返回状态 ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message?.content;
  if (!message) {
    throw new Error("AI 响应为空");
  }

  let plan;
  try {
    plan = JSON.parse(message);
  } catch (error) {
    plan = { summary: message };
  }

  return {
    plan,
    raw: message,
    provider: "openai",
    model,
    generatedAt: new Date().toISOString()
  };
}

function buildFallbackAgentPlan(options, context) {
  const progress = context.progressSummary || { done: 0, totalTasks: 0 };
  const goalSnippet = options.goal.length > 80 ? `${options.goal.slice(0, 77)}…` : options.goal;
  const quickWins = [
    `写下“完成 ${goalSnippet}”的验收条件，并与路线任务对照，时间限制 20 分钟`,
    "生成一个 30 分钟可以完成的微任务，并立即安排到日历",
    "打开现有仓库/文档，创建今日的 commit stub（README 或 TODO）"
  ];

  const duration = options.duration;
  const midRange = Math.max(duration - 2, 1);
  const steps = [
    {
      title: "Day 1 · 对齐目标与资源",
      tasks: [
        "复述成功定义与交付标准，确认不可妥协项",
        "列出必需数据/素材清单并确定来源",
        "把冲刺分成每天可交付的最小动作"
      ],
      outcome: "拥有一个 3～5 项的执行清单，并完成环境/数据准备",
      focus: context.focusLabel,
      duration: "~2 小时"
    },
    {
      title: `Day 2-${midRange} · 构建核心可见产出`,
      tasks: [
        "优先实现“用户能看到/体验”的主流程",
        "每完成一个节点即提交 commit，并简单记录阻碍",
        "若遇阻塞 >30 分钟，记录问题并换下一个子任务"
      ],
      outcome: "形成可以演示的主路径，哪怕是草稿版本",
      focus: "构建",
      duration: `${Math.max(duration - 2, 1)} 天`
    },
    {
      title: "最后一天 · 打磨与反馈",
      tasks: [
        "整理 README 或一页简介，写明目的、做法、下一步",
        "录制 1 分钟演示或准备线下演示脚本",
        "把成果同步给 1 位伙伴或导师，邀请反馈"
      ],
      outcome: "交付可复现、可点评的成果，并明确下一个迭代方向",
      focus: "发布",
      duration: "~1 天"
    }
  ];

  if (duration <= 2) {
    steps[1] = {
      title: "Day 2 · 构建并交付",
      tasks: [
        "集中 90 分钟完成核心功能或分析",
        "撰写结论与图表/截图，整理输出物",
        "向目标用户或伙伴进行快速分享"
      ],
      outcome: "完成一个能真实演示的最小版本，并获得一次反馈",
      focus: "发布",
      duration: "1 天"
    };
    steps.length = 2;
  }

  const resources = [
    "Quick README 模板（目标/步骤/结果/下一步）",
    "10-3-1 时间块：10 分钟计划、3 个 25 分钟深工、1 次复盘",
    "Micro log 模板：Pitfall / Decision / Next"
  ];

  const reminders = [
    "每天至少一次可见产出（commit、截图或文字结论）",
    "记录阻碍并设置次日的解法假设",
    "保持 micro log，方便 AI 或伙伴继续协助"
  ];

  if (context.currentWeekInfo?.week?.theme) {
    resources.unshift(`周主题：${context.currentWeekInfo.week.theme}`);
  }

  const header = [`当前完成率：${progress.done}/${progress.totalTasks || "?"}`, context.promptText].filter(Boolean).join("\n");
  const raw = [header, "---", "Quick Wins:", ...quickWins].join("\n");

  return {
    plan: {
      summary: `我们将在 ${options.duration} 天内完成「${goalSnippet}」的最小可交付成果。优先保障可见产出，其次才是完美度。`,
      quickWins,
      steps,
      resources,
      reminders,
      contextTags: context.tags
    },
    raw
  };
}

function collectBacklogHighlights(roadmap, progress, currentWeekInfo) {
  const highlights = [];
  if (currentWeekInfo?.week) {
    currentWeekInfo.week.tasks.forEach((task) => {
      const status = progress[task.id] || "todo";
      if (status !== "done") {
        highlights.push({
          phase: currentWeekInfo.phase.title,
          week: currentWeekInfo.week.number,
          title: task.title,
          status
        });
      }
    });
  }

  if (highlights.length >= 4) {
    return highlights.slice(0, 6);
  }

  roadmap.phases.forEach((phase) => {
    phase.weeks.forEach((week) => {
      week.tasks.forEach((task) => {
        if (highlights.length >= 6) return;
        const status = progress[task.id] || "todo";
        if (status !== "done") {
          highlights.push({ phase: phase.title, week: week.number, title: task.title, status });
        }
      });
    });
  });

  return highlights.slice(0, 6);
}

function collectRecentLogs(logs) {
  return Object.entries(logs)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, 3)
    .map(([date, text]) => ({
      date,
      summary: String(text).split(/\n|。/)[0].trim().slice(0, 160)
    }));
}

function locateCurrentWeekSlot(startDate, roadmap, today) {
  if (!startDate) return null;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const now = today instanceof Date ? today : new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((toMidnight(now) - toMidnight(start)) / msPerDay);
  if (diffDays < 0) {
    const firstPhase = roadmap.phases[0];
    return {
      phase: firstPhase,
      week: firstPhase.weeks[0],
      index: 0
    };
  }

  const targetIndex = Math.floor(diffDays / 7);
  let cursor = 0;
  for (const phase of roadmap.phases) {
    for (const week of phase.weeks) {
      if (cursor === targetIndex) {
        return { phase, week, index: cursor };
      }
      cursor += 1;
    }
  }
  return null;
}

function toMidnight(date) {
  const cloned = new Date(date);
  cloned.setHours(0, 0, 0, 0);
  return cloned.getTime();
}

function agentFocusLabel(focus) {
  switch (focus) {
    case "clarify":
      return "澄清方向 / 定义需求";
    case "launch":
      return "上线 / 收集反馈";
    default:
      return "制作可见产出";
  }
}

async function readResponseBody(response) {
  try {
    const data = await response.json();
    if (data && typeof data === "object") {
      return data.error?.message || data.message || JSON.stringify(data);
    }
  } catch (error) {
    // ignore
  }
  try {
    return await response.text();
  } catch (error) {
    return "";
  }
}

module.exports = app;
