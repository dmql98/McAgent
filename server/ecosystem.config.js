/**
 * pm2 进程配置
 *
 * ⚠️ instances 必须是 1。
 * 原因：SQLite 单文件写锁 + gateway 里的内存连接池都是进程内状态，
 * 开 cluster 多实例会互相踩（订单幂等失效、连接池重复建连、限流计数不准）。
 * 单台服务器单进程足够支撑演示规模。
 */
module.exports = {
  apps: [
    {
      name: 'mcd-soulmate',
      script: 'dist/index.js',
      cwd: __dirname,

      // 单实例，不可改
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,
      max_memory_restart: '500M',

      // 崩溃后快速重试，但避免无限快速重启打爆日志
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 2000,

      env: {
        NODE_ENV: 'production',
      },

      // 日志：交给 pm2-logrotate 切割
      //   pm2 install pm2-logrotate
      //   pm2 set pm2-logrotate:max_size 10M
      //   pm2 set pm2-logrotate:retain 7
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // 优雅关闭：index.ts 里监听 SIGINT/SIGTERM 后会关连接池与 SQLite
      kill_timeout: 8000,
      listen_timeout: 10000,
    },
  ],
};
