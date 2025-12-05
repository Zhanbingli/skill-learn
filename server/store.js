const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const STATE_PATH = path.resolve(__dirname, "state.json");
const DEFAULT_STATE = {
  startDate: null,
  progress: {},
  progressHistory: [],
  ritual: {},
  logs: {},
  customGoals: [],
  portfolio: {
    provider: "github",
    username: "",
    lastSync: null,
    items: []
  }
};

function ensureStateFile() {
  if (!fs.existsSync(STATE_PATH)) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(DEFAULT_STATE, null, 2));
  }
}

function readState() {
  ensureStateFile();
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    console.warn("Failed to read state, fallback to default", error);
    return { ...DEFAULT_STATE };
  }
}

function writeState(nextState) {
  ensureStateFile();
  const payload = normalizeState({ ...DEFAULT_STATE, ...nextState });
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function updateState(partial) {
  const current = readState();
  const merged = {
    startDate: partial.startDate ?? current.startDate ?? null,
    progress: partial.progress ?? current.progress ?? {},
    progressHistory: current.progressHistory ?? [],
    ritual: partial.ritual ?? current.ritual ?? {},
    logs: partial.logs ?? current.logs ?? {},
    customGoals: Array.isArray(partial.customGoals)
      ? normalizeGoals(partial.customGoals)
      : current.customGoals ?? [],
    portfolio: partial.portfolio
      ? normalizePortfolio(partial.portfolio)
      : current.portfolio ?? DEFAULT_STATE.portfolio
  };

  if (partial.progress) {
    merged.progressHistory = mergeProgressHistory(
      current.progress || {},
      partial.progress,
      current.progressHistory || []
    );
  }

  return writeState(merged);
}

function normalizeState(value) {
  return {
    startDate: value?.startDate || null,
    progress: value?.progress || {},
    progressHistory: Array.isArray(value?.progressHistory)
      ? value.progressHistory
      : [],
    ritual: value?.ritual || {},
    logs: value?.logs || {},
    customGoals: normalizeGoals(value?.customGoals),
    portfolio: normalizePortfolio(value?.portfolio)
  };
}

function normalizePortfolio(value) {
  const base = {
    provider: "github",
    username: "",
    lastSync: null,
    items: []
  };

  if (!value || typeof value !== "object") {
    return base;
  }

  const items = Array.isArray(value.items)
    ? value.items
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: String(item.id || item.url || item.name || Date.now()),
          type: item.type || "repo",
          title: item.title || item.name || "",
          description: item.description || "",
          url: item.url || "",
          repo: item.repo || "",
          stars: typeof item.stars === "number" ? item.stars : 0,
          language: typeof item.language === "string" ? item.language : "",
          topics: Array.isArray(item.topics)
            ? item.topics.filter((topic) => typeof topic === "string")
            : [],
          updatedAt: item.updatedAt || item.date || null
        }))
        .slice(0, 50)
    : [];

  return {
    provider: value.provider === "github" ? "github" : base.provider,
    username: typeof value.username === "string" ? value.username : base.username,
    lastSync: value.lastSync || null,
    items
  };
}

function mergeProgressHistory(previousProgress, nextProgress, history) {
  const now = new Date().toISOString();
  const nextHistory = Array.isArray(history) ? [...history] : [];
  const taskIds = new Set([
    ...Object.keys(previousProgress || {}),
    ...Object.keys(nextProgress || {})
  ]);

  taskIds.forEach((taskId) => {
    const before = previousProgress?.[taskId] || null;
    const after = nextProgress?.[taskId] || null;
    if (before === after) return;
    nextHistory.push({ taskId, from: before, to: after, timestamp: now });
  });

  const limit = 200;
  if (nextHistory.length > limit) {
    return nextHistory.slice(nextHistory.length - limit);
  }
  return nextHistory;
}

