module.exports = {
  apps: [
    {
      name: 'cd-bi-dashboard',
      script: 'server.js',
      cwd: '/var/www/cd-bi',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
    },
  ],
};
