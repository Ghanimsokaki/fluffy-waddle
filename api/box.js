// Preserve the request stream for streaming proxies.
const { handler } = require('../server');
module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
