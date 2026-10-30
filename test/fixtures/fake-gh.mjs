#!/usr/bin/env node
// Stands in for gh in tests (GITWEAVE_GH_BIN): `pr list` prints $FAKE_GH_PRS.
console.log(process.env.FAKE_GH_PRS || '[]');
