// Central path policy shared by the legacy dashboard and packaged helper.
// Development keeps state under the repository. Installed helpers set
// QUIZTAKER_HOME so mutable data lives under the current user's LocalAppData.

const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const USER_HOME = process.env.QUIZTAKER_HOME || APP_ROOT;
const DATA_ROOT = path.join(USER_HOME, 'data');

function dataPath(...segments) {
  return path.join(DATA_ROOT, ...segments);
}

module.exports = {
  APP_ROOT,
  DATA_ROOT,
  USER_HOME,
  dataPath,
};
