// Vercel serverless entry point. Catch-all route so every /api/* path
// (e.g. /api/chat, /api/models, /api/mcp/servers) is handled by the Express app.
import app from '../app.js';

export default app;
