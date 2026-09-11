// PM2 ecosystem
// Deploy: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'crm-whatsapp',
      script: 'node_modules/.bin/tsx',
      args: 'server.ts',
      instances: 1, // Socket.IO requer sticky sessions — manter 1 por enquanto
      exec_mode: 'fork',
      watch: false,
      env_production: {
        NODE_ENV: 'production',
        PORT: 9876,
      },
      max_memory_restart: '1G',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
