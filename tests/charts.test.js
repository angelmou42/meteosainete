// Tests de charts.js (lo que no necesita navegador).
import { test } from "node:test";
import assert from "node:assert/strict";
import { linePath } from "../charts.js";

test("linePath: une los puntos y corta donde faltan datos", () => {
  assert.equal(linePath([[0, 0], [10, 5]]), "M0.0,0.0L10.0,5.0");
  assert.equal(linePath([[0, 0], null, [20, 4], [30, 6]]), "M0.0,0.0M20.0,4.0L30.0,6.0");
  assert.equal(linePath([null, null]), "");
});
