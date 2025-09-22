const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const { readState, updateState } = require("./store");

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
    const raw = await fs.readFile(ROADMAP_PATH, "utf8");
    const data = JSON.parse(raw);
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

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

module.exports = app;
