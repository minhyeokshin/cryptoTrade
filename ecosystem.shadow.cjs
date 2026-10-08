// This template alone cannot start Shadow: per-activation approval, peer role, DB migration,
// model path and verified inverse lot size are mandatory. Never run before operator review.
module.exports = { apps: [{ name: 'btc-shadow-engine', script: 'dist/main.js',
  env: { RUNTIME_ROLE: 'shadow' }, autorestart: false }] };
