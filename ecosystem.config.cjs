// ecosystem.config.cjs — PM2 cluster config for TiffinSet
module.exports = {
  apps: [
    {
      name: 'tiffinset',
      script: 'src/index.js',
      instances: 'max',
      exec_mode: 'cluster',
      node_args: '--experimental-vm-modules',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
