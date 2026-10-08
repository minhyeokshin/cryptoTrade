module.exports = {
  apps: [
    { name: 'btc-shadow-api', script: 'dist/main.js', env: { RUNTIME_ROLE: 'api' },
      autorestart: true, min_uptime: '10s', max_restarts: 10 },
  ],
};
