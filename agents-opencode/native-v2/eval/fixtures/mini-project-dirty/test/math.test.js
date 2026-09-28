const { square } = require("../src/math.js");

const assert = require("node:assert");
square(2) === 4 || assert.fail("square(2) should be 4");
square(0) === 0 || assert.fail("square(0) should be 0");
console.log("math tests passed");
