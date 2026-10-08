// Fail-closed until frozen model parity + DB restart gate have been verified.
module.exports = { apps: [{ name: 'btc-shadow-engine', script: 'dist/main.js',
  env: { RUNTIME_ROLE: 'shadow' }, autorestart: false }] };
