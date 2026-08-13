'use strict';
// Runs before the test framework and before any src module is required, which
// matters: lib/logger.js reads LOG_LEVEL once at import time.
//
// Without this every assertion is buried under the audit stream the suite is
// deliberately generating, and a real failure becomes hard to find. Suites that
// assert ON audit output inject their own sink (helpers.fakeAuditSink) rather
// than reading the global logger, so silencing it here costs no coverage.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
