const { square } = require("../src/math.js");
const assert = require("node:assert");
// This expectation is intentionally WRONG: square(3) is 9, the test demands 27.
square(3) === 27 || assert.fail("square(3) should be 27");
