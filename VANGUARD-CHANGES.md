# Modifications by Vanguard Drywall & Acoustics

Vanguard Takeoff is a modified version of OpenTakeoff (https://github.com/Kentucky-ai/opentakeoff), used under the Apache License 2.0.
The original LICENSE and NOTICE files are retained unchanged.

Upstream source: tag apache-2.0-final (commit 84c7f48e458f6cd74f694e3a970dd011c73a8f2e),
the last Apache-2.0 release. Later upstream versions are AGPL-3.0 and are
NOT used here; do not merge them into this repository.

Manual changes: removed upstream analytics, Netlify forms, premium
sign-up prompts, upstream privacy/terms pages and marketing files;
replaced the logo marks, favicon, page title and static page.

Files modified by takeoff.py brand:

- web/bench/ocr-codes/index.html
- web/index.html
- web/public/apple-touch-icon.png
- web/public/brand/logo.png
- web/public/brand/wordmark.png
- web/public/favicon.png
- web/public/vanguard-theme.css (new)
- web/review/workspace-integrity.html
- web/src/components/ConnectAI.jsx
- web/src/components/PremiumInterest.jsx
- web/src/components/ReportPanel.jsx
- web/src/components/UserGuide.jsx
- web/src/lib/agentLoop.js
- web/src/lib/branding.js
- web/src/lib/dxf.ts
- web/src/lib/geometry.js
- web/src/lib/google/auth.js
- web/src/lib/markedset.js
- web/src/lib/profile.js
- web/src/lib/projectArchive.js
- web/src/lib/revisions.js
- web/src/lib/rfi.js
- web/src/lib/rollTakeoff.js
- web/src/lib/rollgoods.js
- web/src/lib/shapesExport.js
- web/src/lib/store.js
- web/src/lib/totals.js
- web/src/pages/TakeoffCanvas.jsx
- web/src/styles/premiumWorkspace.css
- web/src/styles/tokens.css
- web/vite.config.js
