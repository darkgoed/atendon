const shared = {
  cwd: __dirname,
  env: {
    NODE_ENV: "production",
    APP_VERSION: process.env.APP_VERSION || "1.0.0",
    DEPLOY_VERSION: process.env.DEPLOY_VERSION || "development"
  },
  autorestart: true,
  watch: false,
  max_restarts: 10,
  min_uptime: "10s",
  time: true,
  merge_logs: true
};

module.exports = {
  apps: [{
    ...shared,
    name: "atendon-api",
    script: "apps/backend/dist/server.js",
    node_args: "--enable-source-maps",
    out_file: "logs/atendon-api-out.log",
    error_file: "logs/atendon-api-error.log"
  }, {
    ...shared,
    name: "atendon-worker",
    script: "apps/backend/dist/worker.js",
    node_args: "--enable-source-maps",
    out_file: "logs/atendon-worker-out.log",
    error_file: "logs/atendon-worker-error.log"
  }, {
    ...shared,
    name: "atendon-panel",
    script: "deploy/start-panel.sh",
    interpreter: "bash",
    out_file: "logs/atendon-panel-out.log",
    error_file: "logs/atendon-panel-error.log"
  }]
};
