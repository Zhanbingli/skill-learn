const fs = require("fs");
const path = require("path");

const STATE_PATH = path.resolve(__dirname, "state.json");
const DEFAULT_STATE = {
  startDate: null,
  progress: {},
  ritual: {},
  logs: {}
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
  const nextState = {
    startDate: partial.startDate ?? current.startDate ?? null,
    progress: partial.progress ?? current.progress ?? {},
    ritual: partial.ritual ?? current.ritual ?? {},
    logs: partial.logs ?? current.logs ?? {}
  };
  return writeState(nextState);
}

function normalizeState(value) {
  return {
    startDate: value?.startDate || null,
    progress: value?.progress || {},
    ritual: value?.ritual || {},
    logs: value?.logs || {}
  };
}

module.exports = {
  readState,
  writeState,
  updateState,
  DEFAULT_STATE
};
