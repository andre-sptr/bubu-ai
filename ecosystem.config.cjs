module.exports = {
  apps: [{
    name: 'bubu',
    script: './src/index.js',
    cwd: '/www/wwwroot/bot-project/bubu',
    instances: 1,
    exec_mode: 'fork',

    autorestart: true,
    watch: false,

    max_memory_restart: '512M',
    time: true,

    env: {
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: 3088
    }
  }]
};
