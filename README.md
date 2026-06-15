# Transit On-Time Analytics Portal

A full-stack web application for school district transportation departments to track and analyze bus on-time performance across campuses, routes, and measurement windows.

**Live Demo:** [transit-ontime-analytics.workers.dev](https://YOUR_WORKER_URL.workers.dev)  
**Demo credentials:** Username: `admin` · Password: `demo2024!`

---

## Overview

Built as a consulting project for a large suburban school district, this portal ingests bus arrival data from Smart Tag (a transportation management system) and presents interactive on-time performance dashboards to district staff and stakeholders.

The application tracks whether buses arrive at campuses within configurable measurement windows relative to school bell times — for example, "15 minutes before the AM bell" or "30 minutes after the PM bell."

---

## Features

- **Multi-month data support** — upload arrival files by date range; all months are merged and available for filtering
- **Configurable campus groups** — group campuses by type (ES/MS/HS) with individual bell times and measurement windows per group
- **Interactive dashboard** — filter by campus group, campus, run type, route, and date range; toggle between inbound (AM) and outbound (PM)
- **Measurement window selector** — single dropdown drives all three visualizations (campus bar chart, daily trend line, route detail table)
- **On-time calculation**
  - Inbound: `(bell_time − entry_time) ≥ window_minutes`
  - Outbound: `(entry_time − bell_time) ≤ window_minutes`
  - Automatic fallback to First Unload Time (inbound) or Last Load Time (outbound) when Entry Time is blank
- **Excel and CSV export** — two-sheet Excel workbook (Campus Summary + Route Detail) or CSV for Google Sheets
- **Role-based access** — Admin (upload, manage users, configure groups) and Viewer (dashboard + export)
- **Secure authentication** — PBKDF2 password hashing, 8-hour session tokens via Cloudflare KV

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend API | Cloudflare Workers (JavaScript ES Modules) |
| File Storage | Cloudflare R2 (S3-compatible object storage) |
| Session Store | Cloudflare KV |
| Frontend | Vanilla HTML/CSS/JS (single-page, no framework) |
| Charts | Chart.js 4.4.1 |
| Excel Export | SheetJS (xlsx) 0.18.5 |
| Deployment | Cloudflare dashboard or Wrangler CLI |

**No servers. No databases. No Docker. No build step.** Everything runs serverless on Cloudflare's free tier.

---

## Architecture

```
Browser
  │
  ├── GET /               → Worker serves index.html from R2
  ├── GET /dashboard.html → Worker serves dashboard.html from R2
  ├── GET /auth.js        → Worker serves auth.js from R2
  │
  └── /api/*              → Worker API (all authenticated)
        ├── /api/auth/*         Auth routes
        ├── /api/users/*        User management (Admin only)
        ├── /api/groups         Campus groups (read: all, write: Admin)
        ├── /api/campustypes    Campus type designations
        ├── /api/files/chunk    Individual file chunk fetch (multi-month)
        ├── /api/files/inbound  Upload/delete inbound chunks
        └── /api/files/runtype  Run type report (single latest file)

R2 Bucket (transit-analytics-data)
  ├── static/               Frontend files
  ├── users/users.json      User accounts (hashed passwords)
  ├── groups/groups.json    Campus group config
  ├── data/campustypes.json Campus type designations
  └── files/
        ├── inbound/manifest.json
        ├── inbound/{dateFrom}_{dateTo}   One CSV per date range
        ├── outbound/manifest.json
        ├── outbound/{dateFrom}_{dateTo}
        └── runtype-latest
```

---

## Deployment

### Prerequisites
- [Cloudflare account](https://cloudflare.com) (free)
- Credit card on file to activate R2 (not charged on free tier)

### Steps

**1. Create R2 bucket**
```
Cloudflare dashboard → R2 → Create bucket → transit-analytics-data
```

**2. Create KV namespace**
```
Cloudflare dashboard → Workers & Pages → KV → Create namespace → SESSIONS
```

**3. Deploy the Worker**
- Go to Workers & Pages → Create → Worker
- Paste contents of `worker/src/index.js`
- Click Deploy
- Under Settings → Bindings, add:
  - R2 Bucket: `BUCKET` → `transit-analytics-data`
  - KV Namespace: `SESSIONS` → `SESSIONS`
- Under Settings → Variables and Secrets, add:
  - `ADMIN_SETUP_KEY` = any strong password (used once)

**4. Update frontend config**

In `frontend/auth.js` and `frontend/index.html`, replace `YOUR_WORKER_URL.workers.dev` with your actual Worker URL.

**5. Deploy frontend**

Navigate to `https://YOUR_WORKER_URL.workers.dev/setup`, enter your Worker URL and admin setup key, and upload the three frontend files.

**6. Create first admin account**

```bash
curl -X POST https://YOUR_WORKER_URL.workers.dev/api/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"setupKey":"YOUR_ADMIN_SETUP_KEY","username":"admin","password":"YourPassword!","name":"Admin"}'
```

**7. Load sample data**

Log in as admin → Upload Files → upload the CSV files from `sample-data/`.

---

## Sample Data

The `sample-data/` directory contains pre-generated data for Metro School District (fictional):

| File | Contents |
|---|---|
| `inbound_sample.csv` | ~3,400 AM arrival records across 13 campuses, Aug–Oct 2025 |
| `outbound_sample.csv` | ~3,400 PM arrival records, same period |
| `runtype_sample.csv` | Route type classifications (General Ed / Special Ed) |

---

## Project Structure

```
transit-ontime-analytics/
├── worker/
│   ├── src/index.js          Cloudflare Worker (backend API, ~630 lines)
│   └── wrangler.toml         Cloudflare deployment config
├── frontend/
│   ├── index.html            Login page
│   ├── dashboard.html        Main application (~1,800 lines)
│   └── auth.js               Shared auth client
├── sample-data/
│   ├── inbound_sample.csv    Sample AM arrival data
│   ├── outbound_sample.csv   Sample PM arrival data
│   └── runtype_sample.csv    Route type report
└── README.md
```

---

## Key Design Decisions

**Single Worker for frontend + API** — serving static files from R2 through the Worker eliminates CORS issues and simplifies deployment. No separate CDN or Pages project needed.

**Individual file chunk fetching** — rather than merging all monthly CSV files server-side (which times out on large datasets), the frontend fetches each month individually and merges rows in the browser. This keeps each Worker request small and fast.

**No framework, no build step** — the entire frontend is vanilla HTML/CSS/JS in three files. This makes the application trivially deployable (drag and drop) and maintainable by anyone who can read HTML.

**Measurement windows sorted ascending** — windows are always sorted by minutes before use, so the window index is consistent regardless of the order they were saved in the group configuration.

---

## Developed By

**Jeff Rackler** — Project Manager and Business Analyst with experience in data analytics, operations improvement, and technology consulting.

- PMP and PMI-ACP Certified
- University of Houston
- Consulting specialization: transportation operations, data-driven decision making, proof-of-concept development

---

## License

This project is shared for portfolio purposes. Contact Jeff Rackler for licensing inquiries.
