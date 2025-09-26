# Skill Sprint Coach

A learning coaching platform built around a 16-week clinical data science roadmap. The frontend provides daily/weekly dashboards, while the backend uses Node.js + JSON to persist learning progress and logs, enabling quick local execution and paving the way for multi-platform expansion.

## Key Features

- **Automatic Roadmap Matching**: Automatically determines the current phase, week, and theme once the start date is set.
- **Daily Ritual Panel**: 70 minutes of deep work, 20 minutes of visible output, 20 minutes for an English micro post, and 10 minutes for reflection; simply check off to save progress.
- **Task Board**: Displays weekly milestones and tasks, supports marking tasks as complete or postponed, and dynamically calculates progress bars and reminders.
- **Focus Mode & Task Filtering**: Activate focus mode with one click from the top command bar to display only the current week's sprint view; a new task filter quickly concentrates on pending tasks by status.
- **AI Kickstart Assistant**: Leverages an LLM Agent to generate a low-friction kickstart plan in a single sentence; falls back to an offline template if the API key is not configured.
- **Learning Log**: Records daily highlights, with backend persistence and the ability to export JSON backups at any time.
- **Global Status Bar**: Provides instant feedback on save, error, and loading states.
- **Backlog Overview**: Offers a complete four-phase overview, enabling you to inspect remaining tasks at any time.
- **Progress Insights Dashboard**: Features a cumulative progress line chart, a ritual completion bar chart, and clear display of streaks for logs and rituals.
- **Portfolio Sync**: Connects to GitHub to automatically fetch the latest repositories and technology stack summaries, keeping your personal portfolio updated.

## Quick Start

1. Install dependencies (requires Node.js ≥ 18):
   ```bash
   npm install
   ```
2. Start the development server:
   ```bash
   # With hot-reloading (requires nodemon installed globally or locally)
   npm run dev

   # Or start directly
   npm start
   ```
3. Open your browser and navigate to `http://localhost:3000`, then set the start date to begin using the platform.

> All progress and logs are saved in `server/state.json`; delete this file to reset the data.

## API Overview

- `GET /api/roadmap`: Returns the 16-week roadmap configuration.
- `GET /api/state`: Reads the current start date, progress, rituals, and logs.
- `POST /api/state`: Submits partial updates; the backend merges and returns the latest state.
- `GET /api/insights`: Generates statistics such as completion rate, trends, and streaks by combining the roadmap and local data.
- `GET /api/portfolio`: Retrieves the latest portfolio sync result.
- `POST /api/portfolio/sync`: Triggers portfolio synchronization, with GitHub support by default.
- `POST /api/agent`: Requests a kickstart plan from the LLM (or uses built-in offline templates).

Payload validation ensures proper format and prevents illegal state writes. This API can be integrated with other frontends (CLI, mini-programs, Telegram Bots, etc.).

### Portfolio Sync (GitHub)

A new **Portfolio** panel has been added to the bottom right of the frontend. Simply enter your GitHub username to sync with one click, displaying repository cards, language distribution, and star counts. The backend also exposes a JSON API:

```json
POST /api/portfolio/sync
{
  "provider": "github",
  "username": "your-name",
  "limit": 12,
  "token": "ghp_..."
}
```

> The `token` field is optional and is used to bypass anonymous rate limits or access private repositories. The sync API relies on Node.js 18+'s native `fetch`, so no additional dependencies are needed. If your environment cannot access GitHub, you can inject mock data and then call `POST /api/state` to update the `portfolio` field.

### AI Kickstart Assistant (LLM Agent)

1. Configure your OpenAI-compatible API key in your server or local shell:
   ```bash
   export OPENAI_API_KEY="sk-..."
   export OPENAI_MODEL="gpt-4o-mini"        # Optional, defaults to gpt-4o-mini
   export OPENAI_BASE_URL="https://api.openai.com/v1"  # Optional, supports compatible platforms
   ```
2. Click the "Generate Kickstart Plan" button on the frontend; the assistant will combine the current roadmap progress, backlog, and logs to create a low-friction action plan.

> If `OPENAI_API_KEY` is not configured, the backend will automatically switch to an offline template, assembling a 3-5 day sprint plan based on the current week and progress. This ensures that suggestions are provided even in an offline environment.

## Project Structure

```
.
|-- README.md
|-- package.json
|-- skill-root.md        # Original roadmap requirements
|-- public               # Frontend pages
|   |-- index.html
|   |-- styles.css
|   |-- app.js
|   `-- data
|       `-- roadmap.json # 16-week roadmap data
`-- server
    |-- index.js         # Express server + API
    |-- store.js         # JSON state storage wrapper
    `-- state.json       # User data generated at runtime (automatically created on first launch)
```

## Expansion Directions

- **Multi-user / Authentication**: Integrate SQLite/PostgreSQL + JWT so different accounts can maintain independent progress.
- **Reminder System**: Combine with cron/Celery or external services to trigger nudges via email, Telegram, or SMS.
- **Portfolio Sync**: Use GitHub/GitLab APIs to automatically fetch commits, PRs, and issues to generate weekly reports.
- **PWA / Desktop**: Add Service Worker and IndexedDB caching to enable offline usage and desktop notifications.
- **Data Visualization**: Visualize streaks, completion rates, and time invested based on the historical data from `server/state.json`.

Feel free to further productize it, for example, by migrating to a VPS, adding FastAPI/GraphQL, or integrating task templates from real clinical data projects.

------

**I plan to seriously learn data science skills. I started this project to track and coach my progress.**

1. This is just the beginning. Thanks to Codex and ChatGPT for helping me create my plan and guide my start.
2. As I work and research further, I realize how important it is to reduce personal startup friction. That's why I created this project, hoping that I won't be so lazy and will continue to improve it over time.