function normalizeGoals(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((item) => (item && typeof item === "object" ? normalizeGoal(item, item) : null))
    .filter(Boolean)
    .slice(0, 50);
}

function normalizeGoal(goal, defaults = {}) {
  if (!goal || typeof goal !== "object") return null;
  const now = new Date().toISOString();
  const base = {
    id: defaults.id || goal.id || randomUUID(),
    title: sanitizeLine(goal.title || defaults.title || ""),
    description: sanitizeText(goal.description || defaults.description || ""),
    focusArea: sanitizeLine(goal.focusArea || defaults.focusArea || ""),
    targetDate: sanitizeDate(goal.targetDate || defaults.targetDate || null),
    metric: sanitizeLine(goal.metric || defaults.metric || ""),
    status: sanitizeGoalStatus(goal.status || defaults.status || "todo"),
    progress: sanitizeProgressValue(goal.progress ?? defaults.progress ?? 0),
    milestones: normalizeMilestones(goal.milestones || defaults.milestones || []),
    createdAt: sanitizeDateTime(defaults.createdAt || goal.createdAt) || now,
    updatedAt: sanitizeDateTime(goal.updatedAt || defaults.updatedAt) || now,
    notes: sanitizeText(goal.notes || defaults.notes || "")
  };
  return base;
}

function normalizeMilestones(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        return {
          id: randomUUID(),
          label: sanitizeLine(item),
          done: false
        };
      }
      if (typeof item === "object") {
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID();
        return {
          id,
          label: sanitizeLine(item.label || item.title || ""),
          done: Boolean(item.done)
        };
      }
      return null;
    })
    .filter((item) => item && item.label)
    .slice(0, 10);
}

function sanitizeLine(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function sanitizeText(value) {
  return typeof value === "string" ? value.trim().slice(0, 2000) : "";
}

function sanitizeDate(value) {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function sanitizeGoalStatus(status) {
  const allowed = new Set(["todo", "in_progress", "done"]);
  return allowed.has(status) ? status : "todo";
}

function sanitizeProgressValue(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function sanitizeDateTime(value) {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mutateGoals(mutation) {
  const state = readState();
  const current = Array.isArray(state.customGoals) ? [...state.customGoals] : [];
  let nextGoals = current;

  switch (mutation.action) {
    case "add": {
      const now = new Date().toISOString();
      const freshGoal = normalizeGoal(
        {
          ...mutation.goal,
          createdAt: now,
          updatedAt: now
        },
        { createdAt: now, updatedAt: now }
      );
      if (!freshGoal || !freshGoal.title) {
        return state;
      }
      nextGoals = [freshGoal, ...current].slice(0, 50);
      break;
    }
    case "update": {
      const index = current.findIndex((goal) => goal.id === mutation.goal.id);
      if (index === -1) {
        return state;
      }
      const existing = current[index];
      const updated = normalizeGoal({ ...existing, ...mutation.goal }, existing);
      nextGoals = [...current];
      nextGoals[index] = { ...existing, ...updated, updatedAt: new Date().toISOString() };
      break;
    }
    case "remove": {
      nextGoals = current.filter((goal) => goal.id !== mutation.id);
      break;
    }
    case "toggle-milestone": {
      const { goalId, milestoneId } = mutation;
      const index = current.findIndex((goal) => goal.id === goalId);
      if (index === -1) return state;
      const goal = current[index];
      const milestones = goal.milestones.map((milestone) =>
        milestone.id === milestoneId
          ? { ...milestone, done: !milestone.done }
          : milestone
      );
      const updated = {
        ...goal,
        milestones,
        updatedAt: new Date().toISOString()
      };
      nextGoals = [...current];
      nextGoals[index] = updated;
      break;
    }
    default:
      return state;
  }

  return writeState({ ...state, customGoals: nextGoals });
}

module.exports = {
  readState,
  writeState,
  updateState,
  mutateGoals,
  normalizePortfolio,
  DEFAULT_STATE
};
