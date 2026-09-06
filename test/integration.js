'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Run basic integration tests against a temporary js-controller
tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
});
