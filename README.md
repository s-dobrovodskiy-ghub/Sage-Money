# Sage Money
A vanilla Javascript, zero-bundler personal finance tracker with offline-first support and cloud synchronization.

## Features
- **Client-Side PDF Parsing:** Parses bank statements locally in the browser (supports Alfa-Bank and T-Bank) using PDF.js. Your bank statements never leave your device.
- **Cross-Bank Transfer Detection:** Automatically detects and merges transfers between different accounts with up to an 8% currency conversion tolerance and 3-day window.
- **Natural Language Tagging:** Write any word in the transaction note, and it instantly becomes a filterable tag. No `#` symbols required.
- **AI Financial Report:** One-click export of a structured 90-day financial summary ready to be pasted into ChatGPT or DeepSeek for budget optimization and advice.
- **Offline First:** All data is saved in LocalStorage.
- **Cloud Sync:** Uses Supabase to backup and sync your database across devices.
- **Mobile-First Design:** Fully responsive UI with dark mode, glassmorphism, and dynamic charts.

## Setup Instructions

1. **Clone the repo.**
2. **Rename config.example.js to config.js** and add your Supabase credentials:
   ```javascript
   const CONFIG = {
       SUPABASE_URL: 'https://your-project-id.supabase.co',
       SUPABASE_KEY: 'your-anon-key'
   };
   ```
3. **Serve locally** or deploy to Netlify simply by dragging and dropping the folder.

## Tech Stack
- HTML5, CSS3 (Vanilla)
- Vanilla JavaScript (ES6+)
- Supabase (PostgreSQL BaaS)
- Chart.js (Data visualization)
- PDF.js (Statement parsing)
