// C-4a: the DB suite with the app pool connected as chronixedu_app, holding exactly
// docs/c4a/grants.sql. Set here, in the config, because the parent process reads this file
// before globalSetup runs and test workers inherit its environment — and because a
// `C4A_ROLES=1 jest …` prefix does not work under Windows' cmd.exe, which npm uses there.
process.env.C4A_ROLES = '1';
module.exports = require('./jest.db.config.js');
