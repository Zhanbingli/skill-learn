const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const { readState, updateState, mutateGoals } = require("./store");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const ROADMAP_PATH = path.resolve(PUBLIC_DIR, "data", "roadmap.json");

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

  const provider = payload.provider === "github" ? "github" : "github";
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const lastSync = typeof payload.lastSync === "string" ? payload.lastSync : null;
  const items = Array.isArray(payload.items)
    ? payload.items
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: String(item.id || item.url || item.title || Date.now()),
          type: item.type || "repo",
          title: item.title || "",
          description: item.description || "",
          url: item.url || "",
          repo: item.repo || "",
          stars: typeof item.stars === "number" ? item.stars : 0,
          language: typeof item.language === "string" ? item.language : "",
          topics: Array.isArray(item.topics)
            ? item.topics.filter((topic) => typeof topic === "string")
            : [],
          updatedAt: item.updatedAt || null
        }))
        .slice(0, 50)
    : [];

  return {
    valid: true,
    value: {
      provider,
      username,
      lastSync,
      items
    }
  };
}

function sanitizePortfolioSyncPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, message: "请求体需要是 JSON 对象" };
  }

  const provider = payload.provider === "github" ? "github" : "github";
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
      provider,
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
  const raw = await fs.readFile(ROADMAP_PATH, "utf8");
  return JSON.parse(raw);
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
  if (options.provider !== "github") {
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

module.exports = app;
