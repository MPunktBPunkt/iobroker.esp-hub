'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Validate package files and adapter structure
tests.packageFiles(path.join(__dirname, '..'));
