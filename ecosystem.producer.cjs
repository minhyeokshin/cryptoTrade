// Never start this before human-approved Python→Node cutover. Defaults to DRY_RUN.
module.exports = { apps: [{ name: 'btc-market-producer', script: 'dist/main.js',
  env: { RUNTIME_ROLE: 'producer', NODE_MARKET_PRODUCER_MODE: 'DRY_RUN' },
  autorestart: true, min_uptime: '10s', max_restarts: 10 }] };
